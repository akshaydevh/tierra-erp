import type { TaskRecord } from '../db/types'
import type { Store } from '../db/store'
import { renderTestPdf } from '../pdf/test-doc'
import { canFinish, isDoneEmoji, isDoneText, isOpenTask } from '../tasks/done'
import { completeTask } from '../tasks/service'
import type { Person } from '../whatsapp/people'
import { deliveryAddress, replyChatJid, type ChatKind, type IncomingMessage } from '../whatsapp/parse'
import type { AgentDeps } from './deps'
import { isDeskThread, sendBotText } from './outbox'
import { ensureTierraPrefix } from './send'

/** The deterministic turns that never reach the model: 👍 / *done* on task notices and *test pdf*. */

export const TEST_PDF = /^test\s+pdf[.!]?$/i

async function noticeTask(store: Store, messageId: string): Promise<TaskRecord | null> {
  const target = await store.findMessage(messageId)
  if (target?.purpose !== 'task_notice') return null
  return store.findTaskByMessage(messageId)
}

function finishedReply(task: TaskRecord): string {
  return `Marked "${task.title}" as done.`
}

/** A 👍 on a task notice by its holder (or the admin) finishes the task. Nothing else reacts. */
export async function handleReaction(
  deps: AgentDeps,
  message: IncomingMessage,
  speaker: Person | null,
): Promise<string | null> {
  const reaction = message.reaction
  if (!reaction || !speaker || !isDoneEmoji(reaction.emoji)) return null
  const task = await noticeTask(deps.store, reaction.targetId)
  if (!task || !isOpenTask(task) || !canFinish(task, speaker)) return null
  await completeTask(deps, task, speaker)
  return sendBotText(deps, message, finishedReply(task))
}

/**
 * *done* quoting a task notice, or a bare *done* in a DM from someone with one notified open task.
 * Returns undefined when the message is not about finishing a task.
 */
export async function handleDoneReply(
  deps: AgentDeps,
  message: IncomingMessage,
  chatKind: ChatKind,
  speaker: Person | null,
  text: string,
): Promise<string | null | undefined> {
  if (!isDoneText(text)) return undefined
  if (message.quotedId) {
    const task = await noticeTask(deps.store, message.quotedId)
    if (!task) return undefined
    if (!speaker || !canFinish(task, speaker)) {
      return sendBotText(deps, message, `Only ${task.assigneeName ?? 'the task holder'} can mark "${task.title}" as done.`)
    }
    if (!isOpenTask(task)) return sendBotText(deps, message, `"${task.title}" is already ${task.status}.`)
    await completeTask(deps, task, speaker)
    return sendBotText(deps, message, finishedReply(task))
  }
  if (chatKind === 'group' || !speaker) return undefined
  // approval tasks close only by the approval itself, never by a bare *done*
  const open = (await deps.store.listOpenTasksForUser(speaker.userId)).filter((task) => task.notifiedAt && task.kind !== 'approval')
  if (open.length === 0) return undefined
  if (open.length > 1) {
    return sendBotText(
      deps,
      message,
      `You have ${open.length} open tasks. Reply *done* to the task's own message so I know which one is finished.`,
    )
  }
  const [task] = open
  await completeTask(deps, task!, speaker)
  return sendBotText(deps, message, finishedReply(task!))
}

export async function sendTestPdf(deps: AgentDeps, message: IncomingMessage): Promise<string> {
  const pdf = await renderTestPdf(deps.now())
  const size = `${Math.max(1, Math.round(pdf.length / 1024))} KB`
  const remoteJid = replyChatJid(message)
  if (isDeskThread(remoteJid)) return sendBotText(deps, message, `Test PDF rendered (${size}).`)
  const caption = ensureTierraPrefix(`Test document (${size})`)
  const sent = await deps.evolution.sendMedia({
    number: deliveryAddress(remoteJid),
    mediatype: 'document',
    mimetype: 'application/pdf',
    fileName: 'tierra-test.pdf',
    caption,
    media: pdf.toString('base64'),
  })
  if (sent.messageId) {
    await deps.store.claimMessage({
      evolutionMessageId: sent.messageId,
      remoteJid,
      fromMe: true,
      hasPdf: true,
      body: caption,
      kind: 'document',
      purpose: 'test_pdf',
      status: 'sent',
    })
  }
  return caption
}
