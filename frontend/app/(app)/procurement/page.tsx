import Link from 'next/link'
import { api } from '@/lib/api'
import type { ProcurementOrder } from '@/lib/types'

export default async function ProcurementPage() {
  const { orders } = await api<{ orders: ProcurementOrder[] }>('/api/procurement')
  return (
    <section className="sec">
      <div className="sechead">
        <div>
          <h3>Procurement</h3>
          <p>Items assigned to Joshy, including packs a purchase order could not cover</p>
        </div>
        <span className="zid">Zone 1 · Buy</span>
      </div>
      {orders.length === 0 ? (
        <div className="card empty">No procurement orders yet.</div>
      ) : (
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Purchase order</th>
                <th>Customer</th>
                <th>Item</th>
                <th className="r">Quantity</th>
                <th>Assignee</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td>
                    {order.orderId ? (
                      <Link href={`/orders/${order.orderId}`}>
                        <b>{order.poNumber}</b>
                      </Link>
                    ) : (
                      <b>{order.poNumber}</b>
                    )}
                    <div className="sub num">{order.id}</div>
                  </td>
                  <td>{order.customerName}</td>
                  <td>{order.itemName}</td>
                  <td className="r num">
                    {order.quantityKg} {order.unit}
                  </td>
                  <td>{order.assigneeName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
