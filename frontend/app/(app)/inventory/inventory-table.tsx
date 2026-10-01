'use client'

import { useMemo, useState } from 'react'
import type { InventoryItem, MaterialKind } from '@/lib/types'

const kindLabel: Record<MaterialKind, string> = {
  laminate: 'Laminate',
  seasoning: 'Seasoning',
  carton: 'Carton',
}

const ALL = 'all'

export function InventoryTable({ items }: { items: InventoryItem[] }) {
  const customers = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; code: string }>()
    for (const item of items) {
      if (!seen.has(item.customerId)) {
        seen.set(item.customerId, {
          id: item.customerId,
          name: item.customerName,
          code: item.customerCode,
        })
      }
    }
    return [...seen.values()]
  }, [items])
  const [customerId, setCustomerId] = useState(ALL)
  const rows = customerId === ALL ? items : items.filter((item) => item.customerId === customerId)
  const chosen = customers.find((customer) => customer.id === customerId)

  return (
    <section className="sec">
      <div className="sechead">
        <div>
          <h3>Customer materials</h3>
          <p>
            {chosen
              ? `${chosen.name} · ${chosen.code}. Laminate, seasonings, and cartons held for this customer.`
              : 'Laminate, seasonings, and cartons are held per customer. Finished-goods pouches stay on the order book.'}
          </p>
        </div>
        <label className="pick">
          <span>Customer</span>
          <select value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
            <option value={ALL}>All customers</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              {chosen ? null : <th>Customer</th>}
              <th>Material</th>
              <th>Item</th>
              <th>SKU</th>
              <th className="r">On hand</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <tr key={`${item.customerId}-${item.itemId}`}>
                {chosen ? null : (
                  <td>
                    <b>{item.customerName}</b>
                    <div className="sub">{item.customerCode}</div>
                  </td>
                )}
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
  )
}
