import { CustomerPoRevisionTakenError, type Store } from '../db/store'
import type { NewInventoryCheck, NewSalesOrder, SalesOrderLine } from '../db/types'
import { newPo } from './po-store-contract'

type Expect = (value: unknown) => {
  toEqual(expected: unknown): void
  toMatchObject(expected: unknown): void
  toBeNull(): void
  toBe(expected: unknown): void
  toBeInstanceOf(type: unknown): void
  rejects: { toBeInstanceOf(type: unknown): Promise<void> }
}

const soLine: SalesOrderLine = {
  lineNo: 1,
  itemCode: 'ZFGC200',
  itemName: 'Zeta Cassava Chips 200g',
  description: 'ZETA PRM CASSAVA CHIPS 200G PP',
  articleNo: '700100300',
  ean: '8900000000024',
  hsn: '99990001',
  poHsn: '21069091',
  uom: 'C01',
  qty: 12,
  pcs: 360,
  pcsPerUom: 30,
  cartons: 12,
  mrp: 300,
  unitPrice: 140,
  amount: 50400,
  gstPct: 5,
  taxAmount: 2520,
  reservedPcs: 100,
  toMake: 260,
}

function order(customerPoId: string | null, checkId: string | null, overrides: Partial<NewSalesOrder> = {}): NewSalesOrder {
  return {
    customerPoId,
    partyGroupId: null,
    cardCode: 'ZN05',
    checkId,
    status: 'pending_approval',
    docDate: '2026-04-02',
    deliveryDate: '2026-04-10',
    customerPoNo: '4400012345',
    poDate: '2026-03-02',
    vendorCode: '99887766',
    siteCode: 'T9QA',
    shipToGstin: '32AAACN9999Q1ZB',
    placeOfSupply: 'Kerala',
    stateCode: '32',
    taxKind: 'cgst_sgst',
    basicTotal: 50400,
    cgst: 1260,
    sgst: 1260,
    igst: 0,
    taxTotal: 2520,
    total: 52920,
    deliveryTerm: 'DDP',
    paymentTerms: null,
    notes: [],
    createdBy: null,
    lines: [soLine],
    ...overrides,
  }
}

const componentCheck = (customerPoId: string): NewInventoryCheck => ({
  customerPoId,
  kind: 'po',
  verdict: 'pass',
  dataAsOf: '2026-03-31',
  warnings: [],
  requested: [{ itemCode: 'ZFGC200', pcs: 360 }],
  createdBy: null,
  lines: [
    {
      kind: 'component', itemCode: 'ZLAM', itemName: null, role: 'laminate', uom: 'kg', need: 3.12, onHand: 90, committed: 0,
      reserved: 0, adjustments: 0, free: 90, onOrder: 0, shortNow: 0, shortAfterIncoming: 0, fromStock: null, toMake: null,
      owner: 'tierra', ownerCardCode: null, ownerName: null, checked: true, estimated: false, status: 'ok', incoming: [], forItems: ['ZFGC200'], note: null,
    },
  ],
})

/** P4 records: TSOs and their numbers, reservations, approvals, procurement requests, adjustments, outbound sends, jobs. */
export async function orderStoreContract(store: Store, expect: Expect): Promise<void> {
  const party = await store.createPartyGroup({ name: 'Order Party', members: [{ kind: 'card_code', value: 'ZN05' }] })
  const po = await store.createCustomerPo(newPo(party.id, { poNo: '4400077777' }))
  await expect(store.createCustomerPo(newPo(party.id, { poNo: '4400077777' }))).rejects.toBeInstanceOf(CustomerPoRevisionTakenError)
  const check = await store.saveInventoryCheck(componentCheck(po.id))

  // numbers from the counter; a second raise for the same PO returns the first and burns no number
  const first = await store.createSalesOrder(order(po.id, check.id, { partyGroupId: party.id }), { series: 'TSO', fy: '26-27' })
  expect(first).toMatchObject({ created: true, order: { docNo: 'TSO/26-27/0001', seq: 1, version: 1, partyName: 'Order Party', lines: [soLine] } })
  const again = await store.createSalesOrder(order(po.id, check.id), { series: 'TSO', fy: '26-27' })
  expect(again).toMatchObject({ created: false, order: { id: first.order.id } })
  const other = await store.createSalesOrder(order(null, null), { series: 'TSO', fy: '26-27' })
  expect(other.order.docNo).toBe('TSO/26-27/0002')
  expect((await store.createSalesOrder(order(null, null), { series: 'TSO', fy: '27-28' })).order.docNo).toBe('TSO/27-28/0001')
  expect(await store.findSalesOrderByNo('tso/26-27/0001')).toMatchObject({ id: first.order.id })
  expect(await store.findSalesOrderForPo(po.id)).toMatchObject({ id: first.order.id })

  // open TSOs reserve finished pieces and the components of their check; active adjustments add stock
  await store.createStockAdjustment({ itemCode: 'ZLAM', qty: 20, uom: 'kg', reason: 'receipt_unposted', note: null, taskId: null, createdBy: 'usr_joshy', createdVia: 'whatsapp' })
  expect(await store.stockOverlays(['ZFGC200', 'ZLAM', 'ZNONE'])).toEqual({
    ZFGC200: { reserved: 300, adjustments: 0 },
    ZLAM: { reserved: 3.12, adjustments: 20 },
  })
  expect((await store.listStockAdjustments({ status: 'active' }))[0]).toMatchObject({ itemCode: 'ZLAM', qty: 20, createdByName: 'Joshy', status: 'active' })

  // status changes are conditional on the current status; a rejected TSO frees its PO and its reservations
  expect(await store.updateSalesOrder(first.order.id, { status: 'approved' }, ['draft'])).toBeNull()
  expect(await store.updateSalesOrder(first.order.id, { status: 'approved', approvedBy: 'usr_alex', approvedAt: '2026-04-02T08:00:00.000Z' }, ['pending_approval'])).toMatchObject({ status: 'approved', approvedBy: 'usr_alex' })
  await store.updateSalesOrder(first.order.id, { status: 'rejected' })
  expect(await store.findSalesOrderForPo(po.id)).toBeNull()
  expect(await store.stockOverlays(['ZFGC200', 'ZLAM'])).toEqual({ ZFGC200: { reserved: 200, adjustments: 0 }, ZLAM: { reserved: 0, adjustments: 20 } })
  expect((await store.createSalesOrder(order(po.id, null), { series: 'TSO', fy: '26-27' })).order.docNo).toBe('TSO/26-27/0003')
  expect((await store.listSalesOrders({ status: 'rejected' })).map((row) => row.docNo)).toEqual(['TSO/26-27/0001'])

  // approvals: one per subject and version, decided only once
  const approval = await store.createApproval({ subjectType: 'sales_order', subjectId: other.order.id, version: 1, approverRole: 'admin', selfRaised: true, raisedBy: 'usr_alex' })
  expect(await store.createApproval({ subjectType: 'sales_order', subjectId: other.order.id, version: 1, approverRole: 'admin', selfRaised: false, raisedBy: null })).toMatchObject({ id: approval.id, selfRaised: true })
  await store.updateApproval(approval.id, { waMessageIds: ['wa-1', 'wa-2'], taskId: 'tsk_1' })
  expect(await store.findApprovalByMessage('wa-2')).toMatchObject({ id: approval.id, taskId: 'tsk_1' })
  expect(await store.findApprovalByMessage('wa-3')).toBeNull()
  const decided = await store.transitionApproval(approval.id, 1, 'pending', { status: 'approved', decidedBy: 'usr_alex', decidedAt: '2026-04-02T08:00:00.000Z', via: 'reaction', channel: 'whatsapp' })
  expect(decided).toMatchObject({ status: 'approved', decidedByName: 'Alex Thomas', via: 'reaction' })
  expect(await store.transitionApproval(approval.id, 1, 'pending', { status: 'approved' })).toBeNull()
  expect(await store.transitionApproval(approval.id, 2, 'approved', { status: 'pending' })).toBeNull()
  expect(await store.transitionApproval(approval.id, 1, 'approved', { status: 'pending', decidedBy: null, decidedAt: null, via: null, channel: null })).toMatchObject({ status: 'pending', decidedBy: null, decidedAt: null })
  expect((await store.listApprovals({ status: 'pending', subjectType: 'sales_order' })).map((row) => row.id)).toEqual([approval.id])

  // procurement requests: unique per subject, item and reason
  const request = { subjectType: 'sales_order', subjectId: other.order.id, customerPoId: po.id, salesOrderId: other.order.id, itemName: null, uom: 'kg', taskId: null, note: null }
  await store.createProcurementRequests([{ ...request, itemCode: 'ZLAM', qty: 4, reason: 'expedite' }])
  const requests = await store.createProcurementRequests([
    { ...request, itemCode: 'ZLAM', qty: 9, reason: 'expedite' },
    { ...request, itemCode: 'ZFGC200', qty: 260, reason: 'production', uom: 'pcs' },
  ])
  expect(requests.map((row) => [row.itemCode, row.qty, row.reason, row.status]).sort()).toEqual([
    ['ZFGC200', 260, 'production', 'open'],
    ['ZLAM', 4, 'expedite', 'open'],
  ])
  expect(await store.closeProcurementRequests(other.order.id, 'done', 'expedite')).toBe(1)
  expect((await store.listProcurementRequests({ status: 'open' })).map((row) => row.itemCode)).toEqual(['ZFGC200'])

  // generated PDFs by record and version
  await store.insertDocument({ filename: 'TSO-v1.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF'), kind: 'so_pdf', subjectType: 'sales_order', subjectId: other.order.id, version: 1 })
  await store.insertDocument({ filename: 'TSO-v2.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF'), kind: 'so_pdf', subjectType: 'sales_order', subjectId: other.order.id, version: 2 })
  expect((await store.listDocuments('sales_order', other.order.id)).map((doc) => [doc.filename, doc.version])).toEqual([
    ['TSO-v2.pdf', 2],
    ['TSO-v1.pdf', 1],
  ])

  // at-most-once outbound: the row exists before the send; the key never sends twice
  const outbound = { idempotencyKey: 'so.group:apr_1', evolutionMessageId: 'x', remoteJid: '1@g.us', fromMe: true, hasPdf: true, body: 'TSO', kind: 'document' as const, purpose: 'so_customer_copy', subjectType: 'sales_order', subjectId: other.order.id }
  expect(await store.reserveOutbound(outbound)).toBeNull()
  expect(await store.reserveOutbound(outbound)).toMatchObject({ status: 'sending', evolutionMessageId: 'outbound:so.group:apr_1' })
  await store.completeOutbound('so.group:apr_1', 'wa-group-1')
  expect(await store.reserveOutbound(outbound)).toMatchObject({ status: 'sent', evolutionMessageId: 'wa-group-1' })
  expect(await store.findMessage('wa-group-1')).toMatchObject({ purpose: 'so_customer_copy', subjectId: other.order.id })
  await store.setOutboundStatus('so.group:apr_1', 'uncertain')
  expect(await store.reserveOutbound(outbound)).toMatchObject({ status: 'uncertain' })

  // queued jobs can be cancelled by payload, running ones cannot
  await store.enqueueJob({ kind: 'so.send_to_group', payload: { approvalId: 'apr_1' }, runAfter: new Date('2030-01-01T00:00:00Z'), idempotencyKey: 'g1' })
  await store.enqueueJob({ kind: 'so.send_to_group', payload: { approvalId: 'apr_2' }, runAfter: new Date('2030-01-01T00:00:00Z'), idempotencyKey: 'g2' })
  expect(await store.cancelQueuedJobs('so.send_to_group', { approvalId: 'apr_1' })).toBe(1)
  expect(await store.cancelQueuedJobs('so.send_to_group', { approvalId: 'apr_1' })).toBe(0)
  expect(await store.findJobByKey('g1')).toMatchObject({ status: 'cancelled' })
  expect(await store.findJobByKey('g2')).toMatchObject({ status: 'queued' })

  expect(await store.findOutbound('so.group:apr_1')).toMatchObject({ status: 'uncertain', evolutionMessageId: 'wa-group-1' })
  expect(await store.findOutbound('so.group:never')).toBeNull()

  // reservations last until the TSO is in SAP: approved but unsent still holds, in_sap does not (SAP's SO commits it)
  const held = (await store.stockOverlays(['ZFGC200'])).ZFGC200?.reserved ?? 0
  const otherPcs = other.order.lines.filter((line) => line.itemCode === 'ZFGC200').reduce((sum, line) => sum + line.reservedPcs, 0)
  expect(otherPcs > 0).toBe(true)
  await store.updateSalesOrder(other.order.id, { status: 'approved_unsent' })
  expect((await store.stockOverlays(['ZFGC200'])).ZFGC200?.reserved ?? 0).toBe(held)
  expect(await store.updateSalesOrder(other.order.id, { status: 'in_sap', sapDocEntry: 120, sapDocNo: 'SO/26-27/20' }, ['approved', 'approved_unsent', 'sent'])).toMatchObject({
    status: 'in_sap',
    sapDocEntry: 120,
    sapDocNo: 'SO/26-27/20',
    cess: 0,
    cancelledAt: null,
  })
  expect((await store.stockOverlays(['ZFGC200'])).ZFGC200?.reserved ?? 0).toBe(held - otherPcs)

  // cess round-trips on the order and its lines
  const withCess = await store.createSalesOrder(
    order(null, null, { cess: 43.54, taxTotal: 2563.54, total: 52963.54, lines: other.order.lines.map((line) => ({ ...line, cessAmount: 43.54 })) }),
    { series: 'TSO', fy: '28-29' },
  )
  expect(withCess.order).toMatchObject({ cess: 43.54, total: 52963.54 })
  expect(withCess.order.lines[0]).toMatchObject({ cessAmount: 43.54 })

  // an unposted receipt stops counting once closed, once only
  const [active] = await store.listStockAdjustments({ status: 'active' })
  const at = new Date('2026-04-03T10:00:00.000Z')
  expect(await store.closeStockAdjustment(active!.id, 'absorbed', 'In SAP on GR/26-27/20 of 2026-04-03.', at)).toMatchObject({ status: 'absorbed', closedAt: at.toISOString(), closedNote: 'In SAP on GR/26-27/20 of 2026-04-03.' })
  expect(await store.closeStockAdjustment(active!.id, 'cancelled', 'again', at)).toBeNull()
  expect(await store.getStockAdjustment(active!.id)).toMatchObject({ status: 'absorbed' })
  expect((await store.stockOverlays(['ZLAM'])).ZLAM?.adjustments ?? 0).toBe(0)

  // a finished task can be opened again with a fresh notice
  const task = await store.createTask({ title: 'Review PO 1', category: 'operations', kind: 'review', assigneeId: 'usr_anju', assigneeRole: 'office', subjectType: 'customer_po', subjectId: po.id, createdBy: 'usr_alex' })
  await store.markTaskNotified(task.id, 'wa-notice-1', new Date())
  await store.updateTaskStatus(task.id, 'done')
  expect(await store.reopenTask(task.id, { title: 'Review PO 1 again', description: 'Still no GSTIN.' })).toMatchObject({
    id: task.id, status: 'todo', title: 'Review PO 1 again', description: 'Still no GSTIN.', completedAt: null, notifiedAt: null, waMessageId: null,
  })

  // the office replaces the lines of a PO under review
  const lines = (await store.getCustomerPo(po.id))!.lines.map((line) => ({ ...line, itemCode: 'ZFGC200', matchMethod: 'manual' as const, matchConfirmed: true }))
  expect((await store.updateCustomerPoLines(po.id, lines))!.lines.map((line) => [line.itemCode, line.matchMethod, line.matchConfirmed])).toEqual(lines.map(() => ['ZFGC200', 'manual', true]))
  expect(await store.updateCustomerPoLines('cpo_missing', lines)).toBeNull()

  // a desk turn is stamped answered once; the thread shows it
  await store.claimMessage({ evolutionMessageId: 'desk-in-1', remoteJid: 'desk:usr_alex', fromMe: true, hasPdf: false, body: 'hi' })
  await store.claimMessage({ evolutionMessageId: 'desk-out-1', remoteJid: 'desk:usr_alex', fromMe: true, hasPdf: false, body: 'hello', purpose: 'agent_reply' })
  await store.markMessageAnswered('desk-in-1', at)
  await store.markMessageAnswered('desk-in-1', new Date('2030-01-01T00:00:00.000Z'))
  expect((await store.listThread('desk:usr_alex')).map((row) => [row.id, row.answeredAt])).toEqual([
    ['desk-in-1', at.toISOString()],
    ['desk-out-1', null],
  ])
  expect((await store.listRecentMessages(['desk:usr_alex'], 5)).map((row) => [row.id, row.purpose])).toEqual([
    ['desk-in-1', null],
    ['desk-out-1', 'agent_reply'],
  ])
}
