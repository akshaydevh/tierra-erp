import type { AgentDeps } from '../agent/deps'
import { CustomerPoRevisionTakenError } from '../db/store'
import type {
  CustomerPo,
  CustomerPoLine,
  CustomerPoStatus,
  InventoryCheck,
  InventoryCheckLine,
  NewInventoryCheck,
  PartyGroup,
  RepeatHit,
} from '../db/types'
import { computeCheck, type CheckFacts, type CheckRequest } from '../domain/po-check'
import {
  gramsIn,
  matchLine,
  panOf,
  partyGroupFor,
  piecesFor,
  resolveCustomer,
  type CustomerResolution,
  type HistoryHit,
} from '../domain/po-match'
import type { ExtractedPo, PoReader } from '../domain/po'
import { importMeta, isNotImported } from '../queries/meta'
import {
  bomRows,
  cardInfo,
  cardsByPoPrefix,
  cardsForGstin,
  customerItemHistory,
  fgByPackGrams,
  itemFacts,
  openPurchases,
  ownershipFor,
  sapOrdersForPo,
  stockTotals,
  usagePerPiece,
  type HistoryItem,
} from '../queries/po'
import { partyCardCodes } from '../agent/scope'
import { adminSummary, poSourceText, type PoSourceText } from './po-text'
import { queuePoProcess } from './po-to-so'

/**
 * PO intake v2 (plan §P3): resolve the customer, match the lines, detect a repeat, run the inventory check and
 * record it all. Where the result goes next is `onPoChecked`, the seam P4 replaces with "raise the sales order".
 */

type Deps = Pick<AgentDeps, 'store' | 'sapSql' | 'now'>
type FlowDeps = AgentDeps

const REVISION_RETRIES = 4

// ------------------------------------------------------------------------------------------- the check

/** Loads every SAP and app fact the check needs for these finished goods and their BOM components. */
export async function loadCheckFacts(deps: Deps, requested: CheckRequest[], dataAsOf: string | null): Promise<CheckFacts> {
  const fgCodes = [...new Set(requested.map((line) => line.itemCode))]
  const boms = await bomRows(deps.sapSql, fgCodes)
  const components = [...new Set(Object.values(boms).flat().map((row) => row.componentCode))]
  const codes = [...new Set([...fgCodes, ...components])]
  const [items, stock, ownership, incoming, overlays, overrides, usage] = await Promise.all([
    itemFacts(deps.sapSql, codes),
    stockTotals(deps.sapSql, codes),
    ownershipFor(deps.sapSql, components),
    openPurchases(deps.sapSql, components),
    deps.store.stockOverlays(codes),
    deps.store.listItemOwnerOverrides(),
    dataAsOf ? usagePerPiece(deps.sapSql, fgCodes, dataAsOf) : Promise.resolve({}),
  ])
  return { items, boms, stock, ownership, incoming, overlays, overrides, usage }
}

/** Customer-owned materials set by an override carry only a card code: give them the name people use. */
async function nameOwners(deps: Deps, lines: InventoryCheckLine[]): Promise<void> {
  const unnamed = [...new Set(lines.filter((line) => line.ownerCardCode && !line.ownerName).map((line) => line.ownerCardCode!))]
  if (!unnamed.length) return
  const [aliases, cards] = await Promise.all([
    deps.store.listPartyAliases(),
    cardInfo(deps.sapSql, unnamed).catch(() => ({}) as Awaited<ReturnType<typeof cardInfo>>),
  ])
  for (const line of lines) {
    if (!line.ownerCardCode || line.ownerName) continue
    line.ownerName = aliases.find((row) => row.cardCode === line.ownerCardCode)?.alias ?? cards[line.ownerCardCode]?.cardName ?? null
  }
}

/** Runs and stores a check: against a received PO, or a dry run from the agent. */
export async function runInventoryCheck(
  deps: Deps,
  requested: CheckRequest[],
  options: { customerPoId: string | null; kind: NewInventoryCheck['kind']; createdBy: string | null },
): Promise<InventoryCheck> {
  const dataAsOf = (await importMeta(deps.sapSql)).dataAsOf
  const facts = await loadCheckFacts(deps, requested, dataAsOf)
  const unknown = requested.filter((line) => !facts.items[line.itemCode]).map((line) => line.itemCode)
  const result = computeCheck(requested, facts)
  await nameOwners(deps, result.lines)
  return deps.store.saveInventoryCheck({
    customerPoId: options.customerPoId,
    kind: options.kind,
    verdict: unknown.length ? 'fail' : result.verdict,
    dataAsOf,
    warnings: [...unknown.map((code) => `${code} is not an item in SAP.`), ...result.warnings],
    requested,
    createdBy: options.createdBy,
    lines: result.lines,
  })
}

// ------------------------------------------------------------------------------------------- the customer

async function historyHits(deps: Deps, po: ExtractedPo, cards: string[]): Promise<HistoryHit[]> {
  const hits: HistoryHit[] = []
  if (po.siteCode) {
    const earlier = po.poNumber ? await deps.store.listCustomerPos({ limit: 500 }) : []
    for (const row of earlier) {
      if (row.siteCode?.toUpperCase() === po.siteCode.toUpperCase() && row.cardCode && row.poNo !== po.poNumber) {
        hits.push({ cardCode: row.cardCode, source: 'tierra_site', orders: 1 })
      }
    }
  }
  if (cards.length && po.poNumber) {
    for (const row of await cardsByPoPrefix(deps.sapSql, cards, po.poNumber)) {
      hits.push({ cardCode: row.cardCode, source: 'sap_po_prefix', orders: row.orders })
    }
  }
  return hits
}

export type ResolvedCustomer = {
  resolution: CustomerResolution
  partyGroup: PartyGroup | null
  /** Every SAP card of the party (for history and repeats); just the resolved card when there is no party. */
  partyCards: string[]
  cardName: string | null
  cardPan: string | null
}

/**
 * Who a PO is for. A PO from a group mapped to a party is only ever for that party: when the PO itself (its site,
 * GSTIN or address) names a card outside the party, or one that belongs to another party group, it goes to the
 * office (needs_review) and the card is not taken; the mapped party is never borrowed for a card outside it.
 */
export async function resolvePoCustomer(
  deps: Deps,
  po: ExtractedPo,
  mappedPartyGroupId: string | null,
  groupSubject: string | null = null,
): Promise<ResolvedCustomer> {
  const [sites, partyGroups] = await Promise.all([deps.store.listCustomerSites(), deps.store.listPartyGroups()])
  const mapped = mappedPartyGroupId ? (partyGroups.find((group) => group.id === mappedPartyGroupId) ?? null) : null
  const membersOf = async (group: PartyGroup | null): Promise<string[]> =>
    group
      ? partyCardCodes(
          deps.sapSql,
          group.members.filter((m) => m.kind === 'pan').map((m) => m.value),
          group.members.filter((m) => m.kind === 'card_code').map((m) => m.value),
        )
      : []
  const mappedCards = await membersOf(mapped)
  const candidates = po.shipToGstin ? await cardsForGstin(deps.sapSql, po.shipToGstin) : []
  const pool = [...new Set(candidates.map((row) => row.cardCode))]
  const history = await historyHits(deps, po, pool.length ? pool : mappedCards)
  let resolution = resolveCustomer({ po, sites, partyGroups, candidates, history, mappedPartyGroupId, mappedCards })
  if (mapped && resolution.status === 'resolved') {
    const named = resolution.cardCode
    const namedInfo = (await cardInfo(deps.sapSql, [named]))[named]
    const owner = partyGroupFor(partyGroups, named, namedInfo?.pan ?? null)
    const otherParty = (resolution.partyGroupId && resolution.partyGroupId !== mapped.id) || (owner && owner.id !== mapped.id)
    if (otherParty || !mappedCards.includes(named)) {
      resolution = {
        status: 'needs_review',
        reason: `PO from group ${groupSubject ?? 'of ' + (mapped.alias || mapped.name)} names customer ${namedInfo?.cardName ?? named} (${named}), which is not one of ${
          mapped.alias || mapped.name
        }'s cards${owner && owner.id !== mapped.id ? ` but ${owner.alias || owner.name}'s` : ''}.`,
        candidates: [named],
        partyGroupId: mapped.id,
      }
    }
  }
  const card = resolution.status === 'resolved' ? resolution.cardCode : null
  const info = card ? (await cardInfo(deps.sapSql, [card]))[card] : undefined
  const resolvedGroupId = resolution.partyGroupId
  // never the mapped party for a card outside it: the guard above has already sent such a PO to review
  const partyGroup =
    partyGroups.find((group) => group.id === resolvedGroupId) ??
    (card ? partyGroupFor(partyGroups, card, info?.pan ?? panOf(po.shipToGstin)) : null) ??
    (!card || mappedCards.includes(card) ? mapped : null)
  const partyCards = partyGroup ? await membersOf(partyGroup) : []
  return {
    resolution,
    partyGroup,
    partyCards: [...new Set([...partyCards, ...(card ? [card] : [])])],
    cardName: info?.cardName ?? null,
    cardPan: info?.pan ?? null,
  }
}

// ------------------------------------------------------------------------------------------- lines and repeats

async function matchLines(deps: Deps, po: ExtractedPo, customer: ResolvedCustomer): Promise<CustomerPoLine[]> {
  const refs = customer.partyGroup ? await deps.store.listCustomerItemRefs(customer.partyGroup.id) : []
  const history: HistoryItem[] = await customerItemHistory(deps.sapSql, customer.partyCards)
  const grams = [...new Set(po.lines.map((line) => gramsIn(line.description)).filter((value): value is number => value !== null))]
  const byGrams = Object.fromEntries(await Promise.all(grams.map(async (g) => [g, await fgByPackGrams(deps.sapSql, g)] as const)))
  const candidateCodes = [
    ...refs.map((ref) => ref.itemCode),
    ...history.map((item) => item.itemCode),
    ...Object.values(byGrams).flat().map((item) => item.itemCode),
  ]
  const facts = await itemFacts(deps.sapSql, [...new Set(candidateCodes)])
  return po.lines.map((line) => {
    const match = matchLine(line, { refs, history, byGrams, facts })
    return {
      lineNo: line.lineNo,
      articleNo: line.articleNo,
      ean: line.ean,
      description: line.description,
      hsn: line.hsn,
      qty: line.qty,
      uom: line.uom,
      eaQty: line.eaQty,
      mrp: line.mrp,
      baseCost: line.baseCost,
      gstPct: line.gstPct,
      taxAmount: line.taxAmount,
      cessAmount: line.cessAmount ?? null,
      lineTotal: line.lineTotal,
      deliveryDate: line.deliveryDate,
      ...match,
    }
  })
}

/** The India-time day of a timestamp. */
function istDay(iso: string): string {
  return new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10)
}

async function findRepeats(deps: Deps, po: ExtractedPo, customer: ResolvedCustomer): Promise<{ hits: RepeatHit[]; revision: number }> {
  const pan = customer.cardPan ?? panOf(po.shipToGstin)
  const cards = customer.partyCards.length ? customer.partyCards : null
  const sap = await sapOrdersForPo(deps.sapSql, po.poNumber, cards).catch((error: unknown) => {
    if (isNotImported(error)) return []
    throw error
  })
  const own = (await deps.store.findCustomerPosByNumber(po.poNumber)).filter((row) =>
    customer.partyGroup ? row.partyGroupId === customer.partyGroup.id : panOf(row.shipToGstin) === pan,
  )
  const hits: RepeatHit[] = [
    ...sap
      .filter((row) => row.status !== 'cancelled')
      .map((row) => ({
        source: 'sap' as const,
        docNo: row.docNo,
        docDate: row.docDate,
        cardCode: row.cardCode,
        status: row.status,
        invoices: row.invoices,
      })),
    ...own.map((row) => ({
      source: 'tierra' as const,
      docNo: `PO ${row.poNo} r${row.revision}`,
      docDate: istDay(row.createdAt),
      cardCode: row.cardCode,
      status: row.status,
      invoices: [],
      customerPoId: row.id,
    })),
  ]
  const revision = own.filter((row) => row.partyGroupId === (customer.partyGroup?.id ?? null)).reduce((max, row) => Math.max(max, row.revision), 0) + 1
  return { hits, revision }
}

// ------------------------------------------------------------------------------------------- intake

export type PoSource = {
  chatJid: string | null
  messageId: string | null
  /** Who sent it, as people read it: a name, a phone number, "the desk". */
  sender: string
  raisedBy: string | null
  documentId: string | null
  /** The party group of the WhatsApp group it came from, when that group is mapped. */
  mappedPartyGroupId: string | null
  /** The WhatsApp group's name, when it came from a group. */
  groupSubject?: string | null
  /** A direct chat from a number that is not a Tierra account: nothing is raised until the office confirms. */
  unknownSender?: boolean
}

/** Not a Tierra account in a direct chat: the PO is recorded and checked, but waits for the office. */
export function unknownSenderReason(sender: string): string {
  return `Sent by ${sender}, which is not a Tierra account: the office must confirm this PO before anything is raised.`
}

export type IntakeOutcome = {
  po: CustomerPo
  check: InventoryCheck | null
  /** The admin's summary (customer, lines, repeat, check, what happens next). */
  summary: string
  partyLabel: string | null
}

/** "From: group …" / "From: Anju (DM)" / "From: unknown number +91…", with a warning when it is not to be trusted. */
export async function describePoSource(deps: Pick<AgentDeps, 'store'>, po: CustomerPo): Promise<PoSourceText | null> {
  const group = po.sourceChat?.endsWith('@g.us') ? await deps.store.getWaGroup(po.sourceChat) : null
  const nameOf = async (id: string | null | undefined) => {
    if (!id) return null
    const party = await deps.store.getPartyGroup(id)
    return party ? party.alias || party.name : null
  }
  return poSourceText({
    po,
    group: group ? { subject: group.subject, partyGroupId: group.partyGroupId } : null,
    groupParty: await nameOf(group?.partyGroupId),
    poParty: await nameOf(po.partyGroupId),
  })
}

async function partyLabelFor(deps: Deps, customer: ResolvedCustomer, cardCode: string | null): Promise<string | null> {
  if (customer.partyGroup) return customer.partyGroup.alias || customer.partyGroup.name
  if (!cardCode) return null
  const alias = (await deps.store.listPartyAliases()).find((row) => row.cardCode === cardCode)
  return alias?.alias ?? customer.cardName
}

/**
 * Records a read PO and checks it. Status: needs_review when the customer or a line is not resolved; else
 * awaiting_proceed for a repeat; else short (fail) or, through onPoChecked, checked.
 */
export async function intakePo(deps: FlowDeps, read: { po: ExtractedPo; reader: PoReader }, source: PoSource): Promise<IntakeOutcome> {
  const { po } = read
  const customer = await resolvePoCustomer(deps, po, source.mappedPartyGroupId, source.groupSubject ?? null)
  const lines = await matchLines(deps, po, customer)
  let repeats = await findRepeats(deps, po, customer)
  const resolved = customer.resolution.status === 'resolved'
  const problems: string[] = []
  if (source.unknownSender) problems.push(unknownSenderReason(source.sender))
  if (customer.resolution.status === 'needs_review') problems.push(customer.resolution.reason)
  for (const line of lines) {
    if (!line.itemCode) problems.push(`Line ${line.lineNo} (${line.articleNo ?? line.description}): ${line.note ?? 'no item'}.`)
    else if (!line.matchConfirmed) problems.push(`Line ${line.lineNo}: ${line.itemCode} was matched by name only; confirm it.`)
    else if (line.pcs == null) problems.push(`Line ${line.lineNo}: ${line.note ?? 'no piece count'}.`)
  }
  const checkable = lines.every((line) => line.itemCode && line.pcs != null)
  const record = (status: CustomerPoStatus) => deps.store.createCustomerPo({
    partyGroupId: customer.partyGroup?.id ?? null,
    poNo: po.poNumber,
    revision: repeats.revision,
    status,
    cardCode: resolved ? (customer.resolution as { cardCode: string }).cardCode : null,
    siteCode: po.siteCode,
    shipToGstin: po.shipToGstin,
    shipToAddress: po.shipToAddress,
    buyerName: po.buyerName,
    vendorCode: po.vendorCode,
    poDate: po.poDate,
    deliveryDate: po.deliveryDate,
    basicTotal: po.basicTotal,
    taxTotal: po.taxTotal,
    total: po.total,
    notes: po.notes,
    deliveryTerm: po.deliveryTerm ?? null,
    paymentTerms: po.paymentTerms ?? null,
    reader: read.reader,
    resolution: { ...customer.resolution },
    reviewReason: problems.length ? problems.join(' ') : null,
    repeatOf: repeats.hits,
    documentId: source.documentId,
    sourceChat: source.chatJid,
    sourceMessageId: source.messageId,
    sourceSender: source.sender,
    raisedBy: source.raisedBy,
    lines,
  })
  // Two copies of one PO arriving together race for the same revision: the loser is the next revision of the
  // winner, a repeat waiting for *proceed* like any later copy.
  let created: CustomerPo | null = null
  for (let attempt = 0; !created; attempt += 1) {
    try {
      created = await record(problems.length ? 'needs_review' : repeats.hits.length ? 'awaiting_proceed' : 'received')
    } catch (error) {
      if (!(error instanceof CustomerPoRevisionTakenError) || attempt >= REVISION_RETRIES) throw error
      repeats = await findRepeats(deps, po, customer)
    }
  }
  const status = created.status
  if (source.documentId) {
    await deps.store.linkDocument(source.documentId, { kind: 'customer_po', subjectType: 'customer_po', subjectId: created.id })
  }
  const check = checkable
    ? await runInventoryCheck(
        deps,
        lines.map((line) => ({ itemCode: line.itemCode!, pcs: line.pcs! })),
        { customerPoId: created.id, kind: 'po', createdBy: source.raisedBy },
      )
    : null

  let next: string | null = null
  let po2 = created
  if (status === 'received' && check) {
    next = await onPoChecked(deps, created, check)
    po2 = (await deps.store.getCustomerPo(created.id)) ?? created
  } else if (status === 'received' && !check) {
    po2 = (await deps.store.updateCustomerPo(created.id, { status: 'needs_review', reviewReason: 'The lines could not be checked.' })) ?? created
  }
  const partyLabel = await partyLabelFor(deps, customer, po2.cardCode)
  return {
    po: po2,
    check,
    partyLabel,
    summary: adminSummary({ po: po2, check, partyLabel, cardName: customer.cardName, next, source: await describePoSource(deps, po2) }),
  }
}

/**
 * A PO has been checked (and, for a repeat, the admin said *proceed*): hand it to the PO -> TSO workflow. Pass or
 * pass_with_incoming raises the sales order; fail holds the PO and tasks the manager. Returns the admin's note.
 */
export async function onPoChecked(deps: FlowDeps, po: CustomerPo, check: InventoryCheck): Promise<string> {
  return queuePoProcess(deps, po, check)
}

/** The PO's lines as a check asks for them; null when a line has no item or piece count. */
function requestedOf(po: CustomerPo): CheckRequest[] | null {
  if (!po.lines.length || po.lines.some((line) => !line.itemCode || line.pcs == null)) return null
  return po.lines.map((line) => ({ itemCode: line.itemCode!, pcs: line.pcs! }))
}

/**
 * The admin's *proceed* on a repeat PO: continue as if it were new. The PO waited, so stock may have moved: it is
 * checked again now and the TSO (or the hold) follows from the fresh check. Returns the reply.
 */
export async function proceedWithPo(deps: FlowDeps, customerPoId: string): Promise<string> {
  const po = await deps.store.getCustomerPo(customerPoId)
  if (!po) return 'That PO is no longer on record.'
  if (po.status !== 'awaiting_proceed') {
    return `PO ${po.poNo} is ${po.status.replace(/_/g, ' ')}, not waiting for *proceed*.`
  }
  const requested = requestedOf(po)
  if (!requested) {
    await deps.store.updateCustomerPo(po.id, { status: 'needs_review', reviewReason: 'The lines could not be checked.' })
    return `PO ${po.poNo} could not be checked, so it went to the office for review.`
  }
  const check = await runInventoryCheck(deps, requested, { customerPoId: po.id, kind: 'po', createdBy: null })
  return `Going ahead with PO ${po.poNo}. ${await onPoChecked(deps, po, check)}`
}

/**
 * Records a PO that cannot be checked (unreadable, or SAP not imported) as needs_review, with what was read of it.
 * Returns the stored row.
 */
export async function recordForReview(
  deps: Deps,
  input: { po: ExtractedPo | null; poNumber: string | null; reader: PoReader | null; reason: string },
  source: PoSource,
): Promise<CustomerPo> {
  const po = input.po
  const existing = source.mappedPartyGroupId && (input.po?.poNumber ?? input.poNumber)
    ? (await deps.store.findCustomerPosByNumber((input.po?.poNumber ?? input.poNumber)!)).filter(
        (row) => row.partyGroupId === source.mappedPartyGroupId,
      )
    : []
  let revision = existing.reduce((max, row) => Math.max(max, row.revision), 0) + 1
  const record = () => deps.store.createCustomerPo({
    partyGroupId: source.mappedPartyGroupId,
    poNo: po?.poNumber ?? input.poNumber,
    revision,
    status: 'needs_review',
    cardCode: null,
    siteCode: po?.siteCode ?? null,
    shipToGstin: po?.shipToGstin ?? null,
    shipToAddress: po?.shipToAddress ?? null,
    buyerName: po?.buyerName ?? null,
    vendorCode: po?.vendorCode ?? null,
    poDate: po?.poDate ?? null,
    deliveryDate: po?.deliveryDate ?? null,
    basicTotal: po?.basicTotal ?? null,
    taxTotal: po?.taxTotal ?? null,
    total: po?.total ?? null,
    notes: po?.notes ?? [],
    reader: input.reader,
    resolution: null,
    reviewReason: input.reason,
    repeatOf: [],
    documentId: source.documentId,
    sourceChat: source.chatJid,
    sourceMessageId: source.messageId,
    sourceSender: source.sender,
    raisedBy: source.raisedBy,
    lines: (po?.lines ?? []).map((line) => ({
      lineNo: line.lineNo,
      articleNo: line.articleNo,
      ean: line.ean,
      description: line.description,
      hsn: line.hsn,
      qty: line.qty,
      uom: line.uom,
      eaQty: line.eaQty,
      mrp: line.mrp,
      baseCost: line.baseCost,
      gstPct: line.gstPct,
      taxAmount: line.taxAmount,
      cessAmount: line.cessAmount ?? null,
      lineTotal: line.lineTotal,
      deliveryDate: line.deliveryDate,
      itemCode: null,
      itemName: null,
      matchMethod: null,
      matchConfirmed: false,
      pcs: null,
      pcsSource: null,
      pcsPerUom: null,
      unitPrice: null,
      note: null,
    })),
  })
  let created: CustomerPo | null = null
  for (let attempt = 0; !created; attempt += 1) {
    try {
      created = await record()
    } catch (error) {
      if (!(error instanceof CustomerPoRevisionTakenError) || attempt >= REVISION_RETRIES) throw error
      revision += 1
    }
  }
  if (source.documentId) {
    await deps.store.linkDocument(source.documentId, { kind: 'customer_po', subjectType: 'customer_po', subjectId: created.id })
  }
  return created
}

/** The admin summary of a stored PO, rebuilt (for the agent's explain_check, the *proceed* reply, an office review). */
export async function storedSummary(deps: Deps, po: CustomerPo, next: string | null = null): Promise<string> {
  const check = await deps.store.latestInventoryCheck(po.id)
  const info = po.cardCode ? (await cardInfo(deps.sapSql, [po.cardCode]).catch(() => ({}) as Record<string, never>))[po.cardCode] : undefined
  return adminSummary({ po, check, partyLabel: po.partyName, cardName: info?.cardName ?? null, next, source: await describePoSource(deps, po) })
}

// ------------------------------------------------------------------------------------------- the office's review

export type ReviewInput = {
  /** The SAP card the PO is for (any card; the office decides). */
  cardCode?: string | null
  /** Item codes the office confirms per line, with pieces per buyer unit when SAP cannot tell. */
  lines?: Array<{ lineNo: number; itemCode: string; pcsPerUom?: number | null }>
}

export class PoReviewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PoReviewError'
  }
}

/** The party a card belongs to, by card code or PAN. */
async function partyOfCard(deps: Deps, cardCode: string): Promise<{ partyGroupId: string | null; cardName: string | null }> {
  const info = (await cardInfo(deps.sapSql, [cardCode]))[cardCode]
  if (!info) throw new PoReviewError(`${cardCode} is not a customer card in SAP.`)
  const group = partyGroupFor(await deps.store.listPartyGroups(), cardCode, info.pan)
  return { partyGroupId: group?.id ?? null, cardName: info.cardName }
}

/** The customer of a PO as the check and line matching see it: its party's cards (or just its own). */
async function customerOf(deps: Deps, po: CustomerPo, cardCode: string): Promise<ResolvedCustomer> {
  const party = po.partyGroupId ? await deps.store.getPartyGroup(po.partyGroupId) : null
  const partyCards = party
    ? await partyCardCodes(
        deps.sapSql,
        party.members.filter((m) => m.kind === 'pan').map((m) => m.value),
        party.members.filter((m) => m.kind === 'card_code').map((m) => m.value),
      )
    : []
  const info = (await cardInfo(deps.sapSql, [cardCode]))[cardCode]
  return {
    resolution: { status: 'resolved', cardCode, partyGroupId: po.partyGroupId, method: 'party', note: 'set by the office' },
    partyGroup: party,
    partyCards: [...new Set([...partyCards, cardCode])],
    cardName: info?.cardName ?? null,
    cardPan: info?.pan ?? null,
  }
}

/** A stored PO as the reader returned it, for matching its lines again. */
function asRead(po: CustomerPo): ExtractedPo {
  return {
    poNumber: po.poNo ?? '',
    poDate: po.poDate,
    deliveryDate: po.deliveryDate,
    buyerName: po.buyerName,
    buyerCode: null,
    vendorCode: po.vendorCode,
    siteCode: po.siteCode,
    shipToGstin: po.shipToGstin,
    shipToAddress: po.shipToAddress,
    basicTotal: po.basicTotal,
    taxTotal: po.taxTotal,
    total: po.total,
    notes: po.notes,
    lines: po.lines.map((line) => ({ ...line, eaMrp: null })),
  }
}

/** The customer changed: lines the office has not set by hand are matched again with the new party's refs and history. */
async function rematchLines(deps: Deps, po: CustomerPo, cardCode: string): Promise<CustomerPo> {
  const matched = await matchLines(deps, asRead(po), await customerOf(deps, po, cardCode))
  const lines = po.lines.map((line) => (line.matchMethod === 'manual' ? line : (matched.find((row) => row.lineNo === line.lineNo) ?? line)))
  return (await deps.store.updateCustomerPoLines(po.id, lines)) ?? po
}

/**
 * The office's review of a PO in needs_review (C3): set the customer card and confirm each line's item. Pieces are
 * worked out as on intake (the EA row, the customer's ref, SAP's pieces per carton) or from the pieces per unit the
 * office gives. Nothing is raised until confirmPoReview.
 */
export async function reviewPo(deps: Deps, customerPoId: string, input: ReviewInput): Promise<CustomerPo> {
  const po = await deps.store.getCustomerPo(customerPoId)
  if (!po) throw new PoReviewError('That PO is no longer on record.')
  if (po.status !== 'needs_review') throw new PoReviewError(`PO ${po.poNo ?? ''} is ${po.status.replace(/_/g, ' ')}, not waiting for review.`.replace('  ', ' '))
  let current = po
  if (input.cardCode !== undefined) {
    const cardCode = input.cardCode?.trim() || null
    const party = cardCode ? await partyOfCard(deps, cardCode) : { partyGroupId: po.partyGroupId, cardName: null }
    let revision = po.revision
    if (party.partyGroupId !== po.partyGroupId && po.poNo) {
      const live = (await deps.store.findCustomerPosByNumber(po.poNo)).filter((row) => row.id !== po.id && row.partyGroupId === party.partyGroupId)
      revision = live.reduce((max, row) => Math.max(max, row.revision), 0) + 1
    }
    current =
      (await deps.store.updateCustomerPo(po.id, {
        cardCode,
        partyGroupId: party.partyGroupId,
        revision,
        resolution: cardCode ? { status: 'resolved', cardCode, partyGroupId: party.partyGroupId, method: 'manual', note: 'set by the office' } : po.resolution,
      })) ?? po
    if (cardCode && party.partyGroupId !== po.partyGroupId) current = await rematchLines(deps, current, cardCode)
  }
  if (input.lines?.length) {
    const codes = [...new Set(input.lines.map((line) => line.itemCode.trim().toUpperCase()))]
    const facts = await itemFacts(deps.sapSql, codes)
    const refs = current.partyGroupId ? await deps.store.listCustomerItemRefs(current.partyGroupId) : []
    const lines = current.lines.map((line) => {
      const asked = input.lines!.find((row) => row.lineNo === line.lineNo)
      if (!asked) return line
      const itemCode = asked.itemCode.trim().toUpperCase()
      const item = facts[itemCode]
      if (!item) throw new PoReviewError(`Line ${line.lineNo}: ${itemCode} is not an item in SAP.`)
      if (item.role !== 'fg') throw new PoReviewError(`Line ${line.lineNo}: ${itemCode} is not a finished good.`)
      const ref = refs.find((row) => row.itemCode === itemCode && ((line.articleNo && row.articleNo === line.articleNo) || (line.ean && row.ean === line.ean))) ?? null
      const given = asked.pcsPerUom && asked.pcsPerUom > 0 ? asked.pcsPerUom : null
      const pieces = given
        ? { pcs: line.qty * given, source: 'ref' as const, pcsPerUom: given }
        : piecesFor(line, ref, item.pcsPerCarton ?? null)
      if (!pieces) throw new PoReviewError(`Line ${line.lineNo}: cannot turn ${line.qty} ${line.uom ?? '(no unit)'} into pieces; give the pieces per ${line.uom ?? 'unit'}.`)
      return {
        ...line,
        itemCode,
        itemName: item.itemName,
        matchMethod: 'manual' as const,
        matchConfirmed: true,
        pcs: pieces.pcs,
        pcsSource: pieces.source,
        pcsPerUom: Math.round(pieces.pcsPerUom * 1000) / 1000,
        unitPrice: line.baseCost != null ? Math.round((line.baseCost / pieces.pcsPerUom) * 10_000) / 10_000 : line.unitPrice,
        note: 'confirmed by the office',
      }
    })
    current = (await deps.store.updateCustomerPoLines(current.id, lines)) ?? current
  }
  return current
}

/**
 * "Confirm and check" (C3): the office has set the customer and confirmed every line. The PO is checked again for
 * repeats and stock and carries on exactly as a fresh one: a repeat waits for the admin's *proceed*, otherwise
 * onPoChecked raises the TSO (or holds it short). The office's review tasks are closed and the admin gets the summary.
 * Returns the PO, its check and the note of what happens next.
 */
export async function confirmPoReview(
  deps: FlowDeps,
  customerPoId: string,
): Promise<{ po: CustomerPo; check: InventoryCheck; next: string; summary: string }> {
  const po = await deps.store.getCustomerPo(customerPoId)
  if (!po) throw new PoReviewError('That PO is no longer on record.')
  if (po.status !== 'needs_review') throw new PoReviewError(`PO ${po.poNo ?? '(no number)'} is ${po.status.replace(/_/g, ' ')}, not waiting for review.`)
  if (!po.cardCode) throw new PoReviewError('Choose the customer card first.')
  const unconfirmed = po.lines.filter((line) => !line.itemCode || !line.matchConfirmed || line.pcs == null).map((line) => line.lineNo)
  if (unconfirmed.length) throw new PoReviewError(`Confirm the item of line ${unconfirmed.join(', ')} first.`)
  const customer = await customerOf(deps, po, po.cardCode)
  const repeats = po.poNo ? await findRepeats(deps, asRead(po), customer) : { hits: [], revision: po.revision }
  const hits = repeats.hits.filter((hit) => hit.customerPoId !== po.id)
  const check = await runInventoryCheck(deps, requestedOf(po)!, { customerPoId: po.id, kind: 'po', createdBy: null })
  let updated =
    (await deps.store.updateCustomerPo(po.id, {
      status: hits.length ? 'awaiting_proceed' : 'received',
      reviewReason: null,
      repeatOf: hits,
    })) ?? po
  let next: string
  if (hits.length) {
    next = 'It repeats an earlier order: reply *proceed* to go ahead anyway.'
  } else {
    next = await onPoChecked(deps, updated, check)
    updated = (await deps.store.getCustomerPo(po.id)) ?? updated
  }
  for (const task of (await deps.store.listTasks()).filter(
    (row) => row.subjectType === 'customer_po' && row.subjectId === po.id && row.kind === 'review' && (row.status === 'todo' || row.status === 'doing'),
  )) {
    await deps.store.updateTaskStatus(task.id, 'done')
  }
  const summary = await storedSummary(deps, updated, `Confirmed by the office. ${next}`)
  return { po: updated, check, next, summary }
}
