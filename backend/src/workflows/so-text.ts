import type { Approval, CustomerPo, InventoryCheck, InventoryCheckLine, ProcurementRequest, SalesOrder } from '../db/types'
import { componentLine, inr, qty, shortDay, VERDICT_LABEL, type PoSourceText } from './po-text'

/** Plain WhatsApp / task text for the PO -> TSO -> approval flow. */

function unit(line: Pick<InventoryCheckLine, 'uom'>): string {
  return line.uom ? ` ${line.uom}` : ''
}

export function makeText(check: InventoryCheck): string[] {
  return check.lines
    .filter((line) => line.kind === 'fg' && (line.toMake ?? 0) > 0)
    .map((line) => `${qty(line.toMake ?? 0)} × ${line.itemCode}`)
}

/** Components short now but covered by open purchase orders, Tierra's own. */
export function expediteLines(check: InventoryCheck): InventoryCheckLine[] {
  return check.lines.filter((line) => line.kind === 'component' && line.checked && line.status === 'short_now' && line.owner === 'tierra')
}

/** Components short even after open purchase orders, Tierra's own (to buy). */
export function shortageLines(check: InventoryCheck): InventoryCheckLine[] {
  return check.lines.filter((line) => line.kind === 'component' && line.checked && line.status === 'short' && line.owner === 'tierra')
}

/** Customer-supplied components that are short: Tierra never buys them; the customer is asked. */
export function customerShortLines(check: InventoryCheck): InventoryCheckLine[] {
  return check.lines.filter(
    (line) => line.kind === 'component' && line.checked && line.status !== 'ok' && (line.owner === 'customer' || line.owner === 'customer_unknown'),
  )
}

export function procurementTaskTitle(order: SalesOrder, check: InventoryCheck): string {
  const expedite = expediteLines(check).map((line) => `${line.itemCode} (${qty(line.shortNow)}${unit(line)} short now)`)
  const make = makeText(check)
  if (!expedite.length && !make.length) {
    const fromStock = order.lines.map((line) => `${qty(line.pcs)} × ${line.itemCode}`).join(', ')
    return `Reserve/dispatch from FG01: ${fromStock} (no purchase needed) — ${order.docNo}`
  }
  const parts = [expedite.length ? `expedite ${expedite.join(', ')}` : null, make.length ? `make ${make.join(' + ')}` : null]
  return `Complete procurement for ${order.docNo} — ${parts.filter(Boolean).join('; ')}`
}

function materialRow(line: InventoryCheckLine): string {
  return `• ${componentLine(line)}`
}

export function procurementTaskDescription(order: SalesOrder, po: CustomerPo | null, check: InventoryCheck, party: string): string {
  const out: string[] = [
    `${order.docNo} for ${party} (PO ${order.customerPoNo ?? '—'}, delivery ${shortDay(order.deliveryDate)}), ${inr(order.total)}.`,
  ]
  const fromStock = order.lines.filter((line) => line.reservedPcs > 0).map((line) => `${qty(line.reservedPcs)} × ${line.itemCode}`)
  if (fromStock.length) out.push(`From FG01 stock (reserved): ${fromStock.join(', ')}.`)
  const make = check.lines.filter((line) => line.kind === 'fg' && (line.toMake ?? 0) > 0)
  if (make.length) out.push(`Make: ${make.map((line) => `${qty(line.toMake ?? 0)} × ${line.itemCode} (FG01 free ${qty(line.free)})`).join(', ')}.`)
  const expedite = expediteLines(check)
  if (expedite.length) out.push('Expedite (short now, on open purchase orders):', ...expedite.map(materialRow))
  const customer = customerShortLines(check)
  if (customer.length) out.push('Customer-supplied, not to be bought (a follow-up task asks the customer):', ...customer.map(materialRow))
  if (po?.notes.length) out.push(`Buyer notes: ${po.notes.length} (on the PO page).`)
  return out.join('\n')
}

export function shortHoldTitle(po: CustomerPo, check: InventoryCheck, party: string): string {
  const short = shortageLines(check).map((line) => `${line.itemCode} ${qty(line.shortAfterIncoming)}${unit(line)}`)
  const expedite = expediteLines(check).map((line) => line.itemCode)
  const parts = [
    short.length ? `short ${short.join(', ')} after incoming` : null,
    expedite.length ? `expedite ${expedite.join(', ')}` : null,
  ]
  return `Procure for PO ${po.poNo ?? '(no number)'} (${party}) — ${parts.filter(Boolean).join('; ')}`
}

export function shortHoldDescription(po: CustomerPo, check: InventoryCheck, party: string): string {
  const out = [
    `PO ${po.poNo ?? '—'} of ${party} (delivery ${shortDay(po.deliveryDate)}, ${inr(po.total)}) is on hold: verdict ${VERDICT_LABEL[check.verdict]}. No sales order until it passes.`,
  ]
  const short = shortageLines(check)
  if (short.length) out.push('Short even after open purchase orders:', ...short.map(materialRow))
  const expedite = expediteLines(check)
  if (expedite.length) out.push('Short now, on open purchase orders (expedite):', ...expedite.map(materialRow))
  const example = [...short, ...expedite][0]
  out.push(
    `As material arrives, reply like "received ${example ? `${qty(Math.ceil(example.shortAfterIncoming || example.shortNow))}${unit(example)} ${example.itemCode}` : '20 kg <item code>'}" (recorded as unposted until the GRN is in SAP).`,
    'Reply *done* to this task when procurement is complete: the PO is checked again and, if it passes, the sales order is raised.',
  )
  return out.join('\n')
}

export function customerFollowupTitle(po: CustomerPo, check: InventoryCheck, ownerLabel: string): string {
  const items = customerShortLines(check).map((line) => `${line.itemCode} ${qty(line.shortNow)}${unit(line)}`)
  return `Ask ${ownerLabel} for ${items.join(', ')} (customer-supplied) — PO ${po.poNo ?? '(no number)'}`
}

export function customerFollowupDescription(po: CustomerPo, check: InventoryCheck, ownerLabel: string): string {
  return [
    `These materials belong to ${ownerLabel}; Tierra does not buy them. Ask ${ownerLabel} to send them for PO ${po.poNo ?? '—'}.`,
    ...customerShortLines(check).map(materialRow),
    'Reply *done* when they are in: the PO is checked again.',
  ].join('\n')
}

export type ApprovalSummaryInput = {
  order: SalesOrder
  po: CustomerPo | null
  check: InventoryCheck | null
  approval: Approval
  cardName: string | null
  procurementHolder: string | null
  group: string | null
  /** The admin's note on the version this one replaces. */
  revisedAfter?: string | null
  /** Where the PO came from (S2), with its warning when the sender or group is not to be trusted. */
  source?: PoSourceText | null
  /** Not blocking, worth a look: the TSO total differs from the PO's, and the like. */
  warnings?: string[]
}

/** The admin's approval request: what the SO is, the money, the check and how to answer. */
export function approvalSummary(input: ApprovalSummaryInput): string {
  const { order, po, check } = input
  const out: string[] = [
    `Approve sales order *${order.docNo}*${order.version > 1 ? ` (version ${order.version})` : ''}`,
    `${order.partyName ?? order.cardCode} · ${order.cardCode}${input.cardName ? ` ${input.cardName}` : ''}${order.siteCode ? ` · site ${order.siteCode}` : ''}`,
    `PO ${order.customerPoNo ?? '—'} of ${shortDay(order.poDate)} · delivery ${shortDay(order.deliveryDate)}${order.deliveryTerm ? ` · ${order.deliveryTerm.split(/\s+-\s+/)[0]}` : ''}`,
    ...(input.source ? [input.source.line, ...(input.source.warning ? [input.source.warning] : [])] : []),
    ...(input.revisedAfter ? [`Revised after your note: “${input.revisedAfter}”`] : []),
    '',
  ]
  for (const line of order.lines) {
    const units = line.cartons != null && line.uom ? ` (${qty(line.cartons)} ${line.uom})` : ''
    const source = line.toMake > 0 ? (line.reservedPcs > 0 ? `${qty(line.reservedPcs)} from stock, make ${qty(line.toMake)}` : `make ${qty(line.toMake)}`) : 'from stock'
    out.push(`${line.lineNo}. ${line.itemCode} × ${qty(line.pcs)} pcs${units} @ ₹${piecePrice(line.unitPrice)} = ${inr(line.amount)} — ${source}`)
  }
  const gst = order.taxKind === 'igst' ? `IGST ${inr(order.igst)}` : `CGST ${inr(order.cgst)} + SGST ${inr(order.sgst)}`
  const taxes = order.cess > 0 ? `${gst} + cess ${inr(order.cess)}` : gst
  out.push('', `Total *${inr(order.total)}* (${inr(order.basicTotal)} + ${taxes})`)
  for (const warning of input.warnings ?? []) out.push(`⚠ ${warning}`)
  if (check) {
    const expedite = expediteLines(check).map((line) => line.itemCode)
    const why = check.verdict === 'pass_with_incoming' && expedite.length ? ` — ${expedite.join(', ')} arrive on open purchase orders` : ''
    out.push(`Check: ${VERDICT_LABEL[check.verdict]}${why}.${input.procurementHolder ? ` Procurement task: ${input.procurementHolder}.` : ''}`)
  }
  if (po?.repeatOf.length) out.push(`Repeat PO: ${po.repeatOf.map((hit) => hit.docNo).join(', ')} (you said *proceed*).`)
  if (input.approval.selfRaised) out.push('Note: you sent this PO yourself, so your approval is recorded as self-approved.')
  out.push(
    '',
    `React 👍 or reply *approve* to approve${input.group ? ` (the customer copy then goes to *${input.group}*)` : ''}. Reply *send back: <note>* to send it back. Ask anything about it here.`,
    'The internal annex (availability check) follows; it never goes to the customer.',
  )
  return out.join('\n')
}

export function approvedEcho(
  order: SalesOrder,
  group: string | null,
  windowSeconds: number,
  selfRaised: boolean,
  switchedOff: string | null = null,
): string {
  const tail = selfRaised ? ' (Recorded as self-approved.)' : ''
  if (!group && switchedOff) {
    return `Approved ${order.docNo}. Sales orders are switched off for *${switchedOff}*, so nothing goes to the customer.${tail}`
  }
  if (!group) {
    return `Approved ${order.docNo}. No WhatsApp group is mapped for ${order.partyName ?? order.cardCode}, so nothing goes to the customer; the office has a task to map one and send it by hand.${tail}`
  }
  return `Approved ${order.docNo} — sending page to *${group}* in ${windowSeconds} s. Reply *stop* to cancel.${tail}`
}

/** "36.2743" stays, "157.7000" -> "157.70". */
export function piecePrice(value: number): string {
  const fixed = value.toFixed(4)
  return fixed.endsWith('00') ? value.toFixed(2) : fixed.replace(/0$/, '')
}
