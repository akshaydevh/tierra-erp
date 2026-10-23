import { describe, expect, it } from 'vitest'
import { batchCodeDistance, matchKind, normalizeBatchCode, rankBatches, type BatchCandidate } from './batches'

const batch = (batchId: number, batchNo: string, itemCode: string, itemName: string, inDate = '2026-09-07'): BatchCandidate => ({
  batchId,
  batchNo,
  itemCode,
  itemName,
  inDate,
  onHand: 0,
})

// codes as they are in SAP: one run packed as 65 g and 35 g shares its code
const BATCHES = [
  batch(3031, 'KBCS07I26', 'FGKBKOS65', 'Kappo Banana Chips  Classic Salted  65g'),
  batch(3032, 'KBCS07I26', 'FGKBKOS35', 'Kappo Banana Chips  Classic Salted  35g'),
  batch(2169, 'KBCS07L25', 'FGKBKOS65', 'Kappo Banana Chips  Classic Salted  65g', '2025-12-07'),
  batch(3030, 'KBCG07I26', 'FGKBKCG65', 'Kappo Banana Chips  Chilli Garlic  65g'),
  batch(998, 'TFB09J24-B', 'FGFBOS170', 'Fabsta Banana chips Salted 170g', '2024-10-09'),
]

describe('batch code matching', () => {
  it('ignores case and separators', () => {
    expect(normalizeBatchCode(' tfb09j24-b ')).toBe('TFB09J24B')
    expect(batchCodeDistance('TFB 09J24 B', 'TFB09J24-B')).toBe(0)
  })

  it('charges little for look-alike characters and fully for others', () => {
    expect(batchCodeDistance('KBCS07126', 'KBCS07I26')).toBe(0.25)
    expect(batchCodeDistance('KBCS0TI26', 'KBCS07I26')).toBe(0.25)
    expect(batchCodeDistance('KBCS07X26', 'KBCS07I26')).toBe(1)
    // I and L are both month letters: never a cheap swap
    expect(batchCodeDistance('KBCS07L26', 'KBCS07I26')).toBe(1)
  })

  it('grades matches', () => {
    expect(matchKind(0, 9)).toBe('exact')
    expect(matchKind(1.25, 10)).toBe('close')
    expect(matchKind(2, 9)).toBe('possible')
    expect(matchKind(3, 9)).toBeNull()
  })

  it('finds the misread KBCS077126 as KBCS07I26 and puts the pack size asked for first', () => {
    const matches = rankBatches('KBCS077126', BATCHES, 'Kappo Classic Salted 35 g')
    expect(matches[0]).toMatchObject({ batchId: 3032, batchNo: 'KBCS07I26', match: 'close', distance: 1.25 })
    expect(matches[1]).toMatchObject({ batchId: 3031, batchNo: 'KBCS07I26' })
    expect(matches.map((m) => m.batchNo)).not.toContain('TFB09J24-B')
  })

  it('returns nothing for a code too short or too far from any batch', () => {
    expect(rankBatches('KB', BATCHES)).toEqual([])
    expect(rankBatches('ZZZZ99999', BATCHES)).toEqual([])
  })
})
