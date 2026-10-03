import Link from 'next/link'
import { api } from '@/lib/api'
import type { ProductionEntry } from '@/lib/types'

export default async function ProductionPage() {
  const { entries } = await api<{ entries: ProductionEntry[] }>('/api/production')
  return (
    <section className="sec">
      <div className="sechead">
        <div>
          <h3>Production</h3>
          <p>Finished-goods kilograms from a customer purchase order, and the banana that yield requires</p>
        </div>
        <span className="zid">Zone 1 · Make</span>
      </div>
      {entries.length === 0 ? (
        <div className="card empty">No production entries yet.</div>
      ) : (
        <div className="tblwrap">
          <table>
            <thead>
              <tr>
                <th>Purchase order</th>
                <th>Customer</th>
                <th className="r">Finished goods</th>
                <th className="r">Banana per kg</th>
                <th className="r">Banana</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <Link href={`/orders/${entry.orderId}`}>
                      <b>{entry.poNumber}</b>
                    </Link>
                    <div className="sub">{entry.sourceMonths}</div>
                  </td>
                  <td>{entry.customerName}</td>
                  <td className="r num">{entry.finishedGoodsKg} kg</td>
                  <td className="r num">{entry.kgBananaPerKgChips}</td>
                  <td className="r num">{entry.bananaKg} kg</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
