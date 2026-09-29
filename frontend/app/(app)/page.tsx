import Link from 'next/link'
import { api } from '@/lib/api'
import type { CommandCentre } from '@/lib/types'

function whatsappLabel(status: CommandCentre['whatsapp']['status']): string {
  if (status === 'connected') return 'Connected'
  if (status === 'qr_pending') return 'Waiting'
  return 'Off'
}

export default async function CommandCentrePage() {
  const data = await api<CommandCentre>('/api/command-centre')
  return (
    <>
      <section className="grid3">
        <article className="card p6 kpi">
          <div className="top">
            <div className="chip ink">PO</div>
          </div>
          <div className="lab">Open orders</div>
          <div className="val num">{data.openOrders}</div>
          <div className="stamp">Customer purchase orders still open</div>
        </article>
        <article className={`card p6 kpi${data.shortLines > 0 ? ' attn' : ''}`}>
          <div className="top">
            <div className="chip amber">!</div>
          </div>
          <div className="lab">Lines short of stock</div>
          <div className="val num">{data.shortLines}</div>
          <div className="stamp">Open lines on items already overdrawn</div>
        </article>
        <article className="card p6 kpi">
          <div className="top">
            <div className="chip leaf">WA</div>
          </div>
          <div className="lab">WhatsApp</div>
          <div className="val">{whatsappLabel(data.whatsapp.status)}</div>
          <div className="stamp">{data.whatsapp.phoneNumber ?? 'Not linked'}</div>
        </article>
      </section>
      <section className="sec">
        <div className="sechead">
          <div>
            <h3>Recent orders</h3>
            <p>Newest customer purchase orders in the preview database</p>
          </div>
          <span className="zid">Zone 1 · Orders</span>
        </div>
        <OrderTable orders={data.recentOrders} />
      </section>
    </>
  )
}

function OrderTable({
  orders,
}: {
  orders: Array<{
    id: string
    poNumber: string
    customerName: string
    status: 'open' | 'closed'
    source: 'seed' | 'whatsapp'
    poDate: string | null
    lineCount: number
  }>
}) {
  if (orders.length === 0) return <div className="card empty">No orders yet.</div>
  return (
    <div className="tblwrap">
      <table>
        <thead>
          <tr>
            <th>Purchase order</th>
            <th>Customer</th>
            <th>Status</th>
            <th>Source</th>
            <th className="r">Lines</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id}>
              <td>
                <Link href={`/orders/${order.id}`}>
                  <b>{order.poNumber}</b>
                </Link>
                <div className="sub num">{order.poDate ?? 'No date'}</div>
              </td>
              <td>{order.customerName}</td>
              <td>
                <span className={order.status === 'open' ? 'pill ok' : 'pill grey'}>{order.status}</span>
              </td>
              <td>
                <span className="pill grey">{order.source}</span>
              </td>
              <td className="r num">{order.lineCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
