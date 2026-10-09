import type { Store } from '../db/store'
import type { CustomerPoLine, NewCustomerPo, NewInventoryCheck } from '../db/types'

type Expect = (value: unknown) => {
  toEqual(expected: unknown): void
  toMatchObject(expected: unknown): void
  toBeNull(): void
  toBe(expected: unknown): void
  rejects: { toThrow(): Promise<void> }
}

const line: CustomerPoLine = {
  lineNo: 1,
  cessAmount: null,
  articleNo: '700100300',
  ean: '8900000000024',
  description: 'ZETA PRM KERELA CASSAVA CHIPS 200G PP',
  hsn: '20081940',
  qty: 12,
  uom: 'C01',
  eaQty: 360,
  mrp: 9000,
  baseCost: 4200,
  gstPct: 5,
  taxAmount: 2520,
  lineTotal: 50400,
  deliveryDate: '2026-03-10',
  itemCode: 'ZFGC200',
  itemName: 'Zeta Cassava Chips 200g',
  matchMethod: 'article',
  matchConfirmed: true,
  pcs: 360,
  pcsSource: 'ea',
  pcsPerUom: 30,
  unitPrice: 140,
  note: null,
}

export function newPo(partyGroupId: string | null, overrides: Partial<NewCustomerPo> = {}): NewCustomerPo {
  return {
    partyGroupId,
    poNo: '4400012345',
    status: 'received',
    cardCode: 'ZC105',
    siteCode: 'T9QA',
    shipToGstin: '32AAACN9999Q1ZB',
    shipToAddress: 'Plot 7, Kalamassery 683104',
    buyerName: 'Northwind Retail Limited',
    vendorCode: '99887766',
    poDate: '2026-03-02',
    deliveryDate: '2026-03-10',
    basicTotal: 50400,
    taxTotal: 2520,
    total: 52920,
    notes: ['Book a DC slot'],
    reader: 'z_mat_poprint',
    resolution: { status: 'resolved', method: 'site' },
    reviewReason: null,
    repeatOf: [],
    documentId: null,
    sourceChat: '1@g.us',
    sourceMessageId: null,
    sourceSender: 'a stand-in',
    raisedBy: null,
    lines: [line],
    ...overrides,
  }
}

function check(customerPoId: string | null, verdict: NewInventoryCheck['verdict']): NewInventoryCheck {
  return {
    customerPoId,
    kind: customerPoId ? 'po' : 'dry_run',
    verdict,
    dataAsOf: '2026-03-31',
    warnings: ['ZFGC200: no carton in the BOM.'],
    requested: [{ itemCode: 'ZFGC200', pcs: 360 }],
    createdBy: null,
    lines: [
      {
        kind: 'component',
        itemCode: 'ZLAM',
        itemName: 'Laminate Zeta',
        role: 'laminate',
        uom: 'kg',
        need: 3.96,
        onHand: 90,
        committed: 0,
        reserved: 0,
        adjustments: 0,
        free: 90,
        onOrder: 0,
        shortNow: 0,
        shortAfterIncoming: 0,
        fromStock: null,
        toMake: null,
        owner: 'tierra',
        ownerCardCode: null,
        ownerName: null,
        checked: true,
        estimated: false,
        status: 'ok',
        incoming: ['PO/25-26/45'],
        forItems: ['ZFGC200'],
        note: null,
      },
    ],
  }
}

/** Received POs, their lines and checks: the same behaviour in the memory store and on Postgres. */
export async function poStoreContract(store: Store, expect: Expect): Promise<void> {
  const party = await store.createPartyGroup({ name: 'Northwind', members: [{ kind: 'pan', value: 'AAACN9999Q' }] })
  const doc = await store.insertDocument({ filename: 'po.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF'), messageId: 'm-po' })
  const first = await store.createCustomerPo(newPo(party.id, { documentId: doc, sourceMessageId: 'm-po' }))
  expect(first).toMatchObject({ revision: 1, partyName: 'Northwind', status: 'received', notes: ['Book a DC slot'], lines: [line] })
  expect((await store.getCustomerPo(first.id))?.lines[0]).toEqual(line)
  expect(await store.findCustomerPoByMessage('m-po')).toMatchObject({ id: first.id })
  await store.linkDocument(doc, { kind: 'customer_po', subjectType: 'customer_po', subjectId: first.id })

  // one live row per party group, PO number and revision; a repeat is the next revision
  await expect(store.createCustomerPo(newPo(party.id))).rejects.toThrow()
  const second = await store.createCustomerPo(newPo(party.id, { revision: 2, status: 'awaiting_proceed', repeatOf: [{ source: 'tierra', docNo: 'PO 4400012345 r1', docDate: '2026-03-02', cardCode: 'ZC105', status: 'received', invoices: [], customerPoId: first.id }] }))
  expect((await store.findCustomerPosByNumber('4400012345')).map((row) => row.revision)).toEqual([2, 1])

  const done = await store.saveInventoryCheck(check(first.id, 'pass_with_incoming'))
  expect(await store.getInventoryCheck(done.id)).toMatchObject({ verdict: 'pass_with_incoming', lines: [{ itemCode: 'ZLAM', need: 3.96, incoming: ['PO/25-26/45'] }] })
  const later = await store.saveInventoryCheck(check(first.id, 'pass'))
  expect((await store.latestInventoryCheck(first.id))?.id).toBe(later.id)
  const dry = await store.saveInventoryCheck(check(null, 'fail'))
  expect(await store.getInventoryCheck(dry.id)).toMatchObject({ kind: 'dry_run', customerPoId: null })

  expect(await store.updateCustomerPo(first.id, { status: 'checked' })).toMatchObject({ status: 'checked' })
  expect(await store.updateCustomerPo('cpo_missing', { status: 'checked' })).toBeNull()

  const listed = await store.listCustomerPos()
  expect(listed.map((row) => [row.revision, row.verdict, row.repeat, row.lineCount])).toEqual([
    [2, null, true, 1],
    [1, 'pass', false, 1],
  ])
  expect((await store.listCustomerPos({ status: 'awaiting_proceed' })).map((row) => row.id)).toEqual([second.id])
  expect(await store.stockOverlays(['ZFGC200'])).toEqual({})
  expect(await store.listCustomerSites()).toEqual([])
  expect(await store.listCustomerItemRefs(party.id)).toEqual([])
}
