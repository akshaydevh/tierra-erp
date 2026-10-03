import { describe, expect, it } from 'vitest'
import { missingBalances } from './seed'

describe('missing balances', () => {
  it('skips a plant item that already exists under a different id', () => {
    const missing = missingBalances(
      [
        { id: 'bal_ban40', customerId: null, itemId: 'item_ban40' },
        { id: 'bal_fab170', customerId: null, itemId: 'item_fab170' },
        { id: 'bal_lam_fab', customerId: 'cus_trent', itemId: 'item_lam_fab' },
      ],
      [{ customerId: null, itemId: 'item_ban40' }],
    )
    expect(missing.map((row) => row.id)).toEqual(['bal_fab170', 'bal_lam_fab'])
  })
})