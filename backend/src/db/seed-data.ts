import type { Customer, Item } from './types'

export const DEV_PASSWORD = 'tierra-dev'

export const seedUsers = [
  {
    id: 'usr_alex',
    email: 'alex.thomas@tierra.test',
    name: 'Alex Thomas',
    role: 'admin' as const,
  },
  {
    id: 'usr_joshy',
    email: 'joshy@tierra.test',
    name: 'Joshy',
    role: 'admin' as const,
  },
  {
    id: 'usr_anju',
    email: 'anju@tierra.test',
    name: 'Anju',
    role: 'office' as const,
  },
]

export const seedCustomers: Customer[] = [
  { id: 'cus_beyond', name: 'Beyond Snack', code: 'BEYOND' },
  { id: 'cus_guiltfree', name: 'Guiltfree', code: 'GUILT' },
  { id: 'cus_reliance', name: 'Reliance Retail', code: 'REL' },
]

export const seedItems: Item[] = [
  { id: 'item_ban40', sku: 'BAN-40G', name: 'Banana chips 40g', unit: 'pouch' },
  { id: 'item_ban80', sku: 'BAN-80G', name: 'Banana chips 80g', unit: 'pouch' },
  { id: 'item_cas50', sku: 'CAS-50G', name: 'Cassava chips 50g', unit: 'pouch' },
]

export const seedBalances = [
  { itemId: 'item_ban40', onHand: 4800 },
  { itemId: 'item_ban80', onHand: 40 },
  { itemId: 'item_cas50', onHand: 2200 },
]

export const seedOrders = [
  {
    id: 'ord_bs_1042',
    customerId: 'cus_beyond',
    poNumber: 'PO-BS-1042',
    poDate: '2026-08-10',
    status: 'open' as const,
    source: 'seed' as const,
    createdAt: '2026-08-10T04:30:00.000Z',
    lines: [
      {
        id: 'lin_bs_1042',
        itemId: 'item_ban40',
        description: 'Banana chips 40g',
        quantity: 800,
        unit: 'pouch',
        unitPrice: '12.50',
      },
    ],
  },
  {
    id: 'ord_gf_220',
    customerId: 'cus_guiltfree',
    poNumber: 'PO-GF-220',
    poDate: '2026-08-11',
    status: 'open' as const,
    source: 'seed' as const,
    createdAt: '2026-08-11T06:15:00.000Z',
    lines: [
      {
        id: 'lin_gf_220',
        itemId: 'item_cas50',
        description: 'Cassava chips 50g',
        quantity: 200,
        unit: 'pouch',
        unitPrice: '18.00',
      },
    ],
  },
  {
    id: 'ord_bs_1048',
    customerId: 'cus_beyond',
    poNumber: 'PO-BS-1048',
    poDate: '2026-08-12',
    status: 'open' as const,
    source: 'seed' as const,
    createdAt: '2026-08-12T09:00:00.000Z',
    lines: [
      {
        id: 'lin_bs_1048',
        itemId: 'item_ban80',
        description: 'Banana chips 80g',
        quantity: 100,
        unit: 'pouch',
        unitPrice: '22.00',
      },
    ],
  },
  {
    id: 'ord_rr_088',
    customerId: 'cus_reliance',
    poNumber: 'PO-RR-088',
    poDate: '2026-07-28',
    status: 'closed' as const,
    source: 'seed' as const,
    createdAt: '2026-07-28T08:00:00.000Z',
    lines: [
      {
        id: 'lin_rr_088',
        itemId: 'item_ban40',
        description: 'Banana chips 40g',
        quantity: 400,
        unit: 'pouch',
        unitPrice: '12.50',
      },
    ],
  },
]
