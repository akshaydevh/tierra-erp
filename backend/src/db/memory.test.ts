import { describe, expect, it } from 'vitest'
import { partyGroupContract } from '../test/party-group-contract'
import { orderStoreContract } from '../test/order-store-contract'
import { poStoreContract } from '../test/po-store-contract'
import { reportStoreContract } from '../test/report-store-contract'
import { MemoryStore } from './memory'

describe('MemoryStore party groups', () => {
  it('keeps one owner per PAN or card code and unmaps WhatsApp groups of a deleted party', async () => {
    await partyGroupContract(new MemoryStore('hash'), expect as never)
  })
})

describe('MemoryStore customer POs', () => {
  it('keeps one live PO per party, number and revision, with its lines and checks', async () => {
    await poStoreContract(new MemoryStore('hash'), expect as never)
  })
})

describe('MemoryStore sales orders', () => {
  it('numbers TSOs per series and year, reserves stock, decides approvals once and sends to groups at most once', async () => {
    await orderStoreContract(new MemoryStore('hash'), expect as never)
  })
})

describe('MemoryStore daily report', () => {
  it('keeps daily inputs field by field, versions reports per day and stores settings', async () => {
    await reportStoreContract(new MemoryStore('hash'), expect as never)
  })
})
