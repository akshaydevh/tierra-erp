import type { AgentDeps } from '../agent/deps'
import { partyCardCodes } from '../agent/scope'
import type { SalesOrderStatus } from '../db/types'
import { importMeta, isNotImported } from '../queries/meta'
import { sapOrdersForPo } from '../queries/po'
import { grnLinesSince } from '../queries/purchasing'

/**
 * After every SAP import (the worker checks hourly, and at boot) Tierra's own records catch up with SAP (review C1, C2):
 * - a TSO the office has keyed into SAP is linked to that sales order and becomes in_sap: SAP's open SO now commits
 *   the pieces, so the TSO stops reserving them (it would count them twice);
 * - an unposted receipt is absorbed once SAP has a GRN line of the same item dated on or after it, or after 14 days.
 */

/** TSOs that can be linked: approved, the customer copy sent or not. The office keys the SO after approval. */
const LINKABLE: readonly SalesOrderStatus[] = ['approved', 'approved_unsent', 'sent']
/** An unposted receipt with no GRN after this long has surely been posted (or was wrong): it stops counting. */
export const ADJUSTMENT_MAX_AGE_MS = 14 * 24 * 60 * 60_000

type Deps = Pick<AgentDeps, 'store' | 'sapSql' | 'now'>

function istDay(at: string | Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(at))
}

/**
 * Links TSOs to the SAP sales orders keyed for them: same customer PO number, a card of the TSO's party (or its own
 * card), dated on or after the TSO, not cancelled, not already seen when the PO came in (a repeat's earlier SO), and
 * not linked to another TSO. Returns the TSOs linked.
 */
export async function linkSalesOrdersToSap(deps: Deps): Promise<Array<{ docNo: string; sapDocNo: string }>> {
  const orders = await deps.store.listSalesOrders({ limit: 1000 })
  const taken = new Set(orders.map((order) => order.sapDocEntry).filter((entry): entry is number => entry != null))
  const linked: Array<{ docNo: string; sapDocNo: string }> = []
  for (const order of orders) {
    if (!LINKABLE.includes(order.status) || !order.customerPoNo || order.sapDocEntry != null) continue
    const party = order.partyGroupId ? await deps.store.getPartyGroup(order.partyGroupId) : null
    const cards = party
      ? await partyCardCodes(
          deps.sapSql,
          party.members.filter((m) => m.kind === 'pan').map((m) => m.value),
          party.members.filter((m) => m.kind === 'card_code').map((m) => m.value),
        )
      : []
    const po = order.customerPoId ? await deps.store.getCustomerPo(order.customerPoId) : null
    const seenBefore = new Set((po?.repeatOf ?? []).filter((hit) => hit.source === 'sap').map((hit) => hit.docNo))
    const hit = (await sapOrdersForPo(deps.sapSql, order.customerPoNo, [...new Set([...cards, order.cardCode])])).find(
      (row) => row.status !== 'cancelled' && !seenBefore.has(row.docNo) && !taken.has(row.docEntry) && (row.docDate ?? '') >= order.docDate,
    )
    if (!hit) continue
    const updated = await deps.store.updateSalesOrder(order.id, { status: 'in_sap', sapDocEntry: hit.docEntry, sapDocNo: hit.docNo }, LINKABLE)
    if (!updated) continue
    taken.add(hit.docEntry)
    linked.push({ docNo: order.docNo, sapDocNo: hit.docNo })
    console.log(`${order.docNo} is in SAP as ${hit.docNo}: it no longer reserves stock`)
  }
  return linked
}

/** Absorbs unposted receipts SAP now has (a GRN line of the item on or after the receipt day) or that are 14 days old. */
export async function absorbStockAdjustments(deps: Deps): Promise<Array<{ id: string; itemCode: string; note: string }>> {
  const active = await deps.store.listStockAdjustments({ status: 'active', limit: 1000 })
  if (!active.length) return []
  const now = deps.now()
  const since = active.map((row) => istDay(row.effectiveAt)).sort()[0]!
  const grns = await grnLinesSince(deps.sapSql, [...new Set(active.map((row) => row.itemCode))], since)
  const absorbed: Array<{ id: string; itemCode: string; note: string }> = []
  for (const adjustment of active) {
    const day = istDay(adjustment.effectiveAt)
    const grn = grns.find((row) => row.itemCode === adjustment.itemCode && row.docDate >= day)
    const old = now.getTime() - Date.parse(adjustment.effectiveAt) > ADJUSTMENT_MAX_AGE_MS
    if (!grn && !old) continue
    const note = grn ? `In SAP on ${grn.docNo} of ${grn.docDate}.` : 'No GRN in SAP after 14 days; no longer counted.'
    if (await deps.store.closeStockAdjustment(adjustment.id, 'absorbed', note, now)) absorbed.push({ id: adjustment.id, itemCode: adjustment.itemCode, note })
  }
  return absorbed
}

export type SyncResult = { linked: Array<{ docNo: string; sapDocNo: string }>; absorbed: Array<{ id: string; itemCode: string; note: string }> }

/** Both passes; nothing to do (and no error) before the first SAP import. */
export async function syncWithSap(deps: Deps): Promise<SyncResult> {
  try {
    if (!(await importMeta(deps.sapSql)).importedAt) return { linked: [], absorbed: [] }
    return { linked: await linkSalesOrdersToSap(deps), absorbed: await absorbStockAdjustments(deps) }
  } catch (error) {
    if (isNotImported(error)) return { linked: [], absorbed: [] }
    throw error
  }
}

/**
 * The worker's watch: runs the sync at boot, whenever the SAP import time changes, and at least hourly. Returns a
 * function to call every few minutes.
 */
export function sapSyncWatch(deps: Deps, everyMs = 60 * 60_000): () => Promise<void> {
  let lastImport: string | null | undefined
  let lastRun = 0
  return async () => {
    const importedAt = (await importMeta(deps.sapSql)).importedAt
    const now = deps.now().getTime()
    if (importedAt === lastImport && now - lastRun < everyMs) return
    lastImport = importedAt
    lastRun = now
    const result = await syncWithSap(deps)
    if (result.linked.length || result.absorbed.length) {
      console.log(`SAP sync: ${result.linked.length} TSO(s) linked, ${result.absorbed.length} unposted receipt(s) absorbed`)
    }
  }
}
