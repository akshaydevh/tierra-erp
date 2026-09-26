import { api } from '@/lib/api'
import type { InventoryItem } from '@/lib/types'

export default async function InventoryPage() {
  const { items } = await api<{ items: InventoryItem[] }>('/api/inventory')
  return (
    <section className="sec">
      <div className="sechead">
        <div>
          <h3>Finished goods</h3>
          <p>Available is on hand minus quantities already on open orders. Creating an order does not reduce on hand.</p>
        </div>
        <span className="zid">Zone 1 · Stock</span>
      </div>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>SKU</th>
              <th className="r">On hand</th>
              <th className="r">Reserved</th>
              <th className="r">Available</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.itemId}>
                <td>
                  <b>{item.name}</b>
                  <div className="sub">{item.unit}</div>
                </td>
                <td className="num">{item.sku}</td>
                <td className="r num">{item.onHand}</td>
                <td className="r num">{item.reserved}</td>
                <td className={`r num${item.available < 0 ? ' neg' : ''}`}>{item.available}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
