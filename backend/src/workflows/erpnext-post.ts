import type { AgentDeps } from '../agent/deps'
import type { SalesOrder } from '../db/types'
import { ErpnextError } from '../erp/erpnext/client'
import { linkSalesOrdersToSap } from './sap-sync'

/**
 * ERPNext build (ERP_BACKEND=erpnext): an approved TSO becomes a submitted Sales Order in ERPNext. With SAP the
 * office keys the order; here Tierra posts it through the REST API, then the mirror copies it back and the usual
 * link step (sap-sync.ts) marks the TSO in_sap. custom_tierra_ref is the TSO id, so a retry finds the order it
 * already posted instead of posting a second one.
 */

export const JOB_ERPNEXT_SO = 'erpnext.post_sales_order'
export const ERPNEXT_SO_ATTEMPTS = 5

/** The finished-goods warehouse orders reserve from (SAP FG01). */
const FG_WAREHOUSE = 'FG01'

export function erpnextJobKey(order: Pick<SalesOrder, 'id' | 'version'>): string {
  return `${JOB_ERPNEXT_SO}:${order.id}:${order.version}`
}

export type PostedOrder = { name: string; posted: boolean }

/** The ERPNext Sales Order for a TSO: its fields, its lines (pieces at the TSO's per-piece price) and GST. */
export function salesOrderDoc(
  order: SalesOrder,
  refs: { customer: string; warehouse: string | null; company: string; taxAccount: string; user: string | null },
): Record<string, unknown> & { doctype: string } {
  const transactionDate = order.docDate
  const delivery = order.deliveryDate && order.deliveryDate > transactionDate ? order.deliveryDate : transactionDate
  return {
    doctype: 'Sales Order',
    company: refs.company,
    customer: refs.customer,
    transaction_date: transactionDate,
    delivery_date: delivery,
    po_no: order.customerPoNo,
    po_date: order.poDate,
    disable_rounded_total: 1,
    items: order.lines.map((line) => ({
      item_code: line.itemCode,
      qty: line.pcs,
      rate: line.pcs ? Math.round((line.amount / line.pcs) * 1e6) / 1e6 : line.unitPrice,
      delivery_date: delivery,
      ...(refs.warehouse ? { warehouse: refs.warehouse } : {}),
    })),
    taxes: order.taxTotal
      ? [{ charge_type: 'Actual', account_head: refs.taxAccount, description: 'GST', tax_amount: order.taxTotal }]
      : [],
    custom_tierra_ref: order.id,
    custom_tierra_user: refs.user,
    custom_numatcard: order.customerPoNo,
    docstatus: 1,
  }
}

export async function postSalesOrderToErpnext(deps: AgentDeps, salesOrderId: string): Promise<PostedOrder | null> {
  const erpnext = deps.erpnext
  if (!erpnext) return null
  const order = await deps.store.getSalesOrder(salesOrderId)
  if (!order || order.status === 'cancelled' || order.status === 'rejected') return null
  const client = erpnext.client
  const existing = await client.list<{ name: string }>(
    'Sales Order',
    [
      ['custom_tierra_ref', '=', order.id],
      ['docstatus', '!=', 2],
    ],
    ['name'],
    1,
  )
  let name = existing[0]?.name ?? null
  let posted = false
  if (!name) {
    const [customer] = await client.list<{ name: string }>('Customer', [['custom_sap_ref', '=', order.cardCode]], ['name'], 1)
    if (!customer) throw new Error(`ERPNext has no customer for card ${order.cardCode}`)
    const [warehouse] = await client.list<{ name: string }>('Warehouse', [['custom_sap_ref', '=', FG_WAREHOUSE]], ['name'], 1)
    const [tax] = await client.list<{ name: string }>(
      'Account',
      [
        ['account_name', '=', 'Output GST'],
        ['company', '=', client.config.company],
      ],
      ['name'],
      1,
    )
    const doc = salesOrderDoc(order, {
      customer: customer.name,
      warehouse: warehouse?.name ?? null,
      company: client.config.company,
      taxAccount: tax?.name ?? `Output GST`,
      // the Tierra user id of the approver; ERPNext's own owner is the service user
      user: order.approvedBy,
    })
    try {
      name = (await client.insert(doc)).name
      posted = true
    } catch (error) {
      if (error instanceof ErpnextError) {
        console.error(`ERPNext refused ${order.docNo}: ${error.message}`)
      }
      throw error
    }
    console.log(`${order.docNo} posted to ERPNext as ${name}`)
  }
  // bring it back into the read model now, then link the TSO to it (status in_sap)
  await erpnext.syncNow()
  await linkSalesOrdersToSap(deps)
  return { name, posted }
}
