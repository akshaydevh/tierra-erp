import { z } from 'zod/v4'
import { FINANCE_ROLES, ROLES, type Role } from '../../db/types'
import type { CardScope } from '../../sap/db'
import type { ReceiptLine } from '../../domain/receipts'
import type { DocKey, FileLink, RecordAccess } from '../../queries/documents'
import type { DailyInputsPatch } from '../../db/types'
import type { TaskInput } from '../../tasks/service'
import type { AgentDeps } from '../deps'
import type { Audience } from '../scope'

/** Work a tool asks for but the loop does only after the model has finished: a reply never half-happens. */
export type Effect =
  | { kind: 'create_task'; input: TaskInput }
  | { kind: 'complete_task'; taskId: string; title: string }
  /** Sends the TSO's latest customer copy (and, internal only, its annex) to the chat after the reply. */
  | { kind: 'send_so_pdf'; salesOrderId: string; annex: boolean }
  | { kind: 'record_receipt'; lines: ReceiptLine[] }
  /** Sends one SAP attachment file (an invoice print, e-way bill, QR, vendor bill ...) to the chat after the reply. */
  | { kind: 'send_file'; file: FileLink; doc: DocKey & { docNo: string }; caption: string }
  /** Generates the day's daily report (a new stored version) and sends its PDF to the chat after the reply. */
  | { kind: 'send_daily_report'; date: string }
  /** Saves daily report inputs the person typed (manpower, banana estimate ...). */
  | { kind: 'set_daily_inputs'; date: string; patch: DailyInputsPatch }

export type ToolContext = {
  deps: AgentDeps
  audience: Audience
  /** The SAP cards this audience may read; party tools pass it to every query. */
  cards: CardScope
  /** The SAP data date; "today" in a SAP question. */
  dataAsOf: string | null
  /** The day documents are numbered from when someone types "SO 445": the data date, else today in India. */
  referenceDay: string
  /** The WhatsApp (or desk) message this turn answers, for task subjects. */
  messageId: string
  /** That message's own words: the HR tools give names only when they ask for them (hr-gate.ts). */
  question?: string
  via: 'whatsapp' | 'desk'
  effects: Effect[]
  /** What this chat is pinned to (a quoted bot message or the approval request), when fresh. */
  pin?: { subjectType: string; subjectId: string } | null
  /** The SAP document whose file was last sent to (or quoted in) this chat: "send that again", "and the e-way bill". */
  lastDocument?: (DocKey & { role?: string }) | null
  /** Single SAP documents this turn looked up (get_document, get_invoice, send_document), for the attachment rule. */
  concerned?: Array<DocKey & { docNo: string }>
  /** Documents send_document was asked for this turn (sent or not): the attachment rule leaves them alone. */
  sendTried?: string[]
}

/** Finance records (payment / journal-entry approvals and files, KYC papers) for the manager and the admin only. */
export function recordAccess(ctx: Pick<ToolContext, 'audience'>): RecordAccess {
  return ctx.audience.kind === 'internal' && FINANCE_ROLES.includes(ctx.audience.role) ? 'finance' : 'operations'
}

/** Notes that the turn looked at one specific SAP document (the attachment rule counts them). */
export function noteDocument(ctx: ToolContext, doc: DocKey & { docNo: string }): void {
  const list = (ctx.concerned ??= [])
  if (!list.some((row) => row.sapObject === doc.sapObject && row.docEntry === doc.docEntry)) list.push(doc)
}

/**
 * party: safe in a customer's group; it reads sales documents only and filters every query by ctx.cards.
 * internal: Tierra's own people (linked accounts in a DM, the self chat or the desk).
 */
export type ToolScope = 'party' | 'internal'

export type AgentTool = {
  name: string
  description: string
  scope: ToolScope
  /** Internal roles that may use the tool. Finance and payroll tools (P6/P7) narrow this to manager or admin. */
  roles: readonly Role[]
  args: z.ZodType
  run(ctx: ToolContext, args: unknown): Promise<unknown>
}

export function defineTool<S extends z.ZodType>(tool: {
  name: string
  description: string
  scope: ToolScope
  roles?: readonly Role[]
  args: S
  run(ctx: ToolContext, args: z.infer<S>): Promise<unknown>
}): AgentTool {
  return { ...tool, roles: tool.roles ?? ROLES, run: (ctx, args) => tool.run(ctx, args as z.infer<S>) }
}

export const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('A day as YYYY-MM-DD')

export const docNoArg = z
  .string()
  .min(2)
  .max(40)
  .describe('The document number as SAP prints it, e.g. SO/26-27/445; "SO 445" also works for this financial year')

/** What a lookup says when nothing is there: a customer only ever hears "not found for your account". */
export function notFound(ctx: ToolContext, what: string): { found: false; message: string } {
  return {
    found: false,
    message: ctx.audience.kind === 'party' ? 'Not found for your account.' : `${what} is not in SAP.`,
  }
}
