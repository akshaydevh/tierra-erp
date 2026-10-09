import { cardFilter, day, intArray, num, numOrNull, text, textArray, timestamp, type CardScope, type SapSql } from '../sap/db'

/** SAP object types of the documents a customer may ask about: sales orders, A/R invoices and credit notes. */
export const SALES_OBJECTS = ['17', '13', '14'] as const

/**
 * Finance records among SAP objects: outgoing (46) and incoming (24) payments, journal entries (30), and business
 * partners (2, whose files are KYC papers). Their approvals and files are for the manager and the admin; the office
 * keeps operations (orders, invoices, purchasing, stock, production).
 */
export const FINANCE_OBJECTS = ['46', '24', '30', '2'] as const

/** What a reader may see of files and approvals: everything (manager, admin) or operations only (office). */
export type RecordAccess = 'finance' | 'operations'

export type DocumentRow = {
  sapObject: string
  docEntry: number
  docNo: string
  docType: string
  docDate: string | null
  cardCode: string | null
  cardName: string | null
  total: number | null
  cancelled: boolean
}

function documentRow(row: Record<string, unknown>): DocumentRow {
  return {
    sapObject: String(row.sap_object),
    docEntry: num(row.doc_entry),
    docNo: String(row.doc_no),
    docType: String(row.doc_type),
    docDate: day(row.doc_date),
    cardCode: text(row.card_code),
    cardName: text(row.card_name),
    total: numOrNull(row.total),
    cancelled: Boolean(row.cancelled),
  }
}

/**
 * Business documents by number (SO/26-27/445, TF/26-27/447, PR/26-27/101 ...), cancellation mirrors left out.
 * A party scope sees only its own sales documents; purchasing and production documents are internal.
 */
export async function documentsByNo(sql: SapSql, cards: CardScope, docNos: readonly string[]): Promise<DocumentRow[]> {
  if (docNos.length === 0) return []
  const rows = await sql`
    select sap_object, doc_entry, doc_no, doc_type, doc_date, card_code, card_name, total, cancelled
    from erp.documents
    where doc_no = any(${textArray(docNos)}::text[]) and not is_cancellation
    ${cards === 'all' ? sql`` : sql`and sap_object = any(${textArray(SALES_OBJECTS)}::text[])`}
    ${cardFilter(sql, cards)}
    order by doc_no, sap_object, doc_entry`
  return rows.map(documentRow)
}

export type ApprovalHistoryRow = {
  docObject: string
  docType: string | null
  docNo: string | null
  cardName: string | null
  status: 'approved' | 'rejected' | 'waiting'
  originator: string | null
  approver: string | null
  requestedAt: string | null
  decidedAt: string | null
  total: number | null
  template: string | null
  remarks: string | null
}

/** SAP approval requests (OWDD/WDD1), newest first: who asked, who decided and when. */
export async function approvalHistory(
  sql: SapSql,
  filter: {
    docNo?: string | null
    status?: string | null
    from?: string | null
    to?: string | null
    limit?: number
    offset?: number
    /** SAP object type: 17 sales orders, 22 purchase orders ... */
    docObject?: string | null
    /** operations (the default): payment and journal-entry approvals are left out. */
    access?: RecordAccess
  } = {},
): Promise<{ rows: ApprovalHistoryRow[]; total: number }> {
  const where = sql`
    where true
    ${filter.access === 'finance' ? sql`` : sql`and doc_object <> all(${textArray(FINANCE_OBJECTS)}::text[])`}
    ${filter.docNo ? sql`and doc_no = ${filter.docNo}` : sql``}
    ${filter.status ? sql`and status = ${filter.status}` : sql``}
    ${filter.docObject ? sql`and doc_object = ${filter.docObject}` : sql``}
    ${filter.from ? sql`and requested_at >= (${filter.from}::date)::timestamp at time zone 'Asia/Kolkata'` : sql``}
    ${filter.to ? sql`and requested_at < (${filter.to}::date + 1)::timestamp at time zone 'Asia/Kolkata'` : sql``}`
  const [rows, [count]] = await Promise.all([
    sql`
      select doc_object, doc_type, doc_no, card_name, status, originator, approver, requested_at, decided_at, total,
             template, remarks
      from erp.approvals_hist ${where}
      order by requested_at desc nulls last, request_id desc
      limit ${filter.limit ?? 10} offset ${filter.offset ?? 0}`,
    sql`select count(*) as total from erp.approvals_hist ${where}`,
  ])
  return {
    rows: rows.map((row) => ({
      docObject: String(row.doc_object),
      docType: text(row.doc_type),
      docNo: text(row.doc_no),
      cardName: text(row.card_name),
      status: row.status as ApprovalHistoryRow['status'],
      originator: text(row.originator),
      approver: text(row.approver),
      requestedAt: timestamp(row.requested_at),
      decidedAt: timestamp(row.decided_at),
      total: numOrNull(row.total),
      template: text(row.template),
      remarks: text(row.remarks),
    })),
    total: num(count?.total),
  }
}

// ------------------------------------------------------------------------------------------------ files on record

/** A SAP document's key in links and chat pins: "<sap object>:<doc entry>", e.g. 13:5120. */
export type DocKey = { sapObject: string; docEntry: number }

export function docKey(doc: DocKey): string {
  return `${doc.sapObject}:${doc.docEntry}`
}

/** A document key, optionally with the role of the file sent ("13:5120:ewaybill", the subject of a sent file). */
export function parseDocKey(value: string): (DocKey & { role?: string }) | null {
  const match = /^(\d{1,4}):(\d{1,9})(?::([a-z_]{1,40}))?$/.exec(value)
  if (!match) return null
  return match[3] ? { sapObject: match[1]!, docEntry: Number(match[2]), role: match[3] } : { sapObject: match[1]!, docEntry: Number(match[2]) }
}

/** What a customer group may receive: the files of its own invoices and credit notes that it already holds anyway. */
export const PARTY_FILE_ROLES = ['invoice_pdf', 'ewaybill', 'einvoice_qr', 'credit_note_pdf'] as const

export type FileLink = {
  sha256: string
  role: string
  fileName: string
  mime: string
  sizeBytes: number
  kind: string
  storageKey: string
  linkMethod: string
  /** When SAP printed it (print exports) or the file's own date. */
  fileTime: string | null
}

export type DocumentFile = FileLink & {
  sapObject: string
  docEntry: number | null
  docNo: string | null
  docType: string | null
  cardCode: string | null
  cardName: string | null
}

const FILE_COLUMNS = `sap_object, doc_entry, doc_no, doc_type, card_code, card_name, role, link_method, sha256, storage_key,
  file_name, mime, size_bytes, kind, file_time`

function documentFile(row: Record<string, unknown>): DocumentFile {
  return {
    sapObject: String(row.sap_object),
    docEntry: numOrNull(row.doc_entry),
    docNo: text(row.doc_no),
    docType: text(row.doc_type),
    cardCode: text(row.card_code),
    cardName: text(row.card_name),
    sha256: String(row.sha256),
    role: String(row.role),
    fileName: String(row.file_name),
    mime: String(row.mime),
    sizeBytes: num(row.size_bytes),
    kind: String(row.kind),
    storageKey: String(row.storage_key),
    linkMethod: String(row.link_method),
    fileTime: timestamp(row.file_time),
  }
}

/** Role order within a document: the main file first, newest print first. */
const ROLE_ORDER = [
  'invoice_pdf',
  'credit_note_pdf',
  'debit_note_pdf',
  'ap_invoice_pdf',
  'po_pdf',
  'so_pdf',
  'receipt_pdf',
  'ewaybill',
  'einvoice_qr',
  'supporting',
]

function roleRank(role: string): number {
  const at = ROLE_ORDER.indexOf(role)
  return at < 0 ? ROLE_ORDER.length : at
}

export function sortFiles<T extends FileLink>(files: T[]): T[] {
  return [...files].sort(
    (a, b) =>
      roleRank(a.role) - roleRank(b.role) ||
      (b.fileTime ?? '').localeCompare(a.fileTime ?? '') ||
      a.fileName.localeCompare(b.fileName),
  )
}

function financeFilter(sql: SapSql, access: RecordAccess) {
  return access === 'finance' ? sql`` : sql`and sap_object <> all(${textArray(FINANCE_OBJECTS)}::text[])`
}

/**
 * The files on record for some documents, by docKey, main file first. A party scope gets only its own invoices and
 * credit notes, and only the files a customer holds anyway (invoice print, e-way bill, e-invoice QR, credit note).
 * Operations access (the office) leaves out the files of payments, journal entries and business partners.
 */
export async function filesForDocuments(
  sql: SapSql,
  cards: CardScope,
  docs: readonly DocKey[],
  access: RecordAccess = 'operations',
): Promise<Map<string, DocumentFile[]>> {
  const out = new Map<string, DocumentFile[]>()
  const wanted = docs.filter((doc) => /^\d{1,4}$/.test(doc.sapObject) && Number.isSafeInteger(doc.docEntry))
  if (wanted.length === 0) return out
  const rows = await sql`
    select ${sql.unsafe(FILE_COLUMNS)}
    from erp.document_files
    where (sap_object, doc_entry) in (
      select o, e from unnest(${textArray(wanted.map((doc) => doc.sapObject))}::text[], ${intArray(wanted.map((doc) => doc.docEntry))}::int[]) as k(o, e))
    ${
      cards === 'all'
        ? sql``
        : sql`and sap_object = any(${textArray(['13', '14'])}::text[]) and role = any(${textArray(PARTY_FILE_ROLES)}::text[])`
    }
    ${financeFilter(sql, access)}
    ${cardFilter(sql, cards)}`
  for (const row of rows.map(documentFile)) {
    const key = docKey({ sapObject: row.sapObject, docEntry: row.docEntry ?? -1 })
    out.set(key, [...(out.get(key) ?? []), row])
  }
  for (const [key, files] of out) out.set(key, sortFiles(files))
  return out
}

export async function filesForDocument(sql: SapSql, cards: CardScope, doc: DocKey, access: RecordAccess = 'operations'): Promise<DocumentFile[]> {
  return (await filesForDocuments(sql, cards, [doc], access)).get(docKey(doc)) ?? []
}

/**
 * One stored file and every document it belongs to (for GET /api/files/:sha). Under operations access a file linked
 * only to payments, journal entries or business partners is not found.
 */
export async function fileBySha(sql: SapSql, sha256: string, access: RecordAccess = 'operations'): Promise<DocumentFile[]> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return []
  const rows = await sql`select ${sql.unsafe(FILE_COLUMNS)} from erp.document_files where sha256 = ${sha256} ${financeFilter(sql, access)}`
  return rows.map(documentFile)
}

/**
 * The file an answer about one document attaches (plan §3.4): an A/R invoice its invoice print, else the e-way bill,
 * else the e-invoice QR; a credit note its print; a GRN or A/P invoice the supporting bill; anything else its first
 * file. Null when SAP has none (in this scope).
 */
export function primaryFile<T extends FileLink>(sapObject: string, files: T[]): T | null {
  const sorted = sortFiles(files)
  const pick = (...roles: string[]) => {
    for (const role of roles) {
      const found = sorted.find((file) => file.role === role)
      if (found) return found
    }
    return null
  }
  if (sapObject === '13') return pick('invoice_pdf', 'ewaybill', 'einvoice_qr')
  if (sapObject === '14') return pick('credit_note_pdf', 'supporting', 'einvoice_qr')
  if (sapObject === '18' || sapObject === '20' || sapObject === '19') return pick('supporting', 'ap_invoice_pdf', 'debit_note_pdf')
  return sorted[0] ?? null
}

export type DocumentHeader = DocumentRow & { customerPoNo: string | null }

/** One document by key within the scope, with the customer PO number for invoices and sales orders. */
export async function documentByKey(sql: SapSql, cards: CardScope, doc: DocKey): Promise<DocumentHeader | null> {
  const [row] = await sql`
    select d.sap_object, d.doc_entry, d.doc_no, d.doc_type, d.doc_date, d.card_code, d.card_name, d.total, d.cancelled,
           case d.sap_object
             when '13' then (select i.customer_po_no from erp.invoices i where i.doc_entry = d.doc_entry)
             when '17' then (select o.customer_po_no from erp.sales_orders o where o.doc_entry = d.doc_entry)
           end as customer_po_no
    from erp.documents d
    where d.sap_object = ${doc.sapObject} and d.doc_entry = ${doc.docEntry}
    ${cards === 'all' ? sql`` : sql`and d.sap_object = any(${textArray(SALES_OBJECTS)}::text[])`}
    ${cardFilter(sql, cards, 'd.card_code')}`
  return row ? { ...documentRow(row), customerPoNo: text(row.customer_po_no) } : null
}

/**
 * Files of documents erp.documents does not cover (payments, journal entries, business partners), by the number
 * the link carries. Internal only: none of these are a customer's sales documents; under operations access (the
 * office) the finance ones are left out.
 */
export async function filesByDocNo(sql: SapSql, docNo: string, access: RecordAccess = 'operations'): Promise<DocumentFile[]> {
  const rows = await sql`
    select ${sql.unsafe(FILE_COLUMNS)} from erp.document_files
    where doc_no = ${docNo} and doc_type is null ${financeFilter(sql, access)}`
  return sortFiles(rows.map(documentFile))
}

/** Whether any file is on record for a number, whoever may read it (to tell "not yours" from "none"). */
export async function anyFilesByDocNo(sql: SapSql, docNo: string): Promise<boolean> {
  const [row] = await sql`select exists (select 1 from erp.document_files where doc_no = ${docNo} and doc_type is null) as found`
  return Boolean(row?.found)
}
