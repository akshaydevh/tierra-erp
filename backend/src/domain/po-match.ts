import type { CustomerItemRef, CustomerSite, MatchMethod, PartyGroup, PcsSource } from '../db/types'
import type { AddressCandidate, HistoryItem, ItemFacts } from '../queries/po'
import type { ExtractedLine, ExtractedPo } from './po'

/**
 * Who sent a PO and what its lines are, decided from data only (plan §P3). The bot never guesses: anything that
 * does not resolve to exactly one answer goes to the office as NEEDS_REVIEW.
 */

/** Characters 3-12 of a GSTIN. */
export function panOf(gstin: string | null | undefined): string | null {
  const clean = gstin?.replace(/\s/g, '').toUpperCase() ?? ''
  return /^[0-9]{2}[A-Z0-9]{10}[A-Z0-9]{3}$/.test(clean) ? clean.slice(2, 12) : null
}

export type CustomerResolution =
  | {
      status: 'resolved'
      cardCode: string
      partyGroupId: string | null
      method: 'site' | 'gstin' | 'address' | 'history' | 'party'
      note: string
    }
  | { status: 'needs_review'; reason: string; candidates: string[]; partyGroupId: string | null }

export type HistoryHit = { cardCode: string; source: 'tierra_site' | 'sap_po_prefix'; orders: number }

export type ResolveInput = {
  po: Pick<ExtractedPo, 'siteCode' | 'shipToGstin' | 'shipToAddress' | 'poNumber'>
  sites: CustomerSite[]
  partyGroups: PartyGroup[]
  /** Customer cards with an address under the ship-to GSTIN (erp.party_addresses). */
  candidates: AddressCandidate[]
  /** Earlier orders that point at one card: this site on an earlier Tierra receipt, or SAP SOs with a PO-number prefix. */
  history: HistoryHit[]
  /** The party group of the WhatsApp group the PO came from, if it is mapped. */
  mappedPartyGroupId: string | null
  /** The cards of the mapped party group (when there is no ship-to GSTIN to go on). */
  mappedCards?: string[]
}

/** The party group a card belongs to: by its card code, else by its PAN. */
export function partyGroupFor(groups: PartyGroup[], cardCode: string | null, pan: string | null): PartyGroup | null {
  if (cardCode) {
    const byCard = groups.find((group) => group.members.some((m) => m.kind === 'card_code' && m.value === cardCode))
    if (byCard) return byCard
  }
  if (pan) return groups.find((group) => group.members.some((m) => m.kind === 'pan' && m.value === pan)) ?? null
  return null
}

const ADDRESS_NOISE = new Set([
  'road', 'street', 'kerala', 'india', 'distribution', 'center', 'centre', 'building', 'floor', 'ground', 'near',
  'post', 'district', 'dist', 'taluk', 'village', 'limited', 'private', 'ltd', 'pvt', 'logistics', 'warehouse',
])

function addressTokens(text: string | null | undefined): Set<string> {
  return new Set(
    (text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !/^\d+$/.test(token) && !ADDRESS_NOISE.has(token)),
  )
}

function pinCode(text: string | null | undefined): string | null {
  return /\b(\d{6})\b/.exec(text ?? '')?.[1] ?? null
}

/** Each candidate card's best address score against the PO's delivery address; zero without the same PIN code. */
export function addressScores(address: string | null, candidates: AddressCandidate[]): Map<string, number> {
  const pin = pinCode(address)
  const wanted = addressTokens(address)
  const scores = new Map<string, number>()
  for (const candidate of candidates) {
    const text = [candidate.street, candidate.city, candidate.zipCode].filter(Boolean).join(' ')
    const samePin = pin !== null && (candidate.zipCode === pin || pinCode(text) === pin)
    const overlap = [...addressTokens(text)].filter((token) => wanted.has(token)).length
    const score = samePin ? overlap + 1 : 0
    scores.set(candidate.cardCode, Math.max(scores.get(candidate.cardCode) ?? 0, score))
  }
  return scores
}

export function resolveCustomer(input: ResolveInput): CustomerResolution {
  const { po, partyGroups } = input
  const pan = panOf(po.shipToGstin)
  const groupOf = (card: string, cardPan: string | null) => partyGroupFor(partyGroups, card, cardPan ?? pan)?.id ?? null

  // 1. The site code, for a party group that owns the ship-to PAN (or the WhatsApp group's party).
  if (po.siteCode) {
    const site = po.siteCode.trim().toUpperCase()
    const hits = input.sites.filter((row) => {
      if (row.siteCode.toUpperCase() !== site) return false
      const group = partyGroups.find((candidate) => candidate.id === row.partyGroupId)
      const ownsPan = pan !== null && Boolean(group?.members.some((m) => m.kind === 'pan' && m.value === pan))
      return ownsPan || row.partyGroupId === input.mappedPartyGroupId || (!pan && !input.mappedPartyGroupId)
    })
    if (hits.length === 1) {
      const hit = hits[0]!
      return { status: 'resolved', cardCode: hit.cardCode, partyGroupId: hit.partyGroupId, method: 'site', note: `site ${site}` }
    }
  }

  const cards = [...new Set(input.candidates.map((row) => row.cardCode))]
  const panOfCard = (card: string) => input.candidates.find((row) => row.cardCode === card)?.pan ?? null

  // 2. The ship-to GSTIN: one card, or one card whose ship-to address matches the PO's.
  if (cards.length === 1) {
    const card = cards[0]!
    return { status: 'resolved', cardCode: card, partyGroupId: groupOf(card, panOfCard(card)), method: 'gstin', note: `GSTIN ${po.shipToGstin}` }
  }
  if (cards.length > 1) {
    const scores = addressScores(po.shipToAddress, input.candidates)
    const ranked = [...scores.entries()].filter(([, score]) => score >= 2).sort((a, b) => b[1] - a[1])
    if (ranked.length > 0 && (ranked.length === 1 || ranked[0]![1] > ranked[1]![1])) {
      const card = ranked[0]![0]
      return { status: 'resolved', cardCode: card, partyGroupId: groupOf(card, panOfCard(card)), method: 'address', note: 'ship-to address' }
    }
  }

  // 3. History: this site on an earlier receipt, or the card whose SAP orders carry PO numbers like this one.
  const pool = cards.length ? cards : (input.mappedCards ?? [])
  const historic = [...new Set(input.history.filter((hit) => !pool.length || pool.includes(hit.cardCode)).map((hit) => hit.cardCode))]
  if (historic.length === 1) {
    const card = historic[0]!
    const source = input.history.find((hit) => hit.cardCode === card)!.source
    return {
      status: 'resolved',
      cardCode: card,
      partyGroupId: groupOf(card, panOfCard(card)),
      method: 'history',
      note: source === 'tierra_site' ? `site ${po.siteCode} on an earlier PO` : 'earlier SAP orders with this PO series',
    }
  }

  // A mapped customer group with a single card needs no GSTIN.
  if (!cards.length && input.mappedCards?.length === 1) {
    const card = input.mappedCards[0]!
    return { status: 'resolved', cardCode: card, partyGroupId: input.mappedPartyGroupId, method: 'party', note: 'the customer group it came from' }
  }

  const partyGroupId = pan ? (partyGroupFor(partyGroups, null, pan)?.id ?? input.mappedPartyGroupId) : input.mappedPartyGroupId
  const site = po.siteCode ? `site ${po.siteCode} is not known` : 'the PO has no site code'
  if (cards.length > 1) {
    return {
      status: 'needs_review',
      reason: `Ship-to GSTIN ${po.shipToGstin} belongs to ${cards.length} customer cards (${cards.join(', ')}), ${site}, and the delivery address matches none of them uniquely.`,
      candidates: cards,
      partyGroupId,
    }
  }
  return {
    status: 'needs_review',
    reason: po.shipToGstin
      ? `No customer card in SAP has ship-to GSTIN ${po.shipToGstin}, and ${site}.`
      : `The PO has no ship-to GSTIN, and ${site}.`,
    candidates: [],
    partyGroupId,
  }
}

// --------------------------------------------------------------------------------------------- lines

export type LineMatch = {
  itemCode: string | null
  itemName: string | null
  matchMethod: MatchMethod | null
  matchConfirmed: boolean
  pcs: number | null
  pcsSource: PcsSource | null
  pcsPerUom: number | null
  unitPrice: number | null
  note: string | null
}

const PIECE_UNITS = new Set(['EA', 'PC', 'PCS', 'NOS', 'NO', 'EACH', 'PKT', 'PACK', 'POUCH', 'UNIT', 'UNITS'])
const CARTON_UNITS = new Set(['CRT', 'C01', 'C02', 'CTN', 'CAR', 'CARTON', 'CASE', 'CS', 'BOX', 'CRTN', 'CB'])

/** Words that say nothing about which product it is (brand, packaging, regional spellings). */
const NAME_NOISE = new Set([
  'tierra', 'pp', 'prm', 'premium', 'kerala', 'kerela', 'chips', 'pouch', 'pack', 'pkt', 'gm', 'gms', 'g', 'kg',
  'the', 'and', 'with', 'new',
])

export function gramsIn(text: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(kg|kgs|g|gm|gms|gram|grams|grm)\b/i.exec(text)
  if (!match) return null
  const value = Number(match[1])
  return /^k/i.test(match[2]!) ? value * 1000 : value
}

function nameTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/(\d+(?:\.\d+)?)\s*(kg|kgs|g|gm|gms|gram|grams|grm)\b/g, ' ')
      .split(/[^a-z]+/)
      .filter((token) => token.length >= 3 && !NAME_NOISE.has(token)),
  )
}

function containsCode(haystack: string, code: string | null): boolean {
  if (!code || code.length < 5) return false
  return new RegExp(`(^|\\D)${code}(\\D|$)`).test(haystack)
}

function sameUnit(a: string | null, b: string | null): boolean {
  return Boolean(a && b && a.trim().toUpperCase() === b.trim().toUpperCase())
}

/** Pieces for a PO line: the EA sub-row first, then the customer ref's pieces per unit, then SAP's pieces per carton. */
export function piecesFor(
  line: Pick<ExtractedLine, 'qty' | 'uom' | 'eaQty'>,
  ref: Pick<CustomerItemRef, 'buyerUom' | 'pcsPerUom'> | null,
  pcsPerCarton: number | null,
): { pcs: number; source: PcsSource; pcsPerUom: number } | null {
  if (line.eaQty && line.eaQty > 0) return { pcs: line.eaQty, source: 'ea', pcsPerUom: line.eaQty / line.qty }
  const unit = line.uom?.trim().toUpperCase() ?? null
  if (ref?.pcsPerUom && (!ref.buyerUom || !unit || sameUnit(ref.buyerUom, unit))) {
    return { pcs: line.qty * ref.pcsPerUom, source: 'ref', pcsPerUom: ref.pcsPerUom }
  }
  if (unit && PIECE_UNITS.has(unit)) return { pcs: line.qty, source: 'pcs', pcsPerUom: 1 }
  if (unit && CARTON_UNITS.has(unit) && pcsPerCarton) return { pcs: line.qty * pcsPerCarton, source: 'npu', pcsPerUom: pcsPerCarton }
  return null
}

export type MatchContext = {
  /** The customer's refs (its party group's customer_item_refs). */
  refs: CustomerItemRef[]
  /** Finished goods the customer's cards have ordered in SAP. */
  history: HistoryItem[]
  /** Finished goods of the same pack size, for the name fallback (keyed by grams). */
  byGrams: Record<number, HistoryItem[]>
  facts: Record<string, ItemFacts>
}

function pick(items: HistoryItem[], line: ExtractedLine): HistoryItem[] {
  const grams = gramsIn(line.description)
  const wanted = nameTokens(line.description)
  const scored = items
    .filter((item) => grams === null || item.packGrams === grams || gramsIn(item.itemName) === grams)
    .map((item) => {
      const have = nameTokens([item.itemName, ...item.descriptions].join(' '))
      return { item, score: [...wanted].filter((token) => have.has(token)).length }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
  if (scored.length === 0) return []
  return scored.filter((entry) => entry.score === scored[0]!.score).map((entry) => entry.item)
}

/**
 * Matches a PO line to a Tierra item: article / EAN in the customer's refs, then the customer's own SAP history
 * (the article or EAN printed on an earlier SO line, else one item of that pack size and name), then any finished
 * good of that pack size by name, which someone must confirm.
 */
export function matchLine(line: ExtractedLine, context: MatchContext): LineMatch {
  const empty: LineMatch = {
    itemCode: null,
    itemName: null,
    matchMethod: null,
    matchConfirmed: false,
    pcs: null,
    pcsSource: null,
    pcsPerUom: null,
    unitPrice: null,
    note: null,
  }
  const article = line.articleNo?.trim() || null
  const ean = line.ean?.trim() || null
  let ref = article ? (context.refs.find((row) => row.articleNo?.trim() === article) ?? null) : null
  let method: MatchMethod | null = ref ? 'article' : null
  if (!ref && ean) {
    ref = context.refs.find((row) => row.ean?.trim() === ean) ?? null
    if (ref) method = 'ean'
  }
  let itemCode = ref?.itemCode ?? null
  let confirmed = Boolean(ref)
  const notes: string[] = []

  if (!itemCode) {
    const byCode = context.history.filter((item) =>
      [item.itemName, ...item.descriptions].some((text) => containsCode(text, article) || containsCode(text, ean)),
    )
    const byName = byCode.length ? byCode : pick(context.history, line)
    if (byName.length === 1) {
      itemCode = byName[0]!.itemCode
      method = 'history'
      confirmed = true
    } else if (byName.length > 1) {
      notes.push(`could be ${byName.map((item) => item.itemCode).join(' or ')}`)
    }
  }
  if (!itemCode && notes.length === 0) {
    const grams = gramsIn(line.description)
    const pool = grams !== null ? (context.byGrams[grams] ?? []) : []
    const byName = pick(pool, line)
    if (byName.length === 1) {
      itemCode = byName[0]!.itemCode
      method = 'name'
      confirmed = false
      notes.push('matched by name only; confirm the item')
    } else if (byName.length > 1) {
      notes.push(`could be ${byName.slice(0, 4).map((item) => item.itemCode).join(' or ')}`)
    }
  }
  if (!itemCode) return { ...empty, note: notes.join('; ') || 'no Tierra item found' }

  const facts = context.facts[itemCode]
  const pieces = piecesFor(line, ref, facts?.pcsPerCarton ?? null)
  if (pieces && line.eaQty && ref?.pcsPerUom && sameUnit(ref.buyerUom, line.uom) && Math.abs(line.qty * ref.pcsPerUom - line.eaQty) > 0.001) {
    notes.push(`EA row says ${line.eaQty} pcs but ${line.qty} ${line.uom} x ${ref.pcsPerUom} = ${line.qty * ref.pcsPerUom}`)
  }
  if (!pieces) notes.push(`cannot turn ${line.qty} ${line.uom ?? '(no unit)'} into pieces`)
  const unitPrice =
    pieces && line.baseCost != null ? Math.round((line.baseCost / pieces.pcsPerUom) * 10_000) / 10_000 : null
  return {
    itemCode,
    itemName: facts?.itemName ?? null,
    matchMethod: method,
    matchConfirmed: confirmed,
    pcs: pieces?.pcs ?? null,
    pcsSource: pieces?.source ?? null,
    pcsPerUom: pieces ? Math.round(pieces.pcsPerUom * 1000) / 1000 : null,
    unitPrice,
    note: notes.length ? notes.join('; ') : null,
  }
}
