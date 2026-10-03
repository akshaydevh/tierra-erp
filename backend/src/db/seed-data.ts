import type { Customer, Item } from './types'

export const DEV_PASSWORD = 'tierra-dev'
export const PROCUREMENT_ASSIGNEE_ID = 'usr_joshy'
export const RAW_BANANA_ITEM_ID = 'item_rm_banana'

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

export const seedUnits = [
  {
    code: 'EA',
    name: 'Each',
    description: 'One sellable pack. Base quantity on Reliance purchase orders.',
  },
  {
    code: 'CRT',
    name: 'Carton',
    description:
      'Reliance carton. Pieces per carton depend on the item. On PO 5115244945, 1 CRT of 100g chips was 56 each.',
  },
  {
    code: 'C01',
    name: 'Carton',
    description:
      'Reliance alternate carton code. Pieces per carton depend on the item. On PO 5115244945, 1 C01 of 500g chips was 30 each.',
  },
]

export const seedCustomers: Customer[] = [
  { id: 'cus_beyond', name: 'Beyond Snack', code: 'BEYOND' },
  { id: 'cus_guiltfree', name: 'Guiltfree', code: 'GUILT' },
  { id: 'cus_reliance', name: 'Reliance Retail', code: 'REL' },
  { id: 'cus_trent', name: 'Trent Hypermarket Private Limited', code: 'TRENT' },
]

export const seedItems: Item[] = [
  { id: 'item_ban40', sku: 'BAN-40G', name: 'Banana chips 40g', unit: 'pouch', kind: 'finished_good' },
  { id: 'item_ban80', sku: 'BAN-80G', name: 'Banana chips 80g', unit: 'pouch', kind: 'finished_good' },
  { id: 'item_cas50', sku: 'CAS-50G', name: 'Cassava chips 50g', unit: 'pouch', kind: 'finished_good' },
  {
    id: 'item_fab170',
    sku: 'FAB-170G',
    name: 'Fabsta Banana chips Salted 170g',
    unit: 'pouch',
    kind: 'finished_good',
  },
  {
    id: 'item_fab500',
    sku: 'FAB-500G',
    name: 'Fabsta Banana Chips 500g',
    unit: 'pouch',
    kind: 'finished_good',
  },
  { id: RAW_BANANA_ITEM_ID, sku: 'RM-BANANA', name: 'Raw banana', unit: 'kg', kind: 'raw_material' },
]

export const seedMaterialItems: Item[] = [
  {
    id: 'item_lam_bs40',
    sku: 'PMPL-BS-40',
    name: 'Pouch film, Beyond Snack 40g',
    unit: 'kg',
    kind: 'laminate',
  },
  {
    id: 'item_sea_bs',
    sku: 'FLV-BS-SALT',
    name: 'Salted seasoning blend',
    unit: 'kg',
    kind: 'seasoning',
  },
  {
    id: 'item_ctn_bs40',
    sku: 'CTN-BS-40',
    name: 'Shipper, 24 pouches',
    unit: 'carton',
    kind: 'carton',
  },
  {
    id: 'item_lam_ty75',
    sku: 'PMPL-TY-75',
    name: 'Pouch film, Too Yumm classic salted 75g',
    unit: 'kg',
    kind: 'laminate',
  },
  {
    id: 'item_sea_ty',
    sku: 'FLV-TY-SALT',
    name: 'Classic salt blend',
    unit: 'kg',
    kind: 'seasoning',
  },
  {
    id: 'item_ctn_ty',
    sku: 'CTN-TY-12',
    name: 'Shipper, 12 pouches',
    unit: 'carton',
    kind: 'carton',
  },
  {
    id: 'item_lam_rel',
    sku: 'PMPL-REL-100',
    name: 'Pouch film, 100g',
    unit: 'kg',
    kind: 'laminate',
  },
  {
    id: 'item_sea_rel',
    sku: 'FLV-REL-SALT',
    name: 'Salted seasoning blend',
    unit: 'kg',
    kind: 'seasoning',
  },
  {
    id: 'item_ctn_rel',
    sku: 'CTN-REL-CRT',
    name: 'CRT shipper, 56 pouches',
    unit: 'carton',
    kind: 'carton',
  },
  {
    id: 'item_lam_fab',
    sku: 'PMPL-FAB-170',
    name: 'Pouch film, Fabsta 170g',
    unit: 'kg',
    kind: 'laminate',
  },
  {
    id: 'item_sea_fab',
    sku: 'FLV-FAB-SALT',
    name: 'Fabsta salted seasoning',
    unit: 'kg',
    kind: 'seasoning',
  },
  {
    id: 'item_ctn_fab',
    sku: 'CTN-FAB-170',
    name: 'Shipper, Fabsta 170g',
    unit: 'carton',
    kind: 'carton',
  },
]

export const seedBalances = [
  { id: 'bal_ban40', customerId: null, itemId: 'item_ban40', onHand: 4800 },
  { id: 'bal_ban80', customerId: null, itemId: 'item_ban80', onHand: 40 },
  { id: 'bal_cas50', customerId: null, itemId: 'item_cas50', onHand: 2200 },
  { id: 'bal_lam_bs40', customerId: 'cus_beyond', itemId: 'item_lam_bs40', onHand: 860 },
  { id: 'bal_sea_bs', customerId: 'cus_beyond', itemId: 'item_sea_bs', onHand: 140 },
  { id: 'bal_ctn_bs40', customerId: 'cus_beyond', itemId: 'item_ctn_bs40', onHand: 480 },
  { id: 'bal_lam_ty75', customerId: 'cus_guiltfree', itemId: 'item_lam_ty75', onHand: 1240 },
  { id: 'bal_sea_ty', customerId: 'cus_guiltfree', itemId: 'item_sea_ty', onHand: 96 },
  { id: 'bal_ctn_ty', customerId: 'cus_guiltfree', itemId: 'item_ctn_ty', onHand: 360 },
  { id: 'bal_lam_rel', customerId: 'cus_reliance', itemId: 'item_lam_rel', onHand: 210 },
  { id: 'bal_sea_rel', customerId: 'cus_reliance', itemId: 'item_sea_rel', onHand: 54 },
  { id: 'bal_ctn_rel', customerId: 'cus_reliance', itemId: 'item_ctn_rel', onHand: 175 },
  { id: 'bal_lam_fab', customerId: 'cus_trent', itemId: 'item_lam_fab', onHand: 420 },
  { id: 'bal_sea_fab', customerId: 'cus_trent', itemId: 'item_sea_fab', onHand: 80 },
  { id: 'bal_ctn_fab', customerId: 'cus_trent', itemId: 'item_ctn_fab', onHand: 90 },
  { id: 'bal_fab170', customerId: null, itemId: 'item_fab170', onHand: 0 },
  { id: 'bal_fab500', customerId: null, itemId: 'item_fab500', onHand: 0 },
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
