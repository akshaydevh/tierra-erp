import Link from 'next/link'
import { api } from '@/lib/api'
import type { OrderListItem } from '@/lib/types'

export default async function OrdersPage() {
  const { orders } = await api<{ orders: OrderListItem[] }>('/api/orders')
  return (
    <section className="sec">
      <div className="sechead">
        <div>
          <h3>Customer purchase orders</h3>
          <p>Seeded orders and purchase orders read from WhatsApp or Tierra Agent</p>
        </div>
        <span className="zid">Zone 1 · Book</span>
      </div>
      {orders.length === 0 ? (
        <div className="card empty">No orders yet.</div>
      ) : (
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
      )}
    </section>
  )
}
