import type { AccountLink, ChatContext, TaskVia } from '../db/types'
import { recordReceipt } from '../workflows/receipts'
import { handleApprovalReaction, handleApprovalText } from './approvals'
import { handleOrderCommand } from './order-commands'
import { importMeta } from '../queries/meta'
import { completeTask, createTaskAndNotify, UnknownAssigneeError } from '../tasks/service'
import { raiseMapGroupTask } from './groups'
import { PROCEED, handleProceed } from './po-commands'
import { isOpenTask } from '../tasks/done'
import { resolvePeople, type Person } from '../whatsapp/people'
import { deliveryAddress, replyChatJid, type ChatKind, type IncomingMessage } from '../whatsapp/parse'
import { handleDoneReply, handleReaction, sendTestPdf, TEST_PDF } from './commands'
import { deliverReport, handleReportCommand } from './report-commands'
import { handleHrCommand } from './hr-commands'
import { isHrQuestion, withoutEmployeeCodes } from './hr-gate'

/** The payroll tools: a turn that used them never gets SAP files attached. */
const HR_TOOLS = new Set(['payroll_summary', 'attendance', 'leave_requests'])
import { generateDailyReport } from '../workflows/daily-report'
import type { AgentDeps } from './deps'
import { intakePdf } from './intake'
import { DOCUMENT_SUBJECT, applyAttachmentRule, deliverFile, lastDocumentFor, withNotes } from './files'
import { documentByKey, parseDocKey } from '../queries/documents'
import type { LlmMessage } from './llm'
import { runLoop, type LoopResult } from './loop'
import { gateEffects } from './effect-gate'
import { AGENT_REPLY, isDeskThread, postToDesk, sendBotText } from './outbox'
import { freshPin } from './pins'
import { systemPrompt, userTurn } from './prompt'
import { describeRefs, istToday, resolveRefs } from './refs'
import { buildAudience, cardsFor, type Audience } from './scope'
import { TIERRA_HEADER, ensureTierraPrefix, sendDocument, tierraReplyText } from './send'
import { toolsFor, type Effect, type ToolContext } from './tools'

/**
 * One WhatsApp (or desk) turn, deterministic first:
 * 1. a reaction -> task done (never the model);
 * 2. a quote of a bot message that has a subject -> that subject is pinned for the chat;
 * 3. a PDF -> the intake hook;
 * 4. commands: *done* on task notices, *test pdf*, *proceed* on a repeat PO, the daily report's, *payroll June*;
 * 5. anything else -> the pre-resolver, then the tool loop, in the audience scope.ts builds.
 */

export type DeskContext = {
  speaker: Person
  /** A PDF the desk stored before queueing the turn. */
  documentId?: string | null
}

const READ_EMOJI = '👀'
const HERE = 'Tierra Bot is here.'
export const UNMAPPED_GROUP = "This group isn't set up with Tierra yet — the office will link it."
const HISTORY_TURNS = 8

async function pinQuotedSubject(deps: AgentDeps, message: IncomingMessage): Promise<void> {
  if (!message.quotedId) return
  const quoted = await deps.store.findMessage(message.quotedId)
  if (!quoted?.fromMe || !quoted.subjectType || !quoted.subjectId) return
  await deps.store.setChatContext(message.remoteJid, quoted.subjectType, quoted.subjectId)
}

async function salesOrderPin(deps: AgentDeps, subjectType: string, subjectId: string): Promise<string | null> {
  const approval = subjectType === 'approval' ? await deps.store.getApproval(subjectId) : null
  const orderId = approval ? approval.subjectId : subjectId
  const order = await deps.store.getSalesOrder(orderId)
  if (!order) return null
  const state = approval
    ? `approval of version ${approval.version} ${approval.status.replace(/_/g, ' ')}`
    : order.status.replace(/_/g, ' ')
  return `the Tierra sales order ${order.docNo} (sales_order_id ${order.id}, ${order.partyName ?? order.cardCode}, customer PO ${order.customerPoNo ?? '—'}, customer_po_id ${order.customerPoId ?? '—'}, ${state}). Use get_so, explain_check (customer_po_id), free_stock and send_so_pdf for it`
}

/** The subject this chat is pinned to, in words, for internal audiences while it is fresh. */
async function pinnedSubject(deps: AgentDeps, context: ChatContext | null, audience: Audience): Promise<string | null> {
  if (audience.kind !== 'internal') return null
  if (!context) return null
  if (context.subjectType === 'approval' || context.subjectType === 'sales_order') {
    return salesOrderPin(deps, context.subjectType, context.subjectId)
  }
  if (context.subjectType === 'task') {
    const task = await deps.store.getTask(context.subjectId)
    if (!task) return null
    return `task ${task.id} "${task.title}" (${task.status}, held by ${task.assigneeName ?? 'nobody'})`
  }
  if (context.subjectType === DOCUMENT_SUBJECT) {
    const key = parseDocKey(context.subjectId)
    const doc = key ? await documentByKey(deps.sapSql, 'all', key).catch(() => null) : null
    return doc ? `the SAP document ${doc.docNo} (${doc.docType.replace(/_/g, ' ')}, ${doc.cardName ?? 'no party'}); its file was sent here` : null
  }
  if (context.subjectType === 'customer_po') {
    const po = await deps.store.getCustomerPo(context.subjectId)
    if (!po) return null
    return `customer PO ${po.poNo ?? '(no number)'} (customer_po_id ${po.id}, ${po.status.replace(/_/g, ' ')})`
  }
  return `${context.subjectType.replace(/_/g, ' ')} ${context.subjectId}`
}

/**
 * The chat's last few turns before the message being answered, oldest first. History is cut at that message: what
 * the person wrote after it (a later turn, queued behind this one) never leaks into this answer. The bot's own
 * messages are kept, as they answer earlier turns.
 */
export async function recentTurns(deps: AgentDeps, message: IncomingMessage, text: string): Promise<LlmMessage[]> {
  const jids = [...new Set([message.remoteJid, message.aliasJid, replyChatJid(message)].filter((jid): jid is string => Boolean(jid)))]
  const rows = await deps.store.listRecentMessages(jids, HISTORY_TURNS * 3)
  const at = rows.findIndex((row) => row.id === message.id)
  let before = at >= 0 ? rows.filter((row, index) => index < at || (index > at && Boolean(row.body?.startsWith(TIERRA_HEADER)))) : rows
  if (at < 0) {
    // not registered (yet): drop a trailing copy of it, as before
    const last = before.at(-1)
    if (last && !last.body?.startsWith(TIERRA_HEADER) && (last.body ?? '').trim() === text) before = before.slice(0, -1)
  }
  return before.slice(-HISTORY_TURNS).flatMap((row): LlmMessage[] => {
    const body = row.body?.trim()
    if (!body) return []
    if (body.startsWith(TIERRA_HEADER)) return [{ role: 'assistant', content: tierraReplyText(body).slice(0, 1500) }]
    return [{ role: 'user', content: body.slice(0, 1500) }]
  })
}

function speakerLabel(audience: Audience, speaker: Person | null): string {
  if (audience.kind === 'internal') return `${audience.name} (${audience.role})`
  if (audience.kind === 'party') return `a member of ${audience.name}'s group${speaker ? ` (${speaker.name})` : ''}`
  return 'an unknown WhatsApp number'
}

/**
 * Runs the queued side effects that change records (tasks, receipts) before the reply; returns a line for each that
 * could not be done (or, for a receipt, what was recorded). Files go after the reply: see sendEffectFiles.
 */
export async function runEffects(deps: AgentDeps, effects: Effect[], actor: Person | null, via: TaskVia = 'whatsapp'): Promise<string[]> {
  const problems: string[] = []
  for (const effect of effects) {
    try {
      if (effect.kind === 'create_task') {
        await createTaskAndNotify(deps, effect.input)
      } else if (effect.kind === 'complete_task' && actor) {
        const task = await deps.store.getTask(effect.taskId)
        if (task && isOpenTask(task)) await completeTask(deps, task, actor)
      } else if (effect.kind === 'record_receipt' && actor) {
        problems.push((await recordReceipt(deps, effect.lines, actor, via)).text)
      } else if (effect.kind === 'set_daily_inputs' && actor) {
        await deps.store.saveDailyInputs(effect.date, effect.patch, { userId: actor.userId, at: deps.now() })
      }
    } catch (error) {
      if (!(error instanceof UnknownAssigneeError)) console.error('An agent side effect failed', error)
      problems.push(
        effect.kind === 'create_task'
          ? `(The task "${effect.input.title}" could not be added.)`
          : effect.kind === 'complete_task'
            ? `(“${effect.title}” could not be marked done.)`
            : effect.kind === 'set_daily_inputs'
              ? '(The daily report inputs could not be saved.)'
              : '(That could not be recorded.)',
      )
    }
  }
  return problems
}

/** send_so_pdf: the latest customer copy of the TSO (and the internal annex when asked) into the asking chat. */
export async function sendEffectFiles(deps: AgentDeps, message: IncomingMessage, effects: Effect[], requestedBy: string | null = null): Promise<void> {
  for (const effect of effects) {
    if (effect.kind === 'send_daily_report') {
      try {
        await deliverReport(deps, message, await generateDailyReport(deps, { date: effect.date, userId: requestedBy }))
      } catch (error) {
        console.error('Could not send the daily report', error)
        await sendBotText(deps, message, 'The daily report could not be sent. Try again.').catch(() => undefined)
      }
      continue
    }
    if (effect.kind === 'send_file') {
      try {
        await deliverFile(deps, message, effect)
      } catch (error) {
        console.error('Could not send a SAP file', error)
        await sendBotText(deps, message, `${effect.file.fileName} could not be sent. Try again.`).catch(() => undefined)
      }
      continue
    }
    if (effect.kind !== 'send_so_pdf') continue
    try {
      const order = await deps.store.getSalesOrder(effect.salesOrderId)
      if (!order) continue
      const documents = (await deps.store.listDocuments('sales_order', order.id)).filter((doc) => doc.version === order.version)
      const pdf =
        documents.find((doc) => doc.kind === 'so_pdf' && doc.filename.endsWith('-approved.pdf')) ??
        documents.find((doc) => doc.kind === 'so_pdf')
      const wanted = [pdf, effect.annex ? documents.find((doc) => doc.kind === 'so_annex') : undefined].filter(
        (doc): doc is NonNullable<typeof doc> => Boolean(doc),
      )
      if (!wanted.length) {
        await sendBotText(deps, message, `${order.docNo} has no PDF yet.`)
        continue
      }
      for (const doc of wanted) {
        const stored = await deps.store.getDocument(doc.id)
        if (!stored) continue
        const caption = doc.kind === 'so_annex' ? `Internal annex for ${order.docNo}. Not for the customer.` : `${order.docNo} (version ${order.version})`
        const chat = replyChatJid(message)
        if (isDeskThread(chat)) {
          await postToDesk(deps.store, chat, ensureTierraPrefix(`${caption}: /api/documents/${doc.id}`), { subjectType: 'sales_order', subjectId: order.id })
          continue
        }
        await sendDocument(
          deps,
          { number: deliveryAddress(chat), remoteJid: chat },
          { content: stored.content, fileName: doc.filename, caption },
          { purpose: 'so_pdf', subjectType: 'sales_order', subjectId: order.id },
        )
      }
    } catch (error) {
      console.error('Could not send the sales order PDF', error)
      await sendBotText(deps, message, 'The PDF could not be sent. Try again.').catch(() => undefined)
    }
  }
}

export type AnswerInput = {
  message: IncomingMessage
  speaker: Person | null
  audience: Audience
  text: string
  quotedText: string | null
}

/** The pre-resolver and the tool loop for one message. Exported for the eval and the tests. */
export async function answerTurn(deps: AgentDeps, input: AnswerInput): Promise<LoopResult> {
  const { message, audience } = input
  const dataAsOf = (await importMeta(deps.sapSql)).dataAsOf
  const referenceDay = dataAsOf ?? istToday(deps.now())
  // an employee code (TF905, TFL0999) in a payroll question is a person, not invoice TF/26-27/5
  const refText = [input.text, input.quotedText ?? ''].join('\n')
  const refs = await resolveRefs(deps, isHrQuestion(refText) ? withoutEmployeeCodes(refText) : refText, audience, referenceDay)
  const pin = audience.kind === 'internal' ? await freshPin(deps, message) : null
  const ctx: ToolContext = {
    deps,
    audience,
    cards: cardsFor(audience),
    dataAsOf,
    referenceDay,
    messageId: message.id,
    question: input.text,
    via: isDeskThread(message.remoteJid) ? 'desk' : 'whatsapp',
    effects: [],
    pin: pin ? { subjectType: pin.subjectType, subjectId: pin.subjectId } : null,
    lastDocument: audience.kind === 'public' ? null : await lastDocumentFor(deps, message),
    concerned: [],
  }
  const result = await runLoop({
    model: deps.chatModel,
    system: systemPrompt({ audience, dataAsOf, now: deps.now() }),
    history: await recentTurns(deps, message, input.text),
    user: userTurn({
      text: input.text,
      quotedText: input.quotedText,
      speakerLabel: speakerLabel(audience, input.speaker),
      references: describeRefs(refs),
      pinned: await pinnedSubject(deps, pin, audience),
    }),
    tools: toolsFor(audience),
    ctx,
    budgetMs: deps.agentBudgetMs,
  })
  const hrTurn = result.toolRuns.some((run) => HR_TOOLS.has(run.name))
  if (result.status === 'answered' && audience.kind !== 'public' && !hrTurn) {
    // the attachment rule: an answer about one or two specific documents carries their main file
    const notes = await applyAttachmentRule(deps, ctx, refs)
    result.text = withNotes(result.text, notes)
    result.effects = ctx.effects
  }
  console.log(
    `agent turn ${message.id}: ${audience.kind}, ${result.status} after ${result.rounds} round(s), tools [${result.toolRuns
      .map((run) => run.name)
      .join(', ')}]`,
  )
  return result
}

/** An unmapped group that mentions the bot: one polite line, and (once per group) an office task to map it. */
async function unmappedGroup(
  deps: AgentDeps,
  message: IncomingMessage,
  speaker: Person | null,
  accounts: AccountLink[],
): Promise<string> {
  await raiseMapGroupTask(deps, message.remoteJid, speaker, accounts)
  return sendBotText(deps, message, UNMAPPED_GROUP)
}

export async function routeMessage(
  deps: AgentDeps,
  message: IncomingMessage,
  chatKind: ChatKind,
  desk?: DeskContext,
): Promise<string | null> {
  const [accounts, connection] = await Promise.all([deps.store.listAccountLinks(), deps.store.getWhatsapp()])
  const people = resolvePeople(message, chatKind, accounts, connection.phoneNumber)
  const speaker = desk?.speaker ?? people.speaker

  if (message.reaction) {
    const approval = await handleApprovalReaction(deps, message, speaker)
    if (approval !== undefined) return approval
    return handleReaction(deps, message, speaker)
  }

  if (!isDeskThread(message.remoteJid)) {
    await deps.evolution.sendReaction(message.remoteJid, message.id, message.fromMe, READ_EMOJI).catch(() => undefined)
  }
  await pinQuotedSubject(deps, message)

  if (message.pdf) {
    return intakePdf(deps, { message, chatKind, speaker, accounts, documentId: desk?.documentId })
  }

  const text = message.text?.trim() ?? ''
  const finished = await handleDoneReply(deps, message, chatKind, speaker, text)
  if (finished !== undefined) return finished
  if (speaker && chatKind !== 'group' && TEST_PDF.test(text)) return sendTestPdf(deps, message)
  if (speaker && chatKind !== 'group' && PROCEED.test(text)) return handleProceed(deps, message, speaker, text)
  const command = await handleOrderCommand(deps, message, chatKind, speaker, text)
  if (command !== undefined) return command
  const reportCommand = await handleReportCommand(deps, message, chatKind, speaker, text)
  if (reportCommand !== undefined) return reportCommand
  const hrCommand = await handleHrCommand(deps, message, chatKind, speaker, text)
  if (hrCommand !== undefined) return hrCommand
  const decided = await handleApprovalText(deps, message, chatKind, speaker, text)
  if (decided !== undefined) return decided

  const quotedText = message.quotedText?.trim() || null
  if (!text && !quotedText) return chatKind === 'group' ? null : sendBotText(deps, message, HERE)

  const audience = await buildAudience(deps, { chatKind, remoteJid: message.remoteJid, speaker })
  if (audience.kind === 'public' && audience.reason === 'unmapped_group') {
    return unmappedGroup(deps, message, speaker, accounts)
  }
  const result = await answerTurn(deps, { message, speaker, audience, text, quotedText })
  // only what the person asked for in this message: text the model read can never record stock or finish a task
  const gated = gateEffects(result.effects, text, deps.now())
  const problems = await runEffects(deps, gated.allowed, speaker, isDeskThread(message.remoteJid) ? 'desk' : 'whatsapp')
  const sent = await sendBotText(deps, message, [result.text, ...gated.refused, ...problems].join('\n\n'), [], undefined, AGENT_REPLY)
  await sendEffectFiles(deps, message, gated.allowed, speaker?.userId ?? null)
  return sent
}
