import { describe, expect, it } from 'vitest'
import { createExtractTask, roleCriteria } from './extract-task'

describe('task extraction', () => {
  it('offers roles, with today’s holders as aliases', () => {
    const criteria = roleCriteria([
      { name: 'Alex Thomas', role: 'admin' },
      { name: 'Joshy', role: 'manager' },
      { name: 'Anju', role: 'office' },
    ])
    expect(Object.keys(criteria).sort()).toEqual(['admin', 'manager', 'office', 'unassigned', 'unknown'])
    expect(criteria.manager).toContain('Also called: Joshy.')
    expect(criteria.admin).toContain('Also called: Alex Thomas.')
    expect(roleCriteria([]).office).not.toContain('Also called')
  })

  it('returns no role without a TypeSafe key', async () => {
    const extract = createExtractTask({ typesafeApiKey: '' })
    expect(await extract({ text: 'Call the supplier', quotedText: null, accounts: [] })).toEqual({
      title: 'Call the supplier',
      category: null,
      assigneeRole: null,
      assigneeUnknown: false,
    })
  })
})
