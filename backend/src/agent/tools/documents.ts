import { z } from 'zod/v4'
import {
  anyFilesByDocNo,
  approvalHistory,
  docKey,
  documentByKey,
  documentsByNo,
  filesByDocNo,
  filesForDocument,
  filesForDocuments,
  primaryFile,
  type DocumentFile,
  type DocumentHeader,
} from '../../queries/documents'
import { fileForModel, noFileLine, queueFile, roleLabel } from '../files'
import { normalizeDocNo } from '../refs'
import { defineTool, docNoArg, isoDay, noteDocument, notFound, recordAccess, type ToolContext } from './types'

const FILE_ROLES = [
  'invoice_pdf',
  'ewaybill',
  'einvoice_qr',
  'credit_note_pdf',
  'debit_note_pdf',
  'ap_invoice_pdf',
  'po_pdf',
  'so_pdf',
  'receipt_pdf',
  'supporting',
] as const

function number(ctx: ToolContext, raw: string): string {
  return normalizeDocNo(raw, ctx.referenceDay) ?? raw.trim().toUpperCase()
}

/** A payment's, journal entry's or business partner's files asked for by the office. */
function financeOnly(docNo: string): { found: false; message: string } {
  return { found: false, message: `${docNo} is not available to you: the files of payments, journal entries and business partners are for the manager and the admin.` }
}

/** Files by number for an internal reader; the reason when only finance files are there and the reader is the office. */
async function internalFiles(ctx: ToolContext, docNo: string): Promise<DocumentFile[] | { found: false; message: string }> {
  const access = recordAccess(ctx)
  const files = await filesByDocNo(ctx.deps.sapSql, docNo, access)
  if (files.length === 0 && access === 'operations' && (await anyFilesByDocNo(ctx.deps.sapSql, docNo))) return financeOnly(docNo)
  return files
}

/** A payment / journal entry / business partner's files by number, shaped like a document header (internal). */
function headerFromFiles(files: DocumentFile[]): DocumentHeader | null {
  const first = files[0]
  if (!first || first.docEntry == null) return null
  return {
    sapObject: first.sapObject,
    docEntry: first.docEntry,
    docNo: first.docNo ?? '',
    docType: first.docType ?? 'document',
    docDate: null,
    cardCode: first.cardCode,
    cardName: first.cardName,
    total: null,
    cancelled: false,
    customerPoNo: null,
  }
}

export const documentTools = [
  defineTool({
    name: 'get_document',
    description:
      'Look up any SAP document by number (SO, TF, CN, PO, GR, PV/PL, AP, PR, PA ...): type, date, party, total, and file_links: the files SAP has on record for it (invoice print, e-way bill, e-invoice QR, vendor bill scan ...). An empty file_links means SAP has no file for it.',
    // A customer group reaches only its own sales orders, invoices and credit notes; the queries enforce it.
    scope: 'party',
    args: z.object({ doc_no: docNoArg }),
    async run(ctx, args) {
      const docNo = number(ctx, args.doc_no)
      const rows = await documentsByNo(ctx.deps.sapSql, ctx.cards, [docNo])
      if (rows.length === 0) {
        const files = ctx.audience.kind === 'internal' ? await internalFiles(ctx, docNo) : []
        if (!Array.isArray(files)) return files
        if (files.length === 0) return notFound(ctx, `Document ${docNo}`)
        return { found: true, documents: [{ docNo, type: files[0]!.sapObject, party: files[0]!.cardName, file_links: files.map(fileForModel) }] }
      }
      const files = await filesForDocuments(ctx.deps.sapSql, ctx.cards, rows, recordAccess(ctx))
      if (rows.length === 1) noteDocument(ctx, rows[0]!)
      return {
        found: true,
        documents: rows.map((row) => ({
          docNo: row.docNo,
          type: row.docType,
          docDate: row.docDate,
          party: row.cardName,
          cardCode: row.cardCode,
          total: row.total,
          cancelled: row.cancelled,
          file_links: (files.get(docKey(row)) ?? []).map(fileForModel),
        })),
      }
    },
  }),
  defineTool({
    name: 'send_document',
    description:
      'Send a SAP document\'s file into this chat after your reply: by default its main file (an invoice\'s print, else its e-way bill, else its e-invoice QR; a GRN or supplier invoice\'s bill scan), or the one named in role (ewaybill, einvoice_qr, invoice_pdf ...). Without doc_no it uses the document whose file was last sent here ("send that again", "and the e-way bill"). Says so when SAP has no such file.',
    scope: 'party',
    args: z.object({
      doc_no: docNoArg.optional(),
      role: z.enum(FILE_ROLES).optional().describe('Which file: ewaybill, einvoice_qr (QR image), invoice_pdf, credit_note_pdf, supporting (bill scans) ...'),
    }),
    async run(ctx, args) {
      const sql = ctx.deps.sapSql
      let header: DocumentHeader | null = null
      let files: DocumentFile[] = []
      if (args.doc_no) {
        const docNo = number(ctx, args.doc_no)
        const rows = (await documentsByNo(sql, ctx.cards, [docNo])).sort((a, b) => Number(a.cancelled) - Number(b.cancelled))
        if (rows[0]) {
          header = await documentByKey(sql, ctx.cards, rows[0])
        } else if (ctx.audience.kind === 'internal') {
          const found = await internalFiles(ctx, docNo)
          if (!Array.isArray(found)) return { sent: false, message: found.message }
          files = found
          header = headerFromFiles(files)
        }
        if (!header) return notFound(ctx, `Document ${docNo}`)
      } else {
        if (!ctx.lastDocument) return { sent: false, message: 'Which document? Give its number, e.g. TF/26-27/447.' }
        header = await documentByKey(sql, ctx.cards, ctx.lastDocument)
        if (!header) return { sent: false, message: 'Which document? Give its number, e.g. TF/26-27/447.' }
      }
      if (files.length === 0) files = await filesForDocument(sql, ctx.cards, header, recordAccess(ctx))
      noteDocument(ctx, header)
      ;(ctx.sendTried ??= []).push(docKey(header))
      // "send that again": the same file as last time, unless a role is asked for
      const role = args.role ?? (args.doc_no ? undefined : ctx.lastDocument?.role)
      const file = role ? (files.find((row) => row.role === role) ?? null) : primaryFile(header.sapObject, files)
      if (!file) {
        return {
          sent: false,
          docNo: header.docNo,
          message: role ? `SAP has no ${roleLabel(role).toLowerCase()} on record for ${header.docNo}.` : noFileLine(header.docNo),
          otherFiles: files.map(fileForModel),
        }
      }
      queueFile(ctx, header, file)
      return {
        queued: true,
        docNo: header.docNo,
        sending: fileForModel(file),
        otherFiles: files.filter((row) => row.sha256 !== file.sha256).map(fileForModel),
      }
    },
  }),
  defineTool({
    name: 'approval_history',
    description:
      'SAP approval requests (who raised, who approved or rejected, and when), newest first. Filter by document number, status or request date. Payment and journal-entry approvals are for the manager and the admin only.',
    scope: 'internal',
    args: z.object({
      doc_no: docNoArg.optional(),
      status: z.enum(['approved', 'rejected', 'waiting']).optional(),
      from: isoDay.optional(),
      to: isoDay.optional(),
    }),
    async run(ctx, args) {
      const docNo = args.doc_no ? number(ctx, args.doc_no) : null
      return approvalHistory(ctx.deps.sapSql, { docNo, status: args.status, from: args.from, to: args.to, access: recordAccess(ctx) })
    },
  }),
]
