import { createHash } from 'node:crypto'
import type { Store } from '../db/store'
import type { DailyReportRecord, OutwardsBasis } from '../db/types'
import { buildDailyReport, reportSummary, type DailyReportPayload } from '../domain/daily-report'
import { dailyReportFileName, renderDailyReportPdf } from '../pdf/daily-report'
import type { SapSql } from '../sap/db'
import type { EvolutionClient } from '../whatsapp/evolution'
import { sendDocument } from '../agent/send'

/** Registry purpose and subject of a daily report sent on WhatsApp. */
export const REPORT_PURPOSE = 'daily_report'
export const REPORT_SUBJECT = 'daily_report'

export type GeneratedReport = {
  record: DailyReportRecord
  payload: DailyReportPayload
  pdf: Buffer
  fileName: string
  documentId: string
  caption: string
  /** The latest stored version was the same report, so no new version was stored. */
  reused?: boolean
}

/** JSON with object keys sorted, so a payload read back from jsonb hashes like the one built. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** What a report says, without when it was built: two builds of an unchanged day hash the same. */
export function payloadHash(payload: unknown): string {
  const { generatedAt: _at, ...content } = (payload ?? {}) as Record<string, unknown>
  return createHash('sha256').update(canonicalJson(content)).digest('hex')
}

/**
 * Builds a day's report, renders its PDF and stores both: the PDF in order_documents (kind report), the payload as
 * the next version of the day in daily_reports, stamped with the SAP data date. Every send is a new version, so what
 * someone received can always be looked up; a download (reuseUnchanged) serves the latest stored version instead
 * when the report has not changed since, so versions are kept only when the content changes.
 */
export async function generateDailyReport(
  deps: { sapSql: SapSql; store: Store; now: () => Date },
  input: { date: string; basis?: OutwardsBasis | null; userId: string | null; reuseUnchanged?: boolean },
): Promise<GeneratedReport> {
  const payload = await buildDailyReport(deps, { date: input.date, basis: input.basis })
  if (input.reuseUnchanged) {
    const latest = await deps.store.latestDailyReport(input.date)
    const stored = latest?.documentId && payloadHash(latest.payload) === payloadHash(payload) ? await deps.store.getDocument(latest.documentId) : null
    if (latest && stored) {
      const kept = latest.payload as DailyReportPayload
      return { record: latest, payload: kept, pdf: stored.content, fileName: stored.filename, documentId: latest.documentId!, caption: reportSummary(kept), reused: true }
    }
  }
  const pdf = await renderDailyReportPdf(payload)
  const fileName = dailyReportFileName(payload)
  const documentId = await deps.store.insertDocument({
    filename: fileName,
    mimeType: 'application/pdf',
    content: pdf,
    kind: 'report',
    subjectType: REPORT_SUBJECT,
    subjectId: input.date,
  })
  const record = await deps.store.createDailyReport({
    reportDate: input.date,
    basis: payload.basis,
    dataAsOf: payload.dataAsOf,
    payload,
    documentId,
    generatedBy: input.userId,
  })
  await deps.store.linkDocument(documentId, { kind: 'report', subjectType: REPORT_SUBJECT, subjectId: input.date, version: record.version })
  return { record, payload, pdf, fileName, documentId, caption: reportSummary(payload) }
}

/** Sends a generated report as a PDF to a WhatsApp chat and registers it (subject: the report). */
export async function sendReportTo(
  deps: { store: Store; evolution: EvolutionClient },
  to: { number: string; remoteJid: string },
  report: GeneratedReport,
): Promise<string | null> {
  return sendDocument(
    deps,
    to,
    { content: report.pdf, fileName: report.fileName, caption: report.caption },
    { purpose: REPORT_PURPOSE, subjectType: REPORT_SUBJECT, subjectId: report.record.id },
  )
}
