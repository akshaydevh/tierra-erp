import type { Store } from '../db/store'

type Expect = (value: unknown) => {
  toEqual(expected: unknown): void
  toMatchObject(expected: unknown): void
  toBeNull(): void
  toBe(expected: unknown): void
}

/** Daily report inputs, stored reports and settings behave the same in the memory store and on Postgres. */
export async function reportStoreContract(store: Store, expect: Expect): Promise<void> {
  const at = new Date('2026-07-15T13:00:00Z')
  expect(await store.getDailyInputs('2026-07-15')).toBeNull()
  const manpower = { office: 7, qc: 6, operators: 6, gents_unloading: 7, ladies: 19, temp_ladies: 25, security: 2, temporary: 13 }
  const first = await store.saveDailyInputs('2026-07-15', { manpower }, { userId: 'usr_anju', at })
  expect(first).toMatchObject({ reportDate: '2026-07-15', manpower, bananaKgEstimate: null, productionRun: null, enteredBy: 'usr_anju', enteredByName: 'Anju' })
  // a later save changes only what it names
  const second = await store.saveDailyInputs('2026-07-15', { bananaKgEstimate: 11000, inwardRemarks: { banana: 'gate estimate' } }, { userId: 'usr_alex', at })
  expect(second).toMatchObject({ manpower, bananaKgEstimate: 11000, inwardRemarks: { banana: 'gate estimate' }, enteredBy: 'usr_alex', enteredByName: 'Alex Thomas' })
  const cleared = await store.saveDailyInputs('2026-07-15', { bananaKgEstimate: null, packingRun: false, notes: 'Boiler down' }, { userId: 'usr_anju', at })
  expect(cleared).toMatchObject({ manpower, bananaKgEstimate: null, packingRun: false, notes: 'Boiler down', inwardRemarks: { banana: 'gate estimate' } })
  expect((await store.getDailyInputs('2026-07-15'))?.notes).toBe('Boiler down')

  expect(await store.latestDailyReport('2026-07-15')).toBeNull()
  const v1 = await store.createDailyReport({ reportDate: '2026-07-15', basis: 'created_window', dataAsOf: '2026-10-07', payload: { kind: 'full', n: 1 }, documentId: null, generatedBy: 'usr_alex' })
  const v2 = await store.createDailyReport({ reportDate: '2026-07-15', basis: 'doc_date', dataAsOf: '2026-10-07', payload: { kind: 'full', n: 2 }, documentId: null, generatedBy: null })
  const other = await store.createDailyReport({ reportDate: '2026-07-16', basis: 'doc_date', dataAsOf: '2026-10-07', payload: {}, documentId: null, generatedBy: null })
  expect([v1.version, v2.version, other.version]).toEqual([1, 2, 1])
  expect(await store.latestDailyReport('2026-07-15')).toMatchObject({ id: v2.id, version: 2, basis: 'doc_date', payload: { kind: 'full', n: 2 } })

  expect(await store.getSetting('daily_report.outwards_basis')).toBeNull()
  await store.saveSetting('daily_report.outwards_basis', 'doc_date', 'usr_alex')
  await store.saveSetting('daily_report.outwards_basis', 'ewb_date', 'usr_alex')
  await store.saveSetting('daily_report.known_differences', ['one', 'two'], null)
  expect(await store.getSetting('daily_report.outwards_basis')).toBe('ewb_date')
  expect(await store.getSetting('daily_report.known_differences')).toEqual(['one', 'two'])
  expect(await store.listGlLabels()).toEqual([])
  expect(await store.listBankLineReattributions()).toEqual([])
}
