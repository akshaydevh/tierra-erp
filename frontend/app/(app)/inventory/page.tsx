import { api } from '@/lib/api'
import type { InventoryItem, MaterialKind } from '@/lib/types'

const kindLabel: Record<MaterialKind, string> = {
  laminate: 'Laminate',
  seasoning: 'Seasoning',
  carton: 'Carton',
}

function byCustomer(items: InventoryItem[]) {
  const groups: Array<{ customerId: string; customerName: string; customerCode: string; rows: InventoryItem[] }> = []
  for (const item of items) {
    const current = groups.at(-1)
    if (current?.customerId === item.customerId) {
      current.rows.push(item)
      continue
    }
    groups.push({
      customerId: item.customerId,
      customerName: item.customerName,
      customerCode: item.customerCode,
      rows: [item],
    })
  }
  return groups
}

export default async function InventoryPage() {
  const { items } = await api<{ items: InventoryItem[] }>('/api/inventory')
  const groups = byCustomer(items)
  return (
    <>
      <section className="sec">
        <div className="sechead">
          <div>
            <h3>Customer materials</h3>
            <p>
              Laminate, seasonings, and cartons are held per customer. Finished-goods pouches stay on the order book.
            </p>
          </div>
          <span className="zid">Zone 1 · Stock</span>
        </div>
      </section>
      {groups.map((group) => (
        <section className="sec" key={group.customerId}>
          <div className="sechead">
            <div>
              <h3>{group.customerName}</h3>
              <p>{group.customerCode}</p>
            </div>
          </div>
          <div className="tblwrap">
            <table>
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Item</th>
                  <th>SKU</th>
                  <th className="r">On hand</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((item) => (
                  <tr key={item.itemId}>
                    <td>{kindLabel[item.kind]}</td>
                    <td>
                      <b>{item.name}</b>
                    </td>
                    <td className="num">{item.sku}</td>
                    <td className="r num">
                      {item.onHand} {item.unit}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  )
}
