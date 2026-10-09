import type { CheckVerdict, CustomerPo, InventoryCheck, InventoryCheckLine, RepeatHit } from '../db/types'

/** Plain WhatsApp text for PO intake: the admin's summary and the check table. */

const quantity = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })
const fine = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 4 })
const rupees = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function qty(value: number): string {
  const text = Math.abs(value) > 0 && Math.abs(value) < 0.01 ? fine.format(value) : quantity.format(value)
  return text.replace(/^-/, '−')
}

export function inr(value: number | null): string {
  return value == null ? '—' : `₹${rupees.format(value)}`
}

/** 2026-07-16 -> 16-Jul */
export function shortDay(iso: string | null): string {
  if (!iso) return '—'
  const [, m, d] = iso.split('-')
  return `${d}-${MONTHS[Number(m) - 1] ?? m}`
}

export const VERDICT_LABEL: Record<CheckVerdict, string> = {
  pass: 'pass',
  pass_with_incoming: 'pass with incoming',
  fail: 'fail',
}

const ROLE_LABEL: Record<string, string> = {
  laminate: 'Laminate',
  carton: 'Carton',
  seasoning: 'Seasoning',
  raw_banana: 'Banana',
  raw_cassava: 'Cassava',
  oil: 'Oil',
  tape: 'Tape',
  consumable: 'Consumable',
}

function amountWithUnit(value: number, uom: string | null): string {
  return uom ? `${qty(value)} ${uom}` : qty(value)
}

/** "Carton ZPMCN5 12 nos: free 8, short 4 now, covered by 500 on order (PO/25-26/3)" */
export function componentLine(line: InventoryCheckLine): string {
  const head = `${ROLE_LABEL[line.role ?? ''] ?? 'Item'} ${line.itemCode} ${amountWithUnit(line.need, line.uom)}${line.estimated ? ' (estimated)' : ''}`
  const owner = line.owner === 'customer' ? ` [${line.ownerName ?? line.ownerCardCode}'s material]` : line.owner === 'customer_unknown' ? ' [customer-supplied]' : ''
  const incoming = line.incoming.length ? ` (${line.incoming.slice(0, 2).join(', ')})` : ''
  if (line.status === 'ok') return `${head}: OK, free ${qty(line.free)}${owner}`
  if (line.status === 'short_now') {
    return `${head}: free ${qty(line.free)}, short ${qty(line.shortNow)} now, covered by ${qty(line.onOrder)} on order${incoming}${owner}`
  }
  const after = line.onOrder > 0 ? `, still short ${qty(line.shortAfterIncoming)} after ${qty(line.onOrder)} on order${incoming}` : ', nothing on order'
  return `${head}: free ${qty(line.free)}, short ${qty(line.shortNow)}${after}${owner}`
}

export function fgLine(line: InventoryCheckLine): string {
  const name = line.itemCode
  if (line.status === 'short') return `${name}: ${qty(line.need)} pcs, make ${qty(line.toMake ?? 0)} but there is no BOM in SAP`
  if ((line.toMake ?? 0) <= 0) return `${name}: ${qty(line.need)} pcs from stock (${qty(line.free)} free)`
  if ((line.fromStock ?? 0) > 0) {
    return `${name}: ${qty(line.need)} pcs, ${qty(line.fromStock ?? 0)} from stock, make ${qty(line.toMake ?? 0)} (${qty(line.free)} free)`
  }
  return `${name}: ${qty(line.need)} pcs, make ${qty(line.toMake ?? 0)} (free ${qty(line.free)})`
}

/** The check as WhatsApp lines: materials checked, then warnings, then the verdict. */
export function checkText(check: InventoryCheck, options: { includeFg?: boolean } = {}): string[] {
  const out: string[] = []
  const fg = check.lines.filter((line) => line.kind === 'fg')
  if (options.includeFg) out.push(...fg.map((line) => `• ${fgLine(line)}`))
  const checked = check.lines.filter((line) => line.kind === 'component' && line.checked)
  const warned = check.lines.filter((line) => line.kind === 'component' && !line.checked)
  const making = fg.filter((line) => (line.toMake ?? 0) > 0 && line.status !== 'short')
  if (making.length) {
    out.push(`Materials to make ${making.map((line) => `${qty(line.toMake ?? 0)} ${line.itemCode}`).join(' + ')}:`)
    out.push(...checked.map((line) => `• ${componentLine(line)}`))
  } else if (fg.length) {
    out.push('Everything comes from finished stock; no materials needed.')
  }
  const shortWarnings = warned.filter((line) => line.status !== 'ok')
  if (shortWarnings.length) out.push(`Warnings: ${shortWarnings.map((line) => componentLine(line)).join('; ')}`)
  for (const warning of check.warnings) out.push(`Note: ${warning}`)
  out.push(`Verdict: *${VERDICT_LABEL[check.verdict]}*${verdictWhy(check)}`)
  return out
}

function verdictWhy(check: InventoryCheck): string {
  const decisive = check.lines.filter((line) => line.checked && line.kind === 'component')
  if (check.verdict === 'pass_with_incoming') {
    const codes = decisive.filter((line) => line.status === 'short_now').map((line) => line.itemCode)
    return ` (${codes.join(', ')} arrive on open purchase orders)`
  }
  if (check.verdict === 'fail') {
    const codes = check.lines.filter((line) => line.checked && line.status === 'short').map((line) => line.itemCode)
    return ` (${codes.join(', ')} short even after open purchase orders)`
  }
  return ''
}

export function repeatText(hits: RepeatHit[]): string {
  const parts = hits.map((hit) => {
    if (hit.source === 'sap') {
      const invoiced = hit.invoices.length ? `, invoiced ${hit.invoices.join(', ')}` : hit.status === 'cancelled' ? ', cancelled' : ''
      return `SAP ${hit.docNo} of ${shortDay(hit.docDate)}${invoiced}`
    }
    return `the PO already received here on ${shortDay(hit.docDate)} (${hit.status.replace(/_/g, ' ')})`
  })
  return `Repeat: matches ${parts.join('; ')}.`
}

/** Where a PO came from, as the admin reads it: "From: group …", "From: Anju (DM)", "From: unknown number +91…". */
export type PoSourceText = { line: string; warning: string | null }

export type SourceFacts = {
  po: Pick<CustomerPo, 'sourceChat' | 'sourceSender' | 'raisedBy' | 'partyGroupId'>
  /** The WhatsApp group it came from, when it came from a group. */
  group: { subject: string | null; partyGroupId: string | null } | null
  /** The names of the group's party and of the PO's party, for a mismatch. */
  groupParty: string | null
  poParty: string | null
}

/**
 * The PO's source line and, when it deserves the admin's eye, a warning: a sender who is not a Tierra account, a
 * group not linked to a customer, or a group linked to a different customer than the PO names.
 */
export function poSourceText({ po, group, groupParty, poParty }: SourceFacts): PoSourceText | null {
  const chat = po.sourceChat
  if (!chat) return null
  if (chat.endsWith('@g.us')) {
    const line = `From: group ${group?.subject ?? chat}`
    if (!group?.partyGroupId) return { line, warning: '⚠ That group is not linked to a customer.' }
    if (po.partyGroupId && po.partyGroupId !== group.partyGroupId) {
      return { line, warning: `⚠ That group belongs to ${groupParty ?? 'another customer'}, but this PO is for ${poParty ?? 'a different customer'}.` }
    }
    return { line, warning: null }
  }
  const who = po.sourceSender ?? 'someone'
  if (chat.startsWith('desk:')) return { line: `From: ${who} (desk)`, warning: null }
  if (po.raisedBy) return { line: `From: ${who} (DM)`, warning: null }
  return {
    line: `From: unknown number ${who}`,
    warning: '⚠ Not a Tierra account: nothing is raised for this PO until the office confirms it.',
  }
}

export type SummaryInput = {
  po: CustomerPo
  check: InventoryCheck | null
  partyLabel: string | null
  cardName: string | null
  /** onPoChecked's note, or the reason it stopped. */
  next: string | null
  /** Where it came from (S2): always shown, with a warning when the sender or group is not trusted. */
  source?: PoSourceText | null
}

/** The admin's summary of a received PO. */
export function adminSummary({ po, check, partyLabel, cardName, next, source }: SummaryInput): string {
  const who = [partyLabel, shortDay(po.poDate), inr(po.total)].filter((part) => part && part !== '—').join(', ')
  const ship =
    po.cardCode && po.siteCode
      ? `, ship-to ${po.siteCode} → ${po.cardCode}${cardName ? ` ${cardName}` : ''}`
      : po.cardCode
        ? `, customer ${po.cardCode}${cardName ? ` ${cardName}` : ''}`
        : ''
  const out: string[] = [`PO ${po.poNo ?? '(no number)'} (${who})${ship}. Delivery ${shortDay(po.deliveryDate)}.`]
  if (source) out.push(source.line, ...(source.warning ? [source.warning] : []))
  if (po.repeatOf.length) {
    out.push(`${repeatText(po.repeatOf)}${po.status === 'awaiting_proceed' ? ' Reply *proceed* to go ahead anyway.' : ''}`)
  }
  if (po.status === 'needs_review' && po.reviewReason) out.push(`Needs review: ${po.reviewReason} The office has a task.`)
  out.push('')
  po.lines.forEach((line) => {
    const fg = check?.lines.find((row) => row.kind === 'fg' && row.itemCode === line.itemCode)
    const units = line.pcs != null && line.pcsSource !== 'pcs' ? `${qty(line.qty)} ${line.uom ?? ''} = ${qty(line.pcs)} pcs` : `${qty(line.pcs ?? line.qty)} pcs`
    const target = line.itemCode ? `${line.articleNo ?? line.description} → ${line.itemCode}` : `${line.articleNo ?? ''} ${line.description}`.trim()
    const stock = fg
      ? (fg.toMake ?? 0) <= 0
        ? `, from stock (${qty(fg.free)} free)`
        : (fg.fromStock ?? 0) > 0
          ? `, ${qty(fg.fromStock ?? 0)} from stock, make ${qty(fg.toMake ?? 0)}`
          : `, make ${qty(fg.toMake ?? 0)} (free ${qty(fg.free)})`
      : ''
    const note = line.note ? ` [${line.note}]` : ''
    out.push(`${line.lineNo}. ${target}: ${units}${stock}${note}`)
  })
  if (check) {
    out.push('')
    out.push(...checkText(check))
  }
  if (po.notes.length) out.push('', `Buyer notes: ${po.notes.length} (on the PO page in the dashboard).`)
  if (next) out.push('', next)
  return out.join('\n')
}
