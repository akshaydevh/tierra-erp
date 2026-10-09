import { describe, expect, it } from 'vitest'
import type { ItemFacts } from '../queries/po'
import { computeCheck, type CheckFacts } from './po-check'

// Invented items: ZFG500 (500 g, 30 per carton) with a full BOM per 10,000 pieces; ZFG60 with placeholder lines.
function item(itemCode: string, role: string, uom: string | null, extra: Partial<ItemFacts> = {}): ItemFacts {
  return { itemCode, itemName: `${itemCode} name`, role, uom, pcsPerCarton: null, packGrams: null, active: true, hasBom: false, ...extra }
}

const manual = (componentCode: string, qtyPerBasis: number, isPlaceholder = false) => ({
  componentCode,
  basisQty: 10000,
  qtyPerBasis,
  issueMethod: 'manual' as const,
  isPlaceholder,
})

function facts(overrides: Partial<CheckFacts> = {}): CheckFacts {
  return {
    items: {
      ZFG500: item('ZFG500', 'fg', 'pcs', { pcsPerCarton: 30, packGrams: 500, hasBom: true }),
      ZFG60: item('ZFG60', 'fg', 'pcs', { pcsPerCarton: 42, packGrams: 60, hasBom: true }),
      ZLAM: item('ZLAM', 'laminate', 'kg'),
      ZLAMPC: item('ZLAMPC', 'laminate', 'pcs'),
      ZCTN: item('ZCTN', 'carton', 'nos'),
      ZSALT: item('ZSALT', 'seasoning', 'kg'),
      ZBAN: item('ZBAN', 'raw_banana', 'kg'),
      ZOIL: item('ZOIL', 'oil', null),
      ZTAPE: item('ZTAPE', 'tape', null),
      ZLPG: item('ZLPG', 'consumable', 'kg'),
      ZPOWER: item('ZPOWER', 'overhead', 'kwh'),
      ZBAG: item('ZBAG', 'other', null),
    },
    boms: {
      ZFG500: [
        manual('ZOIL', 1250),
        manual('ZSALT', 40),
        manual('ZCTN', 333.33),
        manual('ZLAM', 110),
        manual('ZBAG', 4),
        manual('ZTAPE', 20),
        manual('ZLPG', 700),
        manual('ZBAN', 17000),
        { componentCode: 'ZPOWER', basisQty: 10000, qtyPerBasis: 1500, issueMethod: 'backflush', isPlaceholder: false },
      ],
      ZFG60: [manual('ZBAN', 1, true), manual('ZSALT', 1, true), manual('ZLAMPC', 10000), manual('ZCTN', 238.1)],
    },
    stock: {
      ZFG500: { onHand: 400, committed: 1900, onOrder: 0 },
      ZFG60: { onHand: 100, committed: 0, onOrder: 0 },
      ZLAM: { onHand: 90, committed: 0, onOrder: 0 },
      ZLAMPC: { onHand: 5000, committed: 0, onOrder: 0 },
      ZCTN: { onHand: 30, committed: 22, onOrder: 500 },
      ZSALT: { onHand: 0.5, committed: 2.5, onOrder: 200 },
      ZBAN: { onHand: 30000, committed: 5000, onOrder: 0 },
      ZOIL: { onHand: 1400, committed: 300, onOrder: 5 },
      ZTAPE: { onHand: 0, committed: 0, onOrder: 0 },
      ZLPG: { onHand: 5000, committed: 0, onOrder: 0 },
    },
    overlays: {},
    ownership: {},
    overrides: [],
    usage: { ZFG60: { ZSALT: 0.0066 } },
    incoming: { ZCTN: ['PO/25-26/45'], ZSALT: ['PO/25-26/54'] },
    ...overrides,
  }
}

const line = (result: ReturnType<typeof computeCheck>, code: string) => result.lines.find((row) => row.itemCode === code)!

describe('the inventory check', () => {
  it('makes what free stock cannot cover and passes when open purchase orders cover the rest', () => {
    const result = computeCheck([{ itemCode: 'ZFG500', pcs: 360 }], facts())
    expect(line(result, 'ZFG500')).toMatchObject({ kind: 'fg', need: 360, free: -1500, fromStock: 0, toMake: 360, status: 'ok' })
    expect(line(result, 'ZLAM')).toMatchObject({ need: 3.96, free: 90, shortNow: 0, status: 'ok', checked: true })
    // carton = ceil(360 / 30), not the BOM's 333.33 per 10,000
    expect(line(result, 'ZCTN')).toMatchObject({ need: 12, free: 8, shortNow: 4, shortAfterIncoming: 0, status: 'short_now', incoming: ['PO/25-26/45'] })
    expect(line(result, 'ZSALT')).toMatchObject({ need: 1.44, free: -2, shortNow: 1.44, shortAfterIncoming: 0, status: 'short_now' })
    expect(line(result, 'ZBAN')).toMatchObject({ need: 612, status: 'ok' })
    expect(line(result, 'ZOIL')).toMatchObject({ need: 45, status: 'ok' })
    // warnings only; backflushed overheads and bulk bags are not listed
    expect(line(result, 'ZTAPE')).toMatchObject({ checked: false, status: 'short' })
    expect(line(result, 'ZLPG')).toMatchObject({ checked: false, status: 'ok' })
    expect(result.lines.some((row) => row.itemCode === 'ZPOWER' || row.itemCode === 'ZBAG')).toBe(false)
    expect(result.verdict).toBe('pass_with_incoming')
  })

  it('fails when a checked material stays short after incoming', () => {
    const result = computeCheck([{ itemCode: 'ZFG500', pcs: 10000 }], facts())
    expect(line(result, 'ZLAM')).toMatchObject({ need: 110, shortNow: 20, shortAfterIncoming: 20, status: 'short' })
    expect(line(result, 'ZOIL')).toMatchObject({ need: 1250, shortNow: 150, shortAfterIncoming: 145, status: 'short' })
    expect(line(result, 'ZCTN')).toMatchObject({ need: 334, status: 'short_now' })
    expect(result.verdict).toBe('fail')
  })

  it('serves from finished stock first and nets reservations and adjustments (the P4 hook)', () => {
    const plenty = facts({ stock: { ...facts().stock, ZFG500: { onHand: 1000, committed: 0, onOrder: 0 } } })
    const fromStock = computeCheck([{ itemCode: 'ZFG500', pcs: 400 }, { itemCode: 'ZFG500', pcs: 100 }], plenty)
    expect(line(fromStock, 'ZFG500')).toMatchObject({ need: 500, fromStock: 500, toMake: 0 })
    expect(fromStock.lines).toHaveLength(1)
    expect(fromStock.verdict).toBe('pass')

    const reserved = computeCheck([{ itemCode: 'ZFG500', pcs: 500 }], { ...plenty, overlays: { ZFG500: { reserved: 700, adjustments: 30 } } })
    expect(line(reserved, 'ZFG500')).toMatchObject({ free: 330, fromStock: 330, toMake: 170, reserved: 700, adjustments: 30 })
  })

  it('estimates placeholder lines and counts piece laminates whole', () => {
    const result = computeCheck([{ itemCode: 'ZFG60', pcs: 4300 }], facts())
    expect(line(result, 'ZFG60')).toMatchObject({ toMake: 4200 })
    // banana: 4,200 x 60 g / 1000 x 3.571 kg per kg of chips
    expect(line(result, 'ZBAN')).toMatchObject({ need: 899.892, estimated: true })
    // seasoning: 90-day actual use per piece
    expect(line(result, 'ZSALT')).toMatchObject({ need: 27.72, estimated: true })
    expect(line(result, 'ZLAMPC')).toMatchObject({ need: 4200, uom: 'pcs', estimated: false })
    expect(line(result, 'ZCTN')).toMatchObject({ need: 100 })
  })

  it('marks customer-supplied material with its owner, and an override wins', () => {
    const owned = facts({
      ownership: {
        ZLAM: { customerSupplied: true, ownerCardCode: 'ZC001', ownerName: 'Alpha Snacks' },
        ZCTN: { customerSupplied: true, ownerCardCode: null, ownerName: null },
      },
      overrides: [{ itemCode: 'ZSALT', owner: 'customer', ownerCardCode: 'ZC002', note: null }],
    })
    const result = computeCheck([{ itemCode: 'ZFG500', pcs: 360 }], owned)
    expect(line(result, 'ZLAM')).toMatchObject({ owner: 'customer', ownerCardCode: 'ZC001', ownerName: 'Alpha Snacks' })
    expect(line(result, 'ZCTN')).toMatchObject({ owner: 'customer_unknown' })
    expect(line(result, 'ZSALT')).toMatchObject({ owner: 'customer', ownerCardCode: 'ZC002' })
    expect(line(result, 'ZOIL')).toMatchObject({ owner: 'tierra' })
  })

  it('cannot pass a finished good that has to be made but has no BOM', () => {
    const result = computeCheck([{ itemCode: 'ZFG500', pcs: 10 }], facts({ boms: {} }))
    expect(line(result, 'ZFG500')).toMatchObject({ status: 'short', toMake: 10 })
    expect(result.warnings[0]).toContain('no bill of materials')
    expect(result.verdict).toBe('fail')
  })
})
