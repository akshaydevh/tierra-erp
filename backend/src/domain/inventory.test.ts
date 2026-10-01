import { describe, expect, it } from 'vitest'
import { availableQuantity, CustomerInventory, shortLineCount } from './inventory'
import { decideIntake, matchCustomer } from './intake'
import { seedBalances, seedCustomers, seedItems, seedMaterialItems } from '../db/seed-data'

describe('customer material stock', () => {
  const inventory = CustomerInventory.from(
    [...seedItems, ...seedMaterialItems],
    seedBalances,
    seedCustomers,
  )

  it('keeps laminate, seasoning, and cartons on the customer that owns them', () => {
    expect(inventory.forCustomer('cus_beyond').map((row) => row.kind)).toEqual([
      'laminate',
      'seasoning',
      'carton',
    ])
    expect(inventory.onHand('cus_beyond', 'laminate')).toBe(860)
    expect(inventory.onHand('cus_guiltfree', 'seasoning')).toBe(96)
    expect(inventory.onHand('cus_reliance', 'carton')).toBe(175)
    expect(inventory.rows.some((row) => row.sku === 'BAN-80G')).toBe(false)
  })
})

describe('inventory math', () => {
  it('subtracts open-order reservations from on-hand stock', () => {
    expect(availableQuantity(40, 100)).toBe(-60)
    expect(availableQuantity(4800, 800)).toBe(4000)
  })

  it('counts open lines whose item is already overdrawn', () => {
    const available = new Map([
      ['item_ban40', 4000],
      ['item_ban80', -60],
    ])
    expect(
      shortLineCount(
        [
          { itemId: 'item_ban40', status: 'open' },
          { itemId: 'item_ban80', status: 'open' },
          { itemId: 'item_ban40', status: 'closed' },
        ],
        available,
      ),
    ).toBe(1)
  })
})

describe('purchase order intake', () => {
  const available = new Map([
    ['item_ban40', 4000],
    ['item_ban80', -60],
    ['item_cas50', 2000],
  ])

  it('refuses a short line and keeps a covered line', () => {
    const short = decideIntake(
      {
        customerName: 'Beyond Snack',
        poNumber: 'PO-1',
        poDate: null,
        lines: [
          { description: 'Banana chips 80g', quantity: 10, unit: 'pouch', buyerCode: 'BAN-80G', price: null },
        ],
      },
      seedCustomers,
      seedItems,
      available,
    )
    expect(short.kind).toBe('short')

    const ok = decideIntake(
      {
        customerName: 'Beyond Snack Pvt Ltd',
        poNumber: 'PO-2',
        poDate: '2026-09-01',
        lines: [
          { description: 'chips', quantity: 12, unit: null, buyerCode: 'BAN-40G', price: 12.5 },
        ],
      },
      seedCustomers,
      seedItems,
      available,
    )
    expect(ok.kind).toBe('ok')
    if (ok.kind === 'ok') {
      expect(ok.customerId).toBe('cus_beyond')
      expect(ok.lines[0]?.quantity).toBe(12)
      expect(ok.lines[0]?.unitPrice).toBe('12.50')
    }
  })

  it('does not match a one-letter customer name by inclusion', () => {
    expect(matchCustomer('a', seedCustomers)).toBeUndefined()
  })
})
