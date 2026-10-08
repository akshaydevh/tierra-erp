import { describe, expect, it } from 'vitest'
import type { AccountLink } from '../db/types'
import { holderForRole, holderLabel, resolveAssignee } from './routing'

const accounts: AccountLink[] = [
  { id: 'usr_a', name: 'Asha', email: 'a@x.test', role: 'admin', phoneNumber: '919900000000' },
  { id: 'usr_m2', name: 'Manu', email: 'm2@x.test', role: 'manager', phoneNumber: null },
  { id: 'usr_m1', name: 'Mira', email: 'm1@x.test', role: 'manager', phoneNumber: '919700000001' },
  { id: 'usr_o2', name: 'Omar', email: 'o2@x.test', role: 'office', phoneNumber: null },
  { id: 'usr_o1', name: 'Olga', email: 'o1@x.test', role: 'office', phoneNumber: null },
]

describe('routing', () => {
  it('prefers the holder with a phone, then the lowest id', () => {
    expect(holderForRole(accounts, 'manager')?.id).toBe('usr_m1')
    expect(holderForRole(accounts, 'office')?.id).toBe('usr_o1')
    expect(holderForRole([], 'admin')).toBeNull()
  })

  it('resolves a role to its holder', () => {
    expect(resolveAssignee(accounts, { assigneeRole: 'manager' })).toMatchObject({
      assigneeId: 'usr_m1',
      assigneeRole: 'manager',
      unrouted: false,
    })
  })

  it('falls back to the admin when nobody holds the role', () => {
    const noOffice = accounts.filter((account) => account.role !== 'office')
    const route = resolveAssignee(noOffice, { assigneeRole: 'office' })
    expect(route).toMatchObject({ assigneeId: 'usr_a', assigneeRole: 'office', unrouted: true })
    expect(holderLabel(route!)).toBe('the admin (Asha), as no office is set up')
  })

  it('keeps a named person and rejects an unknown one', () => {
    expect(resolveAssignee(accounts, { assigneeId: 'usr_o2' })).toMatchObject({
      assigneeId: 'usr_o2',
      assigneeRole: null,
      holder: expect.objectContaining({ name: 'Omar' }),
    })
    expect(resolveAssignee(accounts, { assigneeId: 'usr_nobody' })).toBeNull()
    expect(resolveAssignee(accounts, {})).toEqual({
      assigneeId: null,
      assigneeRole: null,
      holder: null,
      unrouted: false,
    })
  })

  it('labels the holder with an optional mention', () => {
    const route = resolveAssignee(accounts, { assigneeRole: 'manager' })!
    expect(holderLabel(route)).toBe('the manager (Mira)')
    expect(holderLabel(route, '919700000001')).toBe('the manager (Mira @919700000001)')
    expect(holderLabel(resolveAssignee(accounts, { assigneeId: 'usr_o2' })!)).toBe('Omar')
  })
})
