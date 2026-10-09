import { describe, expect, it } from 'vitest'
import { poSourceText } from './po-text'

const po = { sourceChat: '120363777@g.us', sourceSender: '+919811100000', raisedBy: null, partyGroupId: 'pty_nw' }

describe('where a PO came from, for the admin', () => {
  it('names the group, the person or the unknown number, and warns when it is not to be trusted', () => {
    const mapped = { subject: 'Northwind – Tierra', partyGroupId: 'pty_nw' }
    expect(poSourceText({ po, group: mapped, groupParty: 'NW', poParty: 'NW' })).toEqual({ line: 'From: group Northwind – Tierra', warning: null })
    expect(poSourceText({ po, group: { subject: 'New buyer chat', partyGroupId: null }, groupParty: null, poParty: 'NW' })).toEqual({
      line: 'From: group New buyer chat',
      warning: '⚠ That group is not linked to a customer.',
    })
    expect(poSourceText({ po: { ...po, partyGroupId: 'pty_alpha' }, group: mapped, groupParty: 'NW', poParty: 'Alpha Snacks' })).toEqual({
      line: 'From: group Northwind – Tierra',
      warning: '⚠ That group belongs to NW, but this PO is for Alpha Snacks.',
    })
    const dm = { ...po, sourceChat: '919700000001@s.whatsapp.net' }
    expect(poSourceText({ po: { ...dm, sourceSender: 'Joshy', raisedBy: 'usr_joshy' }, group: null, groupParty: null, poParty: null })).toEqual({ line: 'From: Joshy (DM)', warning: null })
    expect(poSourceText({ po: dm, group: null, groupParty: null, poParty: null })).toEqual({
      line: 'From: unknown number +919811100000',
      warning: '⚠ Not a Tierra account: nothing is raised for this PO until the office confirms it.',
    })
    expect(poSourceText({ po: { ...po, sourceChat: 'desk:usr_alex', sourceSender: 'Alex Thomas', raisedBy: 'usr_alex' }, group: null, groupParty: null, poParty: null })).toEqual({
      line: 'From: Alex Thomas (desk)',
      warning: null,
    })
    expect(poSourceText({ po: { ...po, sourceChat: null }, group: null, groupParty: null, poParty: null })).toBeNull()
  })
})
