import { describe, expect, it } from 'vitest'
import { describeRefs, findDates, findDocCandidates, normalizeDocNo, resolveRefs } from './refs'

describe('the reference pre-resolver', () => {
  it('reads full document numbers, cancellation series and short forms', () => {
    const found = findDocCandidates(
      'Check SO/26-27/445, tf / 26-27 / 0447, TFC-25/12 and PR 101; also invoice 5586, GRN#15 and sales order no. 9',
      '2026-10-07',
    )
    expect(found).toEqual([
      { text: 'SO/26-27/445', docNos: ['SO/26-27/445'] },
      { text: 'tf / 26-27 / 0447', docNos: ['TF/26-27/447'] },
      { text: 'TFC-25/12', docNos: ['TFC-25/12'] },
      { text: 'sales order no. 9', docNos: ['SO/26-27/9', 'SO/25-26/9'] },
      { text: 'invoice 5586', docNos: ['TF/26-27/5586', 'TF/25-26/5586'] },
      { text: 'PR 101', docNos: ['PR/26-27/101', 'PR/25-26/101'] },
      { text: 'GRN#15', docNos: ['GR/26-27/15', 'GR/25-26/15'] },
    ])
  })

  it('does not read ordinary words as document numbers', () => {
    expect(findDocCandidates('so 10 cartons went, po box 12', '2026-10-07')).toEqual([])
    expect(findDocCandidates('Acme Retail PO 4400012345', '2026-10-07')).toEqual([])
  })

  it('normalises what the model passes to a tool', () => {
    expect(normalizeDocNo('so 445', '2026-07-23')).toBe('SO/26-27/445')
    expect(normalizeDocNo('PR-101', '2026-03-31')).toBe('PR/25-26/101')
    expect(normalizeDocNo('tf/26-27/0447', '2026-10-07')).toBe('TF/26-27/447')
    expect(normalizeDocNo('can-26/3', '2026-10-07')).toBe('CAN-26/3')
    expect(normalizeDocNo('4400012345', '2026-10-07')).toBeNull()
    // Tierra's own numbers keep their padding
    expect(normalizeDocNo('tso 1', '2026-10-07')).toBe('TSO/26-27/0001')
    expect(normalizeDocNo('TSO/26-27/1', '2026-10-07')).toBe('TSO/26-27/0001')
    expect(normalizeDocNo('TSO/26-27/0012', '2026-10-07')).toBe('TSO/26-27/0012')
  })

  it('reads IST dates against the SAP data date', () => {
    expect(findDates('dispatch yesterday and today', '2026-10-07')).toEqual([
      { text: 'yesterday', date: '2026-10-06' },
      { text: 'today', date: '2026-10-07' },
    ])
    expect(findDates('what went on 15 July? and on Oct 20 or 2026-03-31, 05/04/2026', '2026-10-07')).toEqual([
      { text: '2026-03-31', date: '2026-03-31' },
      { text: '05/04/2026', date: '2026-04-05' },
      { text: '15 July', date: '2026-07-15' },
      { text: 'Oct 20', date: '2025-10-20' },
    ])
    expect(findDates('31 Feb', '2026-10-07')).toEqual([])
    expect(findDates('on 3 sept and 4th of December 2025', '2026-10-07')).toEqual([
      { text: '3 sept', date: '2026-09-03' },
      { text: '4th of December 2025', date: '2025-12-04' },
    ])
  })

  it('never reads ordinary words that start like a month as dates', () => {
    expect(findDates('mark 5 cartons as damaged', '2026-10-07')).toEqual([])
    expect(findDates('decrease 10 cartons on line 2', '2026-10-07')).toEqual([])
    expect(findDates('separate 3 boxes, 12 marked, junk 4, octane 9, augment 7', '2026-10-07')).toEqual([])
    expect(findDates('Mar 3 and 7 Mayhem', '2026-10-07')).toEqual([{ text: 'Mar 3', date: '2026-03-03' }])
  })

  it('reads TSO numbers padded and checks they exist; a customer group never gets one', async () => {
    const sapSql = (async () => []) as never
    const orders: Record<string, { docNo: string; status: 'pending_approval'; partyName: string; cardCode: string; total: number; customerPoNo: string }> = {
      'TSO/26-27/0001': { docNo: 'TSO/26-27/0001', status: 'pending_approval', partyName: 'Northwind', cardCode: 'ZN05', total: 52920, customerPoNo: '4400099999' },
    }
    const store = { findSalesOrderByNo: async (docNo: string) => (orders[docNo] ?? null) as never }
    expect(findDocCandidates('approve TSO/26-27/1 and TSO 7', '2026-10-07')).toEqual([
      { text: 'TSO/26-27/1', docNos: ['TSO/26-27/0001'] },
      { text: 'TSO 7', docNos: ['TSO/26-27/0007', 'TSO/25-26/0007'] },
    ])
    const internal = await resolveRefs(
      { sapSql, store },
      'what about TSO/26-27/1 and TSO 7?',
      { kind: 'internal', userId: 'usr_alex', name: 'Alex', role: 'admin' },
      '2026-10-07',
    )
    expect(describeRefs(internal)).toEqual([
      '"TSO/26-27/1" = TSO/26-27/0001 (a Tierra sales order, pending approval, Northwind, customer PO 4400099999, ₹52,920)',
      '"TSO 7" = TSO/26-27/0007: no such Tierra sales order',
    ])
    const party = await resolveRefs(
      { sapSql, store },
      'what about TSO/26-27/1?',
      { kind: 'party', partyGroupId: 'pg', name: 'Northwind', cardCodes: ['ZN05'], pans: [], groupSubject: null, speakerName: null },
      '2026-10-07',
    )
    expect(party).toEqual([])
  })

  it('gives a public audience dates only, without asking SAP', async () => {
    const sapSql = (() => {
      throw new Error('SAP must not be read for a public audience')
    }) as never
    const refs = await resolveRefs(
      { sapSql },
      'TF/26-27/101 on 15 July for 4400012345',
      { kind: 'public', reason: 'unknown_sender' },
      '2026-10-07',
    )
    expect(refs).toEqual([{ kind: 'date', text: '15 July', date: '2026-07-15' }])
    expect(describeRefs(refs)).toEqual(['"15 July" = 2026-07-15'])
  })
})
