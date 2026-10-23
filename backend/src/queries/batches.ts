import { day, num, text, type SapSql } from '../sap/db'

/**
 * Batch lookups over erp.batches / erp.batch_movements (sql/erp/14_batches.sql; with ERPNext, the SAP Batch
 * records). A code read off a packet photo is often a character or two off (inkjet on foil: 0/O, 1/I, 8/B ...),
 * so matching is by an edit distance where those look-alike swaps cost little, never by exact text alone.
 */

/**
 * Character pairs a camera (or a person) mixes up on printed batch codes; swapping one for the other costs
 * CONFUSABLE_COST. Letter pairs that are both month codes (I and L) are deliberately not here.
 */
const CONFUSABLE_PAIRS = ['0O', '0D', '0Q', 'OD', 'OQ', '1I', '1L', '17', '7T', '2Z', '5S', '6G', '8B', 'UV', 'MN']
const CONFUSABLE_COST = 0.25

const confusable = new Map<string, Set<string>>()
for (const [x, y] of CONFUSABLE_PAIRS) {
  confusable.set(x, (confusable.get(x) ?? new Set<string>()).add(y))
  confusable.set(y, (confusable.get(y) ?? new Set<string>()).add(x))
}

/** Upper case, letters and digits only: separators (- / . space) are printed inconsistently. */
export function normalizeBatchCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function swapCost(a: string, b: string): number {
  if (a === b) return 0
  return confusable.get(a)?.has(b) ? CONFUSABLE_COST : 1
}

/** Weighted Levenshtein over normalized codes: insert/delete 1, a look-alike swap 0.25, any other swap 1. */
export function batchCodeDistance(read: string, candidate: string): number {
  const a = normalizeBatchCode(read)
  const b = normalizeBatchCode(candidate)
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + swapCost(a[i - 1], b[j - 1])))
    }
    previous = current
  }
  return previous[b.length]
}

export type BatchMatchKind = 'exact' | 'close' | 'possible'

/** How sure a match is: exact after normalizing; close within one edit (or look-alikes only); possible within two. */
export function matchKind(distance: number, length: number): BatchMatchKind | null {
  if (distance === 0) return 'exact'
  if (distance <= 1.25 && distance <= length * 0.2) return 'close'
  if (distance <= 2.5 && length >= 6) return 'possible'
  return null
}

export type BatchCandidate = {
  batchId: number
  batchNo: string
  itemCode: string
  itemName: string | null
  inDate: string | null
  onHand: number
}

export type BatchMatch = BatchCandidate & { distance: number; match: BatchMatchKind }

const words = (value: string) => value.toLowerCase().match(/[a-z]+|\d+/g) ?? []

/** Share of the product words (brand, variant, "65g") found in the item's code or name. */
function productOverlap(product: string | null | undefined, candidate: BatchCandidate): number {
  const wanted = words(product ?? '').filter((w) => w.length > 1 && !['g', 'gm', 'gms', 'chips'].includes(w))
  if (!wanted.length) return 0
  const have = new Set(words(`${candidate.itemCode} ${candidate.itemName ?? ''}`.replace(/(\d+)\s*g\b/gi, '$1')))
  return wanted.filter((w) => have.has(w.replace(/g$/, '')) || have.has(w)).length / wanted.length
}

/** Ranks every batch against a code as read: closest first, then the one whose item matches the product words. */
export function rankBatches(read: string, candidates: readonly BatchCandidate[], product?: string | null, limit = 5): BatchMatch[] {
  const length = normalizeBatchCode(read).length
  if (length < 3) return []
  return candidates
    .map((candidate) => {
      const distance = batchCodeDistance(read, candidate.batchNo)
      return { candidate, distance, match: matchKind(distance, length), overlap: productOverlap(product, candidate) }
    })
    .filter((row): row is typeof row & { match: BatchMatchKind } => row.match !== null)
    .sort((a, b) => a.distance - b.distance || b.overlap - a.overlap || (b.candidate.inDate ?? '').localeCompare(a.candidate.inDate ?? ''))
    .slice(0, limit)
    .map((row) => ({ ...row.candidate, distance: row.distance, match: row.match }))
}

export async function batchCandidates(sql: SapSql, itemCodes: readonly string[] = []): Promise<BatchCandidate[]> {
  const rows = await sql`
    select batch_id, batch_no, item_code, item_name, in_date, on_hand
    from erp.batches
    ${itemCodes.length ? sql`where item_code in ${sql(itemCodes as string[])}` : sql``}`
  return rows.map((row) => ({
    batchId: num(row.batch_id),
    batchNo: String(row.batch_no),
    itemCode: String(row.item_code),
    itemName: text(row.item_name),
    inDate: day(row.in_date),
    onHand: num(row.on_hand),
  }))
}

export type BatchDetail = {
  batchId: number
  batchNo: string
  itemCode: string
  itemName: string | null
  /** The day the batch came into stock (its production receipt for a finished good). */
  inDate: string | null
  mnfDate: string | null
  expDate: string | null
  qtyIn: number
  qtyOut: number
  onHand: number
  warehouses: string | null
  /** Production receipts that made it. */
  made: Array<{ productionOrder: string | null; receipt: string; date: string | null; qty: number; whsCode: string | null }>
  /** Invoiced quantities by customer, net of credit notes. */
  customers: Array<{ name: string | null; cardCode: string | null; qty: number; invoices: string[]; firstDate: string | null; lastDate: string | null }>
  /** Material batches issued to the production orders that made it (raw banana, oil, seasoning ...). */
  components: Array<{ itemCode: string; itemName: string | null; batchNo: string; qty: number; suppliers: string[] }>
  /** Batches of other items made from this one (when this batch is a material). */
  usedIn: Array<{ itemCode: string; itemName: string | null; batchNo: string; productionOrder: string | null }>
  /** GRNs it came in on (a purchased material). */
  receivedFrom: Array<{ supplier: string | null; grn: string; date: string | null; qty: number }>
  otherMovements: number
}

const round = (value: number) => Math.round(value * 1000) / 1000

export async function batchDetail(sql: SapSql, batchId: number): Promise<BatchDetail | null> {
  const [batch] = await sql`select * from erp.batches where batch_id = ${batchId}`
  if (!batch) return null
  const moves = await sql`select * from erp.batch_movements where batch_id = ${batchId} order by doc_date, log_entry`
  const made = moves.filter((m) => m.kind === 'production_receipt')
  const madeBy = [...new Set(made.map((m) => m.production_entry).filter((v) => v != null).map(num))]
  const issuedTo = [...new Set(moves.filter((m) => m.kind === 'production_issue').map((m) => m.production_entry).filter((v) => v != null).map(num))]

  const components = madeBy.length
    ? await sql`
        select m.item_code, b.item_name, m.batch_no, -sum(m.qty) as qty,
               (select array_agg(distinct g.party_name) from erp.batch_movements g
                where g.batch_id = m.batch_id and g.kind = 'grn' and g.party_name is not null) as suppliers
        from erp.batch_movements m join erp.batches b on b.batch_id = m.batch_id
        where m.kind = 'production_issue' and m.production_entry in ${sql(madeBy)} and m.batch_id <> ${batchId}
        group by m.batch_id, m.item_code, b.item_name, m.batch_no
        order by qty desc limit 15`
    : []
  const usedIn = issuedTo.length
    ? await sql`
        select distinct m.item_code, b.item_name, m.batch_no, m.production_order
        from erp.batch_movements m join erp.batches b on b.batch_id = m.batch_id
        where m.kind = 'production_receipt' and m.production_entry in ${sql(issuedTo)} and m.batch_id <> ${batchId}
        order by m.batch_no limit 15`
    : []

  const byCustomer = new Map<string, BatchDetail['customers'][number]>()
  for (const m of moves.filter((row) => row.kind === 'invoice' || row.kind === 'credit_note')) {
    const key = text(m.party_code) ?? text(m.party_name) ?? '?'
    const row = byCustomer.get(key) ?? { name: text(m.party_name), cardCode: text(m.party_code), qty: 0, invoices: [], firstDate: null, lastDate: null }
    row.qty = round(row.qty - num(m.qty))
    if (m.kind === 'invoice') {
      const date = day(m.doc_date)
      if (!row.invoices.includes(String(m.doc_no))) row.invoices.push(String(m.doc_no))
      if (date && (!row.firstDate || date < row.firstDate)) row.firstDate = date
      if (date && (!row.lastDate || date > row.lastDate)) row.lastDate = date
    }
    byCustomer.set(key, row)
  }
  const known = new Set(['production_receipt', 'production_issue', 'invoice', 'credit_note', 'grn'])

  return {
    batchId,
    batchNo: String(batch.batch_no),
    itemCode: String(batch.item_code),
    itemName: text(batch.item_name),
    inDate: day(batch.in_date),
    mnfDate: day(batch.mnf_date),
    expDate: day(batch.exp_date),
    qtyIn: round(num(batch.qty_in)),
    qtyOut: round(num(batch.qty_out)),
    onHand: round(num(batch.on_hand)),
    warehouses: text(batch.warehouses),
    made: made.map((m) => ({
      productionOrder: text(m.production_order),
      receipt: String(m.doc_no),
      date: day(m.doc_date),
      qty: round(num(m.qty)),
      whsCode: text(m.whs_code),
    })),
    customers: [...byCustomer.values()]
      .sort((a, b) => b.qty - a.qty)
      .map((row) => ({ ...row, invoices: row.invoices.slice(0, 10) })),
    components: components.map((row) => ({
      itemCode: String(row.item_code),
      itemName: text(row.item_name),
      batchNo: String(row.batch_no),
      qty: round(num(row.qty)),
      suppliers: ((row.suppliers as string[] | null) ?? []).slice(0, 5),
    })),
    usedIn: usedIn.map((row) => ({
      itemCode: String(row.item_code),
      itemName: text(row.item_name),
      batchNo: String(row.batch_no),
      productionOrder: text(row.production_order),
    })),
    receivedFrom: moves
      .filter((m) => m.kind === 'grn')
      .map((m) => ({ supplier: text(m.party_name), grn: String(m.doc_no), date: day(m.doc_date), qty: round(num(m.qty)) })),
    otherMovements: moves.filter((m) => !known.has(String(m.kind))).length,
  }
}
