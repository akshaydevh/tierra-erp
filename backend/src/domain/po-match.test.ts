import { describe, expect, it } from 'vitest'
import type { CustomerItemRef, PartyGroup } from '../db/types'
import type { AddressCandidate, HistoryItem, ItemFacts } from '../queries/po'
import type { ExtractedLine } from './po'
import { matchLine, panOf, piecesFor, resolveCustomer, type ResolveInput } from './po-match'

// Everything invented: a retailer "Northwind" whose six branch cards share one GSTIN (as one real retailer's do).
const GSTIN = '32AAACN9999Q1ZB'
const PAN = 'AAACN9999Q'

const northwind: PartyGroup = { id: 'pty_nw', name: 'Northwind', alias: 'NW', members: [{ kind: 'pan', value: PAN }] }

function card(cardCode: string, street: string, zipCode: string): AddressCandidate {
  return { cardCode, cardName: `Northwind ${cardCode}`, addressType: 'ship_to', street, city: 'Kerala', zipCode, pan: PAN }
}

const SIX_CARDS = [
  card('ZC101', 'Survey 12 Inkel Tower Angamaly South', '683573'),
  card('ZC102', 'CWC Compound Kuriachira', '680006'),
  card('ZC103', 'Metro Logistics Thenhipalam', '673636'),
  card('ZC104', 'Airport Road Mannam North Paravur', '683520'),
  card('ZC105', 'Plot 7 Test Industrial Estate Kalamassery', '683104'),
  card('ZC106', 'Chandrika Chambers Vyttila', '682019'),
]

function input(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    po: { poNumber: '4400012345', siteCode: null, shipToGstin: GSTIN, shipToAddress: 'Distribution Center, Somewhere Else, Kerala - 690001' },
    sites: [],
    partyGroups: [northwind],
    candidates: SIX_CARDS,
    history: [],
    mappedPartyGroupId: null,
    ...overrides,
  }
}

describe('resolving the customer of a PO', () => {
  it('sends a six-way GSTIN with no known site and no matching address to review, never guessing a card', () => {
    const result = resolveCustomer(input())
    expect(result).toEqual({
      status: 'needs_review',
      reason: `Ship-to GSTIN ${GSTIN} belongs to 6 customer cards (ZC101, ZC102, ZC103, ZC104, ZC105, ZC106), the PO has no site code, and the delivery address matches none of them uniquely.`,
      candidates: ['ZC101', 'ZC102', 'ZC103', 'ZC104', 'ZC105', 'ZC106'],
      partyGroupId: 'pty_nw',
    })
    expect('cardCode' in result).toBe(false)
    // an unknown site changes nothing
    expect(resolveCustomer(input({ po: { ...input().po, siteCode: 'Q1ZZ' } }))).toMatchObject({ status: 'needs_review' })
  })

  it('takes the site code first, for the party group that owns the ship-to PAN', () => {
    const sites = [
      { partyGroupId: 'pty_nw', siteCode: 'T9QA', cardCode: 'ZC105', note: null },
      { partyGroupId: 'pty_other', siteCode: 'T9QA', cardCode: 'ZC900', note: null },
    ]
    expect(resolveCustomer(input({ sites, po: { ...input().po, siteCode: 't9qa' } }))).toEqual({
      status: 'resolved',
      cardCode: 'ZC105',
      partyGroupId: 'pty_nw',
      method: 'site',
      note: 'site T9QA',
    })
  })

  it('matches the delivery address (same PIN code and words) when several cards share the GSTIN', () => {
    const po = { ...input().po, shipToAddress: 'Distribution Center, Plot 7, Test Industrial Estate, Kalamassery, ERNAKULAM, Kerala - 683104' }
    expect(resolveCustomer(input({ po }))).toMatchObject({ status: 'resolved', cardCode: 'ZC105', method: 'address' })
  })

  it('falls back to history: one card of the GSTIN took POs numbered like this one', () => {
    const history = [{ cardCode: 'ZC102', source: 'sap_po_prefix' as const, orders: 4 }]
    expect(resolveCustomer(input({ history }))).toMatchObject({ status: 'resolved', cardCode: 'ZC102', method: 'history' })
    const two = [...history, { cardCode: 'ZC103', source: 'sap_po_prefix' as const, orders: 1 }]
    expect(resolveCustomer(input({ history: two }))).toMatchObject({ status: 'needs_review' })
  })

  it('takes a GSTIN with a single card, and a mapped group with a single card when there is no GSTIN', () => {
    expect(resolveCustomer(input({ candidates: [SIX_CARDS[0]!] }))).toMatchObject({ status: 'resolved', cardCode: 'ZC101', method: 'gstin', partyGroupId: 'pty_nw' })
    const noGstin = { ...input().po, shipToGstin: null }
    expect(resolveCustomer(input({ po: noGstin, candidates: [], mappedPartyGroupId: 'pty_nw', mappedCards: ['ZC104'] }))).toMatchObject({
      status: 'resolved',
      cardCode: 'ZC104',
      method: 'party',
    })
    expect(resolveCustomer(input({ po: noGstin, candidates: [] }))).toMatchObject({
      status: 'needs_review',
      reason: 'The PO has no ship-to GSTIN, and the PO has no site code.',
    })
  })

  it('reads the PAN out of a GSTIN', () => {
    expect(panOf(' 32aaacn9999q1zb ')).toBe(PAN)
    expect(panOf('not a gstin')).toBeNull()
  })
})

const facts: Record<string, ItemFacts> = {
  ZFGB100: { itemCode: 'ZFGB100', itemName: '700100200 Zeta Banana Chips 100g', role: 'fg', uom: 'pcs', pcsPerCarton: 50, packGrams: 100, active: true, hasBom: true },
  ZFGC200: { itemCode: 'ZFGC200', itemName: 'Zeta Cassava Chips 200g', role: 'fg', uom: 'pcs', pcsPerCarton: 30, packGrams: 200, active: true, hasBom: true },
  ZFGP200: { itemCode: 'ZFGP200', itemName: 'Zeta Peri Peri Banana 200g', role: 'fg', uom: 'pcs', pcsPerCarton: 30, packGrams: 200, active: true, hasBom: true },
}

const refs: CustomerItemRef[] = [
  { id: 'r1', partyGroupId: 'pty_nw', articleNo: '700100300', ean: '8900000000024', itemCode: 'ZFGC200', buyerUom: 'C01', pcsPerUom: 30, lastPrice: null, note: null },
  { id: 'r2', partyGroupId: 'pty_nw', articleNo: null, ean: '8900000000031', itemCode: 'ZFGB100', buyerUom: 'CRT', pcsPerUom: 48, lastPrice: null, note: null },
]

function poLine(overrides: Partial<ExtractedLine>): ExtractedLine {
  return {
    lineNo: 1,
    articleNo: null,
    ean: null,
    description: 'chips',
    hsn: null,
    qty: 1,
    uom: null,
    eaQty: null,
    mrp: null,
    eaMrp: null,
    baseCost: null,
    gstPct: null,
    taxAmount: null,
    lineTotal: null,
    deliveryDate: null,
    ...overrides,
  }
}

const history: HistoryItem[] = [
  { itemCode: 'ZFGB100', itemName: facts.ZFGB100!.itemName, packGrams: 100, descriptions: ['700100200 Zeta Banana Chips 100g'] },
]

describe('matching PO lines to Tierra items', () => {
  it('resolves "KERELA" and C01 / CRT cartons through the customer refs, with no EA row', () => {
    const kerela = matchLine(
      poLine({ articleNo: '700100300', description: 'ZETA PRM KERELA CASSAVA CHIPS 200G PP', qty: 12, uom: 'C01', baseCost: 4200 }),
      { refs, history: [], byGrams: {}, facts },
    )
    expect(kerela).toMatchObject({
      itemCode: 'ZFGC200',
      matchMethod: 'article',
      matchConfirmed: true,
      pcs: 360,
      pcsSource: 'ref',
      pcsPerUom: 30,
      unitPrice: 140,
    })
    const byEan = matchLine(poLine({ ean: '8900000000031', description: 'ZETA BANANA 100 G', qty: 2, uom: 'CRT', baseCost: 1000 }), {
      refs,
      history: [],
      byGrams: {},
      facts,
    })
    expect(byEan).toMatchObject({ itemCode: 'ZFGB100', matchMethod: 'ean', pcs: 96, pcsSource: 'ref', unitPrice: 20.8333 })
  })

  it('takes the EA sub-row first and notes when it disagrees with the ref', () => {
    const line = poLine({ articleNo: '700100300', description: 'cassava 200g', qty: 12, uom: 'C01', eaQty: 350 })
    expect(matchLine(line, { refs, history: [], byGrams: {}, facts })).toMatchObject({
      pcs: 350,
      pcsSource: 'ea',
      note: 'EA row says 350 pcs but 12 C01 x 30 = 360',
    })
  })

  it("finds the item in the customer's own SAP history by the article printed on earlier orders", () => {
    const line = poLine({ articleNo: '700100200', description: 'ZETA BANANA CHIPS 100 G PP', qty: 3, uom: 'CRT' })
    // no ref: pieces per carton come from SAP (U_NPU 50)
    expect(matchLine(line, { refs: [], history, byGrams: {}, facts })).toMatchObject({
      itemCode: 'ZFGB100',
      matchMethod: 'history',
      matchConfirmed: true,
      pcs: 150,
      pcsSource: 'npu',
    })
  })

  it('falls back to a name match of the same pack size, which someone must confirm, and never picks between two', () => {
    const byGrams = { 200: [{ itemCode: 'ZFGC200', itemName: 'Zeta Cassava Chips 200g', packGrams: 200, descriptions: [] }] }
    expect(matchLine(poLine({ description: 'Zeta cassava chips 200 g', qty: 40, uom: 'PCS' }), { refs: [], history: [], byGrams, facts })).toMatchObject({
      itemCode: 'ZFGC200',
      matchMethod: 'name',
      matchConfirmed: false,
      pcs: 40,
      pcsSource: 'pcs',
    })
    const two = { 200: [...byGrams[200], { itemCode: 'ZFGP200', itemName: 'Zeta Cassava Peri Peri 200g', packGrams: 200, descriptions: [] }] }
    expect(matchLine(poLine({ description: 'Zeta cassava 200 g', qty: 40, uom: 'PCS' }), { refs: [], history: [], byGrams: two, facts })).toMatchObject({
      itemCode: null,
      note: 'could be ZFGC200 or ZFGP200',
    })
  })

  it('will not turn an unknown unit into pieces', () => {
    expect(piecesFor({ qty: 5, uom: 'BAG', eaQty: null }, null, 30)).toBeNull()
    expect(piecesFor({ qty: 5, uom: 'CS', eaQty: null }, null, 30)).toEqual({ pcs: 150, source: 'npu', pcsPerUom: 30 })
    expect(piecesFor({ qty: 5, uom: 'CRT', eaQty: null }, { buyerUom: 'C01', pcsPerUom: 30 }, null)).toBeNull()
  })
})
