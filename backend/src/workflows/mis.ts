import type { Store } from '../db/store'
import { defaultMisMonth } from '../domain/mis'
import { istDay } from '../domain/daily-report'
import { misFileName, renderMisPdf } from '../pdf/mis'
import { importMeta } from '../queries/meta'
import { buildMis, misSummary, type MisPayload } from '../queries/mis'
import type { SapSql } from '../sap/db'
import type { EvolutionClient } from '../whatsapp/evolution'
import { sendDocument } from '../agent/send'

/** Registry purpose and subject of a monthly MIS sent on WhatsApp. */
export const MIS_PURPOSE = 'mis_report'
export const MIS_SUBJECT = 'mis'

export type GeneratedMis = { payload: MisPayload; pdf: Buffer; fileName: string; documentId: string; caption: string }

/** The MIS month when none is named: the SAP data month once its last day is in, else the month before. */
export async function defaultMisMonthFor(sql: SapSql, now: Date): Promise<string> {
  return defaultMisMonth((await importMeta(sql)).dataAsOf, istDay(now))
}

/**
 * Builds a month's MIS from SAP (and the HR files), renders its PDF and stores it in order_documents (kind report:
 * the manager and the admin only; subject: the month).
 */
export async function generateMis(deps: { sapSql: SapSql; store: Store; now: () => Date }, input: { month: string }): Promise<GeneratedMis> {
  const { dataAsOf } = await importMeta(deps.sapSql)
  const payload = await buildMis(deps, { month: input.month, dataAsOf, now: deps.now() })
  const pdf = await renderMisPdf(payload)
  const fileName = misFileName(payload)
  const documentId = await deps.store.insertDocument({
    filename: fileName,
    mimeType: 'application/pdf',
    content: pdf,
    kind: 'report',
    subjectType: MIS_SUBJECT,
    subjectId: input.month.slice(0, 7),
  })
  return { payload, pdf, fileName, documentId, caption: misSummary(payload) }
}

export async function sendMisTo(
  deps: { store: Store; evolution: EvolutionClient },
  to: { number: string; remoteJid: string },
  report: GeneratedMis,
): Promise<string | null> {
  return sendDocument(
    deps,
    to,
    { content: report.pdf, fileName: report.fileName, caption: report.caption },
    { purpose: MIS_PURPOSE, subjectType: MIS_SUBJECT, subjectId: report.payload.month.slice(0, 7) },
  )
}
