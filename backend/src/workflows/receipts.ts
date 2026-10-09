import type { AgentDeps } from '../agent/deps'
import type { StockAdjustment, TaskVia } from '../db/types'
import { unitFits, type ReceiptLine } from '../domain/receipts'
import { itemFacts } from '../queries/po'
import { qty } from './po-text'

/**
 * Records material that arrived before SAP has its GRN, as active stock adjustments ("unposted"). The inventory
 * check counts them as free stock until they are absorbed (the GRN shows up in an import).
 */
export async function recordReceipt(
  deps: Pick<AgentDeps, 'store' | 'sapSql'>,
  lines: ReceiptLine[],
  actor: { userId: string },
  via: TaskVia,
): Promise<{ recorded: StockAdjustment[]; problems: string[]; text: string }> {
  const problems: string[] = []
  const recorded: StockAdjustment[] = []
  if (lines.length === 0) {
    return { recorded, problems, text: 'Say what arrived like "received 20 kg <item code>, 160 kg <item code>".' }
  }
  const facts = await itemFacts(deps.sapSql, lines.map((line) => line.itemCode)).catch(() => ({}) as Awaited<ReturnType<typeof itemFacts>>)
  const open = (await deps.store.listOpenTasksForUser(actor.userId)).filter(
    (task) => task.kind === 'procurement' || task.kind === 'customer_followup',
  )
  for (const line of lines) {
    const item = facts[line.itemCode]
    if (!item) {
      problems.push(`${line.itemCode} is not an item in SAP.`)
      continue
    }
    if (!(line.qty > 0)) {
      problems.push(`${line.itemCode}: the quantity must be more than 0.`)
      continue
    }
    if (!unitFits(line.unit, item.uom)) {
      problems.push(`${line.itemCode} is counted in ${item.uom} in SAP, not ${line.unit}.`)
      continue
    }
    const task = open.find((row) => `${row.title} ${row.description ?? ''}`.includes(line.itemCode)) ?? null
    recorded.push(
      await deps.store.createStockAdjustment({
        itemCode: line.itemCode,
        qty: line.qty,
        uom: item.uom ?? line.unit,
        reason: 'receipt_unposted',
        note: `Recorded as received; not in SAP until the GRN is posted.`,
        taskId: task?.id ?? null,
        createdBy: actor.userId,
        createdVia: via,
      }),
    )
  }
  const parts: string[] = []
  if (recorded.length) {
    parts.push(
      `Recorded as received (unposted until the GRN is in SAP): ${recorded
        .map((row) => `${qty(row.qty)}${row.uom ? ` ${row.uom}` : ''} ${row.itemCode}`)
        .join(', ')}.`,
    )
    if (open.length) parts.push('When procurement is complete, reply *done* to the procurement task: the PO is checked again.')
  }
  parts.push(...problems)
  return { recorded, problems, text: parts.join('\n') }
}
