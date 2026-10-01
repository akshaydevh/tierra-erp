'use client'

import { useMemo, useState } from 'react'
import type { InventoryItem, MaterialKind } from '@/lib/types'

const kindLabel: Record<MaterialKind, string> = {
  laminate: 'Laminate',
  seasoning: 'Seasoning',
  carton: 'Carton',
}

export function InventoryTable({ items }: { items: InventoryItem[] }) {
  const groups = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; code: string; rows: InventoryItem[] }>()
    for (const item of items) {
      const group = seen.get(item.customerId)
      if (group) {
        group.rows.push(item)
        continue
      }
      seen.set(item.customerId, {
        id: item.customerId,
        name: item.customerName,
        code: item.customerCode,
        rows: [item],
      })
    }
    return [...seen.values()]
  }, [items])
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <section className="sec">
      <div className="sechead">
        <div>
          <h3>Customer materials</h3>
          <p>Each customer holds their own laminate, seasonings, and cartons. Open a customer to see the stock.</p>
        </div>
        <span className="zid">Zone 1 · Stock</span>
      </div>
      {groups.map((group) => {
        const open = openId === group.id
        return (
          <div className="tblwrap" key={group.id}>
            <button
              type="button"
              className="drophead"
              aria-expanded={open}
              onClick={() => setOpenId(open ? null : group.id)}
            >
              <span>
                <b>{group.name}</b>
                <span className="sub">{group.code}</span>
              </span>
              <span className="dropmark">{open ? 'Hide items' : 'Show items'}</span>
            </button>
            {open ? (
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
            ) : null}
          </div>
        )
      })}
    </section>
  )
}
