import type { Store } from '../db/store'
import { dayLabel, defaultReportDate } from '../domain/daily-report'
import { dailyCostingFileName, renderDailyCostingPdf } from '../pdf/daily-costing'
import { buildDailyCosting, costingSummary, productionDays, type DailyCostingPayload } from '../queries/daily-costing'
import { importMeta } from '../queries/meta'
import type { SapSql } from '../sap/db'
import type { EvolutionClient } from '../whatsapp/evolution'
import { sendDocument } from '../agent/send'

/** Registry purpose and subject of a daily costing report sent on WhatsApp. */
export const COSTING_PURPOSE = 'daily_costing'
export const COSTING_SUBJECT = 'daily_costing'

export type GeneratedCosting = {
  payload: DailyCostingPayload
  pdf: Buffer
  fileName: string
  documentId: string
  caption: string
}

/** The day a costing report is for when none is named: the last production day up to yesterday / the SAP data date. */
export async function defaultCostingDate(sql: SapSql, now: Date, dataAsOf: string | null): Promise<string> {
  const upTo = defaultReportDate(now, dataAsOf)
  const [last] = await productionDays(sql, upTo)
  return last ?? upTo
}

/**
 * Builds a day's costing report from SAP, renders its PDF and stores it in order_documents (kind report, so only the
 * manager and the admin can open it; subject: the day). Each generation is stored, so what was sent can be looked up.
 */
export async function generateDailyCosting(deps: { sapSql: SapSql; store: Store; now: () => Date }, input: { date: string }): Promise<GeneratedCosting> {
  const { dataAsOf } = await importMeta(deps.sapSql)
  const payload = await buildDailyCosting(deps.sapSql, { date: input.date, dataAsOf, now: deps.now() })
  const pdf = await renderDailyCostingPdf(payload)
  const fileName = dailyCostingFileName(payload)
  const documentId = await deps.store.insertDocument({
    filename: fileName,
    mimeType: 'application/pdf',
    content: pdf,
    kind: 'report',
    subjectType: COSTING_SUBJECT,
    subjectId: input.date,
  })
  return { payload, pdf, fileName, documentId, caption: costingSummary(payload, dayLabel(input.date)) }
}

/** Sends a generated costing report as a PDF to a WhatsApp chat and registers it. */
export async function sendCostingTo(
  deps: { store: Store; evolution: EvolutionClient },
  to: { number: string; remoteJid: string },
  report: GeneratedCosting,
): Promise<string | null> {
  return sendDocument(
    deps,
    to,
    { content: report.pdf, fileName: report.fileName, caption: report.caption },
    { purpose: COSTING_PURPOSE, subjectType: COSTING_SUBJECT, subjectId: report.payload.date },
  )
}
