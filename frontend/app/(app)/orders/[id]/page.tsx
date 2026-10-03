import Link from 'next/link'
import { api } from '@/lib/api'
import type { OrderDetail } from '@/lib/types'

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { order } = await api<{ order: OrderDetail }>(`/api/orders/${id}`)
  return (
    <div className="detail">
      <div className="sec">
        <div className="sechead">
          <div>
            <h3>{order.poNumber}</h3>
            <p>
              {order.customerName}
              {order.poDate ? ` · ${order.poDate}` : ''}
            </p>
          </div>
          <span className={order.status === 'open' ? 'pill ok' : 'pill grey'}>{order.status}</span>
        </div>
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>SKU</th>
                <th className="r">Quantity</th>
                <th className="r">Price</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    <b>{line.itemName}</b>
                    <div className="sub">{line.description}</div>
                  </td>
                  <td className="num">{line.sku}</td>
                  <td className="r num">
                    {line.quantity} {line.unit}
                  </td>
                  <td className="r num">{line.unitPrice ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {order.production ? (
          <p>
            Production entry {order.production.id}: {order.production.finishedGoodsKg} kg of chips needs{' '}
            {order.production.bananaKg} kg of banana ({order.production.kgBananaPerKgChips} kg banana per kg,{' '}
            {order.production.sourceMonths}). <Link href="/production">Production</Link>
          </p>
        ) : null}
        {order.procurement ? (
          <p>
            Procurement order {order.procurement.id} for {order.procurement.quantityKg} {order.procurement.unit} of{' '}
            {order.procurement.itemName} is assigned to {order.procurement.assigneeName}.{' '}
            <Link href="/procurement">Procurement</Link>
          </p>
        ) : null}
        {order.hasDocument ? (
          <p>
            <a className="btn-sec" href={`/api/orders/${order.id}/document`} target="_blank" rel="noreferrer">
              Open PDF
            </a>
          </p>
        ) : null}
        <p>
          <Link href="/orders">Back to orders</Link>
        </p>
      </div>
      <aside className="rail">
        <article className="card p6">
          <div className="zid">History</div>
          <ol className="mslist">
            <li className="msrow">
              <span className="msi">1</span>
              <div>
                <b>Received</b>
                <div className="stamp">Source {order.source}</div>
              </div>
            </li>
            <li className="msrow">
              <span className="msi">2</span>
              <div>
                <b>Stock checked</b>
                <div className="stamp">
                  {order.procurement
                    ? `Banana procurement assigned to ${order.procurement.assigneeName}`
                    : order.source === 'whatsapp'
                      ? 'Accepted from the purchase-order PDF'
                      : 'Seeded with the preview balances'}
                </div>
              </div>
            </li>
            <li className="msrow">
              <span className="msi">3</span>
              <div>
                <b>{order.status === 'open' ? 'Open' : 'Closed'}</b>
                <div className="stamp num">{order.createdAt.slice(0, 10)}</div>
              </div>
            </li>
          </ol>
        </article>
      </aside>
    </div>
  )
}
