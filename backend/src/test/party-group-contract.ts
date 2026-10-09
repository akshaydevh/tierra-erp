import { PartyGroupConflictError, type Store } from '../db/store'

type Expect = (value: unknown) => {
  toEqual(expected: unknown): void
  toMatchObject(expected: unknown): void
  toBeNull(): void
  toBe(expected: unknown): void
  rejects: { toBeInstanceOf(type: unknown): Promise<void>; toThrow(message: string): Promise<void> }
}

/** The same party-group and WhatsApp-group behaviour, run against the memory store and against Postgres. */
export async function partyGroupContract(store: Store, expect: Expect): Promise<void> {
  const alpha = await store.createPartyGroup({
    name: ' Alpha Snacks ',
    alias: 'Alpha',
    members: [
      { kind: 'pan', value: ' aaacz1234a ' },
      { kind: 'card_code', value: 'ZC009' },
      { kind: 'pan', value: 'AAACZ1234A' },
      { kind: 'card_code', value: ' ' },
    ],
  })
  expect(alpha).toMatchObject({
    name: 'Alpha Snacks',
    alias: 'Alpha',
    members: [
      { kind: 'card_code', value: 'ZC009' },
      { kind: 'pan', value: 'AAACZ1234A' },
    ],
  })
  await expect(
    store.createPartyGroup({ name: 'Beta', members: [{ kind: 'pan', value: 'AAACZ1234A' }] }),
  ).rejects.toThrow('AAACZ1234A already belongs to Alpha Snacks')
  await expect(store.createPartyGroup({ name: 'Alpha Snacks', members: [] })).rejects.toBeInstanceOf(
    PartyGroupConflictError,
  )
  const beta = await store.createPartyGroup({ name: 'Beta', members: [{ kind: 'pan', value: 'AABCB5678B' }] })
  expect((await store.listPartyGroups()).map((group) => group.name)).toEqual(['Alpha Snacks', 'Beta'])

  const updated = await store.updatePartyGroup(beta.id, {
    name: 'Beta Retail',
    members: [{ kind: 'card_code', value: 'ZC002' }],
  })
  expect(updated).toMatchObject({ name: 'Beta Retail', alias: null, members: [{ kind: 'card_code', value: 'ZC002' }] })
  expect(await store.updatePartyGroup('pty_missing', { name: 'X', members: [] })).toBeNull()

  expect(await store.getWaGroup('1@g.us')).toBeNull()
  const fresh = await store.saveWaGroup('1@g.us', { subject: 'Alpha – Tierra' })
  expect(fresh).toMatchObject({ jid: '1@g.us', subject: 'Alpha – Tierra', partyGroupId: null, sendSo: true })
  await store.saveWaGroup('1@g.us', { partyGroupId: alpha.id, sendSo: false })
  expect(await store.getWaGroup('1@g.us')).toMatchObject({ subject: 'Alpha – Tierra', partyGroupId: alpha.id, sendSo: false })
  expect((await store.listWaGroups()).length).toBe(1)

  expect(await store.deletePartyGroup(alpha.id)).toBe(true)
  expect(await store.getPartyGroup(alpha.id)).toBeNull()
  expect(await store.getWaGroup('1@g.us')).toMatchObject({ partyGroupId: null })
  // The PAN is free again once its group is gone.
  await store.createPartyGroup({ name: 'Alpha again', members: [{ kind: 'pan', value: 'AAACZ1234A' }] })
}
