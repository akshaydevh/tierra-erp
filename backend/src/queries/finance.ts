import {
  day,
  intArray,
  monthStart,
  num,
  numOrNull,
  pageRequest,
  searchPattern,
  text,
  textArray,
  timestamp,
  type Paged,
  type SapSql,
} from '../sap/db'

/**
 * Finance reads over the erp finance views (sql/erp/12_finance.sql): bank and cash accounts and their lines, payments,
 * payment approvals, business-partner balances and ageing, and what the daily report needs (invoices by dispatch
 * basis, a day's goods receipts and production). Balances always come from the journal, never from document flags.
 */

export type BankAccount = {
  glCode: string
  name: string
  shortName: string
  kind: 'bank' | 'cash'
  houseBank: boolean
  active: boolean
  displayOrder: number
}

/** A bank journal line counted on another report day (bank_line_reattributions). */
export type LineMove = { transId: number; lineId: number; reportDate: string }

export type BankLine = {
  transId: number
  lineId: number
  glCode: string
  bank: string
  refDate: string
  /** The day it counts on: refDate, or the day it was re-attributed to. */
  reportDate: string
  moved: boolean
  createdAt: string | null
  debit: number
  credit: number
  amount: number
  contraCode: string | null
  contraKind: 'bank' | 'card' | 'gl'
  contraBank: string | null
  cardCode: string | null
  contraName: string | null
  transType: string
  paymentDocEntry: number | null
  paymentType: string | null
  paymentMemo: string | null
  paymentCancelled: boolean
  purposeGl: string | null
  memo: string | null
  jeMemo: string | null
  sourceNo: string | null
  isReversal: boolean
  /** The journal entry this line's entry cancels (SAP's StornoToTr); its amounts are the original's, negated. */
  reversesTransId: number | null
}

export type BankPosition = {
  glCode: string
  bank: string
  kind: 'bank' | 'cash'
  houseBank: boolean
  opening: number
  receipts: number
  payments: number
  closing: number
}

const BUCKETS = ['not_due', '1_30', '31_60', '61_90', '91_180', 'over_180'] as const
export type AgeBucket = (typeof BUCKETS)[number]
export type Buckets = Record<AgeBucket, number>

function emptyBuckets(): Buckets {
  return { not_due: 0, '1_30': 0, '31_60': 0, '61_90': 0, '91_180': 0, over_180: 0 }
}

function moveArrays(moves: readonly LineMove[]) {
  return {
    trans: intArray(moves.map((move) => move.transId)),
    lines: intArray(moves.map((move) => move.lineId)),
    days: textArray(moves.map((move) => move.reportDate)),
  }
}

/** The re-attributions as a table `r(trans_id, line_id, report_date)` to left-join bank lines on. */
function movesTable(sql: SapSql, moves: readonly LineMove[]) {
  const usable = moves.filter((move) => Number.isSafeInteger(move.transId) && Number.isSafeInteger(move.lineId))
  const arrays = moveArrays(usable)
  return sql`(select * from unnest(${arrays.trans}::int[], ${arrays.lines}::int[], ${arrays.days}::date[]) as r(trans_id, line_id, report_date))`
}

export async function bankAccounts(sql: SapSql): Promise<BankAccount[]> {
  const rows = await sql`select * from erp.bank_accounts order by display_order`
  return rows.map((row) => ({
    glCode: String(row.gl_code),
    name: String(row.gl_name),
    shortName: String(row.short_name),
    kind: row.kind === 'bank' ? 'bank' : 'cash',
    houseBank: Boolean(row.house_bank),
    active: Boolean(row.active),
    displayOrder: num(row.display_order),
  }))
}

/**
 * Opening (end of the day before), receipts, payments and closing of every cash and bank account for one day, lines
 * dated by RefDate unless re-attributed to another day.
 */
export async function bankPositions(sql: SapSql, date: string, moves: readonly LineMove[] = []): Promise<BankPosition[]> {
  const rows = await sql`
    with r as ${movesTable(sql, moves)},
    l as (
      select l.gl_code, l.debit, l.credit, l.amount, coalesce(r.report_date, l.ref_date) as eff
      from erp.bank_lines l left join r on r.trans_id = l.trans_id and r.line_id = l.line_id
    )
    select a.gl_code, a.short_name, a.kind, a.house_bank, a.display_order,
           coalesce(sum(l.amount) filter (where l.eff < ${date}::date), 0) as opening,
           coalesce(sum(l.debit) filter (where l.eff = ${date}::date), 0) as receipts,
           coalesce(sum(l.credit) filter (where l.eff = ${date}::date), 0) as payments,
           coalesce(sum(l.amount) filter (where l.eff <= ${date}::date), 0) as closing
    from erp.bank_accounts a left join l on l.gl_code = a.gl_code
    group by a.gl_code, a.short_name, a.kind, a.house_bank, a.display_order
    order by a.display_order`
  return rows.map((row) => ({
    glCode: String(row.gl_code),
    bank: String(row.short_name),
    kind: row.kind === 'bank' ? 'bank' : 'cash',
    houseBank: Boolean(row.house_bank),
    opening: round2(num(row.opening)),
    receipts: round2(num(row.receipts)),
    payments: round2(num(row.payments)),
    closing: round2(num(row.closing)),
  }))
}

function toBankLine(row: Record<string, unknown>): BankLine {
  return {
    transId: num(row.trans_id),
    lineId: num(row.line_id),
    glCode: String(row.gl_code),
    bank: String(row.bank),
    refDate: day(row.ref_date)!,
    reportDate: day(row.eff)!,
    moved: Boolean(row.moved),
    createdAt: timestamp(row.created_at),
    debit: num(row.debit),
    credit: num(row.credit),
    amount: num(row.amount),
    contraCode: text(row.contra_code),
    contraKind: row.contra_kind === 'bank' ? 'bank' : row.contra_kind === 'card' ? 'card' : 'gl',
    contraBank: text(row.contra_bank),
    cardCode: text(row.card_code),
    contraName: text(row.contra_name),
    transType: String(row.trans_type),
    paymentDocEntry: numOrNull(row.payment_doc_entry),
    paymentType: text(row.payment_type),
    paymentMemo: text(row.payment_memo),
    paymentCancelled: Boolean(row.payment_cancelled),
    purposeGl: text(row.purpose_gl),
    memo: text(row.memo),
    jeMemo: text(row.je_memo),
    sourceNo: text(row.source_no),
    isReversal: Boolean(row.is_reversal),
    reversesTransId: numOrNull(row.reverses_trans_id),
  }
}

/** Every cash/bank line that counts on this day (by RefDate, or re-attributed to it), in posting order. */
export async function bankLinesOn(sql: SapSql, date: string, moves: readonly LineMove[] = []): Promise<BankLine[]> {
  const rows = await sql`
    with r as ${movesTable(sql, moves)}
    select l.*, coalesce(r.report_date, l.ref_date) as eff, r.report_date is not null and r.report_date <> l.ref_date as moved
    from erp.bank_lines l left join r on r.trans_id = l.trans_id and r.line_id = l.line_id
    where coalesce(r.report_date, l.ref_date) = ${date}::date
    order by l.created_at nulls last, l.trans_id, l.line_id`
  return rows.map(toBankLine)
}

export type BankBookRow = BankLine & { balance: number }

/** One account's lines between two days (RefDate) with the running balance after each. */
export async function bankBook(
  sql: SapSql,
  input: { glCode: string; from: string; to: string; page?: string | number | null },
): Promise<Paged<BankBookRow> & { opening: number; closing: number; receipts: number; payments: number }> {
  const { page, pageSize, offset } = pageRequest(input.page, 100)
  const [totals] = await sql`
    select coalesce(sum(amount) filter (where ref_date < ${input.from}::date), 0) as opening,
           coalesce(sum(debit) filter (where ref_date between ${input.from}::date and ${input.to}::date), 0) as receipts,
           coalesce(sum(credit) filter (where ref_date between ${input.from}::date and ${input.to}::date), 0) as payments,
           count(*) filter (where ref_date between ${input.from}::date and ${input.to}::date) as n
    from erp.bank_lines where gl_code = ${input.glCode}`
  const opening = num(totals?.opening)
  const rows = await sql`
    select l.*, l.ref_date as eff, false as moved,
           ${opening}::numeric + sum(l.amount) over (order by l.ref_date, l.trans_id, l.line_id) as balance
    from erp.bank_lines l
    where l.gl_code = ${input.glCode} and l.ref_date between ${input.from}::date and ${input.to}::date
    order by l.ref_date, l.trans_id, l.line_id
    limit ${pageSize} offset ${offset}`
  const receipts = num(totals?.receipts)
  const payments = num(totals?.payments)
  return {
    rows: rows.map((row) => ({ ...toBankLine(row), balance: round2(num(row.balance)) })),
    total: num(totals?.n),
    page,
    pageSize,
    opening: round2(opening),
    receipts: round2(receipts),
    payments: round2(payments),
    closing: round2(opening + receipts - payments),
  }
}

export type PaymentRow = {
  direction: 'in' | 'out'
  docEntry: number
  docNo: string
  docDate: string
  createdAt: string | null
  kind: 'customer' | 'supplier' | 'account'
  cardCode: string | null
  cardName: string | null
  bank: string | null
  amount: number
  onAccount: number
  applied: number
  purposeGl: string | null
  purposeName: string | null
  transfer: boolean
  memo: string | null
  cancelled: boolean
}

function toPayment(row: Record<string, unknown>): PaymentRow {
  return {
    direction: row.direction === 'in' ? 'in' : 'out',
    docEntry: num(row.doc_entry),
    docNo: String(row.doc_no),
    docDate: day(row.doc_date)!,
    createdAt: timestamp(row.created_at),
    kind: row.kind === 'customer' ? 'customer' : row.kind === 'supplier' ? 'supplier' : 'account',
    cardCode: text(row.card_code),
    cardName: text(row.card_name),
    bank: text(row.bank),
    amount: num(row.amount),
    onAccount: num(row.on_account),
    applied: num(row.applied),
    purposeGl: text(row.purpose_gl),
    purposeName: tidyAccountName(text(row.purpose_name)),
    transfer: Boolean(row.transfer),
    memo: text(row.memo),
    cancelled: Boolean(row.cancelled),
  }
}

export type PaymentFilter = {
  direction?: 'in' | 'out' | null
  from?: string | null
  to?: string | null
  /** Payments to one GL account (salary, GST ...). */
  purposeGl?: string | null
  /** Payments of these business-partner cards. */
  cardCodes?: readonly string[] | null
  kind?: 'customer' | 'supplier' | 'account' | null
  /** Only transfers between Tierra's own accounts (true), or none of them (false). */
  transfer?: boolean | null
  q?: string | null
  includeCancelled?: boolean
  page?: string | number | null
  pageSize?: string | number | null
}

/** Incoming / outgoing payments, newest first, with the total of what matched. Transfers between banks are kept. */
export async function payments(sql: SapSql, filter: PaymentFilter = {}): Promise<Paged<PaymentRow> & { amount: number }> {
  const like = searchPattern(filter.q)
  const { page, pageSize, offset } = pageRequest(filter.page, filter.pageSize)
  const where = sql`
    where true
    ${filter.includeCancelled ? sql`` : sql`and not cancelled`}
    ${filter.direction ? sql`and direction = ${filter.direction}` : sql``}
    ${filter.kind ? sql`and kind = ${filter.kind}` : sql``}
    ${filter.transfer != null ? sql`and transfer = ${filter.transfer}` : sql``}
    ${filter.from ? sql`and doc_date >= ${filter.from}::date` : sql``}
    ${filter.to ? sql`and doc_date <= ${filter.to}::date` : sql``}
    ${filter.purposeGl ? sql`and purpose_gl = ${filter.purposeGl}` : sql``}
    ${filter.cardCodes ? sql`and card_code = any(${textArray(filter.cardCodes)}::text[])` : sql``}
    ${like ? sql`and (doc_no ilike ${like} or card_name ilike ${like} or memo ilike ${like} or purpose_name ilike ${like})` : sql``}`
  const [rows, [count]] = await Promise.all([
    sql`select * from erp.payments ${where} order by doc_date desc, created_at desc nulls last, doc_entry desc limit ${pageSize} offset ${offset}`,
    sql`select count(*) as n, coalesce(sum(amount), 0) as amount from erp.payments ${where}`,
  ])
  return { rows: rows.map(toPayment), total: num(count?.n), page, pageSize, amount: round2(num(count?.amount)) }
}

export type PurposeRow = {
  /** account GL code, or supplier / customer / transfer */
  key: string
  label: string
  kind: 'account' | 'supplier' | 'customer' | 'transfer'
  count: number
  amount: number
}

/** Outgoing payments between two days grouped by what they paid for: each GL account, suppliers, refunds, transfers. */
export async function paymentsByPurpose(sql: SapSql, from: string, to: string): Promise<{ rows: PurposeRow[]; total: number }> {
  const rows = await sql`
    select case when transfer then 'transfer' when kind = 'account' then purpose_gl else kind end as key,
           case when transfer then 'transfer' else kind end as kind,
           max(purpose_name) as purpose_name,
           count(*) as n, sum(amount) as amount
    from erp.payments
    where direction = 'out' and not cancelled and doc_date between ${from}::date and ${to}::date
    group by 1, 2
    order by sum(amount) desc`
  const out = rows.map((row): PurposeRow => {
    const kind = row.kind === 'transfer' ? 'transfer' : row.kind === 'supplier' ? 'supplier' : row.kind === 'customer' ? 'customer' : 'account'
    const label =
      kind === 'transfer'
        ? 'Transfers between own accounts'
        : kind === 'supplier'
          ? 'Suppliers'
          : kind === 'customer'
            ? 'Refunds to customers'
            : (tidyAccountName(text(row.purpose_name)) ?? String(row.key))
    return { key: String(row.key ?? kind), label, kind, count: num(row.n), amount: round2(num(row.amount)) }
  })
  return { rows: out, total: round2(out.reduce((sum, row) => sum + row.amount, 0)) }
}

export type PaymentRequestRow = {
  requestId: number
  status: 'pending' | 'approved' | 'rejected'
  docDate: string | null
  requestedAt: string | null
  decidedAt: string | null
  originator: string | null
  approver: string | null
  kind: string
  cardCode: string | null
  cardName: string | null
  bank: string | null
  amount: number
  purposeName: string | null
  memo: string | null
  paymentDocEntry: number | null
}

/** Outgoing payments through SAP's approval; pending ones oldest first, decided ones newest first. */
export async function paymentRequests(
  sql: SapSql,
  input: { status?: 'pending' | 'approved' | 'rejected'; page?: string | number | null; pageSize?: string | number | null } = {},
): Promise<Paged<PaymentRequestRow> & { amount: number }> {
  const status = input.status ?? 'pending'
  const { page, pageSize, offset } = pageRequest(input.page, input.pageSize)
  const [rows, [count]] = await Promise.all([
    sql`select * from erp.payment_requests where status = ${status}
        order by ${status === 'pending' ? sql`requested_at asc` : sql`coalesce(decided_at, requested_at) desc`}, request_id
        limit ${pageSize} offset ${offset}`,
    sql`select count(*) as n, coalesce(sum(amount), 0) as amount from erp.payment_requests where status = ${status}`,
  ])
  return {
    rows: rows.map((row) => ({
      requestId: num(row.request_id),
      status: row.status === 'approved' ? 'approved' : row.status === 'rejected' ? 'rejected' : 'pending',
      docDate: day(row.doc_date),
      requestedAt: timestamp(row.requested_at),
      decidedAt: timestamp(row.decided_at),
      originator: text(row.originator),
      approver: text(row.approver),
      kind: String(row.kind),
      cardCode: text(row.card_code),
      cardName: text(row.card_name),
      bank: text(row.bank),
      amount: num(row.amount),
      purposeName: tidyAccountName(text(row.purpose_name)),
      memo: text(row.memo),
      paymentDocEntry: numOrNull(row.payment_doc_entry),
    })),
    total: num(count?.n),
    page,
    pageSize,
    amount: round2(num(count?.amount)),
  }
}

export type FinanceKpis = {
  asOf: string
  banks: Array<{ glCode: string; bank: string; balance: number; houseBank: boolean }>
  cash: number
  receiptsMtd: number
  paymentsMtd: number
  pendingApprovals: { count: number; amount: number; oldest: string | null }
  netReceivable: number
  netPayable: number
}

/** The Payments page's figures as of the data date. Receipts and payments MTD leave out transfers between own accounts. */
export async function financeKpis(sql: SapSql, asOf: string): Promise<FinanceKpis> {
  const from = monthStart(asOf)
  const [banks, [flows], [pending], [balances]] = await Promise.all([
    sql`
      select a.gl_code, a.short_name, a.house_bank, coalesce(sum(l.amount), 0) as balance
      from erp.bank_accounts a left join erp.bank_lines l on l.gl_code = a.gl_code and l.ref_date <= ${asOf}::date
      where a.kind = 'bank' and a.active
      group by a.gl_code, a.short_name, a.house_bank, a.display_order order by a.display_order`,
    sql`
      select coalesce(sum(amount) filter (where direction = 'in'), 0) as receipts,
             coalesce(sum(amount) filter (where direction = 'out'), 0) as payments
      from erp.payments where not cancelled and not transfer and doc_date between ${from}::date and ${asOf}::date`,
    sql`select count(*) as n, coalesce(sum(amount), 0) as amount, min(requested_at) as oldest from erp.payment_requests where status = 'pending'`,
    sql`
      select coalesce(sum(owed) filter (where card_type = 'customer'), 0) as receivable,
             coalesce(sum(owed) filter (where card_type = 'supplier'), 0) as payable
      from erp.bp_balances`,
  ])
  const bankRows = banks.map((row) => ({
    glCode: String(row.gl_code),
    bank: String(row.short_name),
    balance: round2(num(row.balance)),
    houseBank: Boolean(row.house_bank),
  }))
  return {
    asOf,
    banks: bankRows,
    cash: round2(bankRows.reduce((sum, row) => sum + row.balance, 0)),
    receiptsMtd: round2(num(flows?.receipts)),
    paymentsMtd: round2(num(flows?.payments)),
    pendingApprovals: { count: num(pending?.n), amount: round2(num(pending?.amount)), oldest: timestamp(pending?.oldest) },
    netReceivable: round2(num(balances?.receivable)),
    netPayable: round2(num(balances?.payable)),
  }
}

export type AgeingSide = 'receivable' | 'payable'

export type AgeingGroup = {
  groupKey: string
  /** The PAN when the group is a company, else null (a single card). */
  pan: string | null
  name: string
  cards: number
  /** Net of the group's cards: what the group owes Tierra (receivable) or Tierra owes it (payable). */
  net: number
  buckets: Buckets
  overdue: number
}

/**
 * Ageing by PAN group (customers or suppliers), largest net first. Groups whose net is in the party's favour (an
 * advance) come with zero buckets. totals adds up the buckets of every group.
 */
export async function ageingGroups(
  sql: SapSql,
  input: { side: AgeingSide; cardCodes?: readonly string[] | null; limit?: number },
): Promise<{ rows: AgeingGroup[]; total: number; totals: Buckets & { net: number } }> {
  const cardType = input.side === 'receivable' ? 'customer' : 'supplier'
  const scope = input.cardCodes ? sql`and b.card_code = any(${textArray(input.cardCodes)}::text[])` : sql``
  const rows = await sql`
    with g as (
      select b.group_key, max(b.pan) as pan, count(*) as cards, sum(b.owed) as net,
             (array_agg(b.card_name order by abs(b.owed) desc, b.card_code))[1:50] as names
      from erp.bp_balances b
      where b.card_type = ${cardType} and (b.lines > 0 or b.owed <> 0) ${scope}
      group by b.group_key
    ), a as (
      select group_key, bucket, sum(amount) as amount from erp.ar_ap_ageing where side = ${input.side} group by 1, 2
    )
    select g.*, coalesce(jsonb_object_agg(a.bucket, a.amount) filter (where a.bucket is not null), '{}') as buckets
    from g left join a on a.group_key = g.group_key
    where abs(g.net) >= 1
    group by g.group_key, g.pan, g.cards, g.net, g.names
    order by g.net desc`
  const totals = { ...emptyBuckets(), net: 0 }
  const out = rows.map((row): AgeingGroup => {
    const buckets = emptyBuckets()
    const raw = (row.buckets ?? {}) as Record<string, unknown>
    for (const bucket of BUCKETS) buckets[bucket] = round2(num(raw[bucket]))
    for (const bucket of BUCKETS) totals[bucket] += buckets[bucket]
    totals.net += num(row.net)
    return {
      groupKey: String(row.group_key),
      pan: text(row.pan),
      name: groupName((row.names as string[] | null) ?? [], String(row.group_key)),
      cards: num(row.cards),
      net: round2(num(row.net)),
      buckets,
      overdue: round2(BUCKETS.filter((bucket) => bucket !== 'not_due').reduce((sum, bucket) => sum + buckets[bucket], 0)),
    }
  })
  for (const bucket of BUCKETS) totals[bucket] = round2(totals[bucket])
  totals.net = round2(totals.net)
  return { rows: out.slice(0, input.limit ?? out.length), total: out.length, totals }
}

export type CardBalance = {
  cardCode: string
  cardName: string
  cardType: string
  pan: string | null
  groupKey: string
  /** What the card owes Tierra (customer) or Tierra owes it (supplier). */
  owed: number
  lastMoved: string | null
  /** The part of the group's open balance allocated to this card's documents, by bucket. */
  buckets: Buckets
}

/** Cards with their journal balance and their share of the group's ageing. */
export async function cardBalances(
  sql: SapSql,
  input: { side?: AgeingSide | null; groupKey?: string | null; cardCodes?: readonly string[] | null; q?: string | null; limit?: number },
): Promise<CardBalance[]> {
  const like = searchPattern(input.q)
  const cardType = input.side ? (input.side === 'receivable' ? 'customer' : 'supplier') : null
  const rows = await sql`
    with a as (
      select card_code, jsonb_object_agg(bucket, amount) as buckets
      from (select card_code, bucket, sum(amount) as amount from erp.ar_ap_ageing group by 1, 2) x
      group by card_code
    )
    select b.*, coalesce(a.buckets, '{}') as buckets
    from erp.bp_balances b left join a on a.card_code = b.card_code
    where b.card_type in ('customer', 'supplier') and (b.lines > 0 or b.owed <> 0)
    ${cardType ? sql`and b.card_type = ${cardType}` : sql``}
    ${input.groupKey ? sql`and b.group_key = ${input.groupKey}` : sql``}
    ${input.cardCodes ? sql`and b.card_code = any(${textArray(input.cardCodes)}::text[])` : sql``}
    ${like ? sql`and (b.card_name ilike ${like} or b.card_code ilike ${like} or b.pan ilike ${like})` : sql``}
    order by b.owed desc, b.card_code
    limit ${input.limit ?? 50}`
  return rows.map((row) => {
    const buckets = emptyBuckets()
    const raw = (row.buckets ?? {}) as Record<string, unknown>
    for (const bucket of BUCKETS) buckets[bucket] = round2(num(raw[bucket]))
    return {
      cardCode: String(row.card_code),
      cardName: String(row.card_name),
      cardType: String(row.card_type),
      pan: text(row.pan),
      groupKey: String(row.group_key),
      owed: round2(num(row.owed)),
      lastMoved: day(row.last_moved),
      buckets,
    }
  })
}

export type JournalEntryRow = {
  transId: number
  docNo: string
  refDate: string
  transType: string
  memo: string | null
  total: number
  createdBy: string | null
  lines: Array<{ glCode: string; accountName: string | null; cardCode: string | null; debit: number; credit: number; memo: string | null }>
}

/** Journal entries by date range, memo text, account (GL code or card) and amount, newest first, with their lines. */
export async function journalEntries(
  sql: SapSql,
  filter: { from?: string | null; to?: string | null; q?: string | null; account?: string | null; amount?: number | null; manualOnly?: boolean; limit?: number },
): Promise<{ rows: JournalEntryRow[]; total: number }> {
  const like = searchPattern(filter.q)
  const where = sql`
    where true
    ${filter.from ? sql`and e.ref_date >= ${filter.from}::date` : sql``}
    ${filter.to ? sql`and e.ref_date <= ${filter.to}::date` : sql``}
    ${filter.manualOnly ? sql`and e.trans_type = '30'` : sql``}
    ${like ? sql`and (e.memo ilike ${like} or e.ref1 ilike ${like} or e.ref2 ilike ${like} or e.doc_no ilike ${like})` : sql``}
    ${filter.account ? sql`and exists (select 1 from erp.journal_lines j where j.trans_id = e.trans_id and (j.gl_code = ${filter.account} or j.card_code = ${filter.account}))` : sql``}
    ${filter.amount != null ? sql`and exists (select 1 from erp.journal_lines j where j.trans_id = e.trans_id and (abs(j.debit - ${filter.amount}) < 0.5 or abs(j.credit - ${filter.amount}) < 0.5))` : sql``}`
  const [rows, [count]] = await Promise.all([
    sql`select e.* from erp.journal_entries e ${where} order by e.ref_date desc, e.trans_id desc limit ${filter.limit ?? 10}`,
    sql`select count(*) as n from erp.journal_entries e ${where}`,
  ])
  const ids = rows.map((row) => num(row.trans_id))
  const lines = ids.length
    ? await sql`select * from erp.journal_lines where trans_id = any(${intArray(ids)}::int[]) order by trans_id, line_id`
    : []
  return {
    rows: rows.map((row) => ({
      transId: num(row.trans_id),
      docNo: String(row.doc_no ?? row.trans_id),
      refDate: day(row.ref_date)!,
      transType: String(row.trans_type),
      memo: text(row.memo),
      total: num(row.total),
      createdBy: text(row.created_by),
      lines: lines
        .filter((line) => num(line.trans_id) === num(row.trans_id))
        .map((line) => ({
          glCode: String(line.gl_code),
          accountName: tidyAccountName(text(line.account_name)),
          cardCode: text(line.card_code),
          debit: num(line.debit),
          credit: num(line.credit),
          memo: text(line.memo),
        })),
    })),
    total: num(count?.n),
  }
}

// ------------------------------------------------------------------------------------------------ daily report inputs

export type OutwardsInvoice = {
  docEntry: number
  docNo: string
  docDate: string
  createdAt: string | null
  ewbDate: string | null
  cardCode: string
  cardName: string
  total: number
}

export type OutwardsBasisName = 'created_window' | 'doc_date' | 'ewb_date'

/** "19:30" -> "19:30:00"; anything unreadable falls back to 19:30. */
export function cutoffTime(value: string | null | undefined): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value?.trim() ?? '')
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return '19:30:00'
  return `${match[1]!.padStart(2, '0')}:${match[2]}:00`
}

/**
 * A day's outwards and the month to date under one basis:
 * - created_window: invoices keyed after the cut-off (IST) of the day before and up to the day's cut-off;
 * - doc_date: invoices dated that day;
 * - ewb_date: invoices whose e-way bill is dated that day (no e-way bill: the invoice date).
 * Month to date: invoices dated this month up to the day that had gone out by the day's end under the same basis
 * (created_window: keyed by the day's cut-off), so an invoice keyed late is not counted early. This is the manual
 * sheet's rule: an invoice dated last month but keyed after the cut-off on its last day shows in this month's first
 * day total and in no month total (the report footnotes it).
 */
export async function outwardsFor(
  sql: SapSql,
  input: { date: string; basis: OutwardsBasisName; cutoff?: string | null },
): Promise<{ invoices: OutwardsInvoice[]; monthToDate: number; monthCount: number }> {
  const cut = cutoffTime(input.cutoff)
  const endOf = sql`((${input.date}::date + ${cut}::time) at time zone 'Asia/Kolkata')`
  const startOf = sql`(((${input.date}::date - 1) + ${cut}::time) at time zone 'Asia/Kolkata')`
  const dayCondition =
    input.basis === 'created_window'
      ? sql`created_at > ${startOf} and created_at <= ${endOf}`
      : input.basis === 'ewb_date'
        ? sql`coalesce(ewb_date, doc_date) = ${input.date}::date`
        : sql`doc_date = ${input.date}::date`
  const first = monthStart(input.date)
  const inMonth = sql`doc_date between ${first}::date and ${input.date}::date`
  const monthCondition =
    input.basis === 'created_window'
      ? sql`created_at <= ${endOf} and ${inMonth}`
      : input.basis === 'ewb_date'
        ? sql`${inMonth} and coalesce(ewb_date, doc_date) <= ${input.date}::date`
        : inMonth
  const [rows, [month]] = await Promise.all([
    sql`select * from erp.invoices_outwards where ${dayCondition} order by created_at, doc_entry`,
    sql`select coalesce(sum(total), 0) as total, count(*) as n from erp.invoices_outwards where ${monthCondition}`,
  ])
  return {
    invoices: rows.map((row) => ({
      docEntry: num(row.doc_entry),
      docNo: String(row.doc_no),
      docDate: day(row.doc_date)!,
      createdAt: timestamp(row.created_at),
      ewbDate: day(row.ewb_date),
      cardCode: String(row.card_code),
      cardName: String(row.card_name),
      total: num(row.total),
    })),
    monthToDate: round2(num(month?.total)),
    monthCount: num(month?.n),
  }
}

export type InwardLine = {
  docEntry: number
  docNo: string
  cardCode: string
  cardName: string
  createdAt: string | null
  itemCode: string | null
  itemName: string | null
  materialRole: string | null
  qty: number
  uom: string | null
  value: number
  freeIssue: boolean
}

/** Goods receipts (GRN lines) dated that day, cancelled ones left out. */
export async function grnLinesOn(sql: SapSql, date: string): Promise<InwardLine[]> {
  const rows = await sql`
    select g.doc_entry, g.doc_no, g.card_code, g.card_name, g.created_at,
           l.item_code, l.item_name, l.material_role, l.qty, l.uom, l.line_total, l.free_issue
    from erp.grns g join erp.grn_lines l on l.doc_entry = g.doc_entry
    where g.doc_date = ${date}::date and not g.cancelled and not g.is_cancellation
    order by g.doc_entry, l.line_num`
  return rows.map((row) => ({
    docEntry: num(row.doc_entry),
    docNo: String(row.doc_no),
    cardCode: String(row.card_code),
    cardName: String(row.card_name),
    createdAt: timestamp(row.created_at),
    itemCode: text(row.item_code),
    itemName: text(row.item_name),
    materialRole: text(row.material_role),
    qty: num(row.qty),
    uom: text(row.uom),
    value: num(row.line_total),
    freeIssue: Boolean(row.free_issue),
  }))
}

export type ProductionDay = {
  orders: Array<{ docNo: string; itemCode: string; itemName: string | null; customer: string | null; plannedQty: number; status: string }>
  /** Goods receipts of finished goods (pieces) against production orders that day. */
  receipts: Array<{ docNo: string; qty: number }>
  /** Material issued to production that day, by material role. */
  issues: Array<{ role: string | null; lines: number; qty: number }>
}

/** What SAP shows of a day's production: orders posted, finished goods received, materials issued. */
export async function productionOn(sql: SapSql, date: string): Promise<ProductionDay> {
  const [orders, receipts, issues] = await Promise.all([
    sql`
      select doc_no, item_code, item_name, customer_name, planned_qty, status from erp.production_orders
      where post_date = ${date}::date and status <> 'cancelled' order by doc_entry`,
    sql`
      select doc_no, sum(qty) as qty from erp.production_movements
      where kind = 'receipt' and doc_date = ${date}::date and not cancelled and production_doc_entry is not null
        and material_role = 'fg'
      group by doc_no, doc_entry order by doc_entry`,
    sql`
      select material_role, count(*) as lines, sum(qty) as qty from erp.production_movements
      where kind = 'issue' and doc_date = ${date}::date and not cancelled
      group by material_role order by material_role`,
  ])
  return {
    orders: orders.map((row) => ({
      docNo: String(row.doc_no),
      itemCode: String(row.item_code),
      itemName: text(row.item_name),
      customer: text(row.customer_name),
      plannedQty: num(row.planned_qty),
      status: String(row.status),
    })),
    receipts: receipts.map((row) => ({ docNo: String(row.doc_no), qty: num(row.qty) })),
    issues: issues.map((row) => ({ role: text(row.material_role), lines: num(row.lines), qty: num(row.qty) })),
  }
}

// ------------------------------------------------------------------------------------------------ helpers

/**
 * A company's name from its branch cards' names: the words they all start with ("Alpha Industries" for
 * "Alpha Industries Limited, Delhi" and "Alpha Industries Ltd Pune"), else the largest card's name.
 */
export function groupName(names: readonly string[], fallback: string): string {
  if (names.length === 0) return fallback
  if (names.length === 1) return names[0]!
  const words = names.map((name) => name.split(/[\s,.\-()]+/).filter(Boolean))
  const shared: string[] = []
  for (let i = 0; i < words[0]!.length; i += 1) {
    const word = words[0]![i]!
    if (!words.every((row) => row[i]?.toLowerCase() === word.toLowerCase())) break
    shared.push(word)
  }
  return shared.length ? shared.join(' ') : names[0]!
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** "Industrial Gas Expenses (TRA)" -> "Industrial Gas Expenses": SAP's company suffix off an account name. */
export function tidyAccountName(name: string | null): string | null {
  if (!name) return null
  return name.replace(/\s*\((?:TRA|[A-Z]{2,4})\)\s*$/, '').trim() || name
}
