import type { Store } from '../db/store'
import { addMonths, lastDayOf, monthLabel } from './months'

/**
 * The monthly MIS (finance's "MIS" workbook: Costing P&L, customer-wise contribution, margin comparison, consumption)
 * from SAP and the HR files. This module holds the MIS lines, the rules that put SAP GL accounts and finished goods
 * on them, and the arithmetic shared by the queries and the PDF.
 *
 * Both rule lists are settings finance can change (mis.gl_rules, mis.customer_rules); the defaults below are read off
 * the June 2026 MIS (its D.EXP / I.EXP mapping column and its customer columns). A setting's rules come first, then
 * the defaults; the first rule that matches wins.
 */

export const SETTING_GL_RULES = 'mis.gl_rules'
export const SETTING_CUSTOMER_RULES = 'mis.customer_rules'

/** MIS lines a GL account can feed. 'ignore' = handled elsewhere (stock purchases, COGS, WIP); 'unmapped' = no rule. */
export const GL_LINES = [
  'banana_cassava',
  'power',
  'water',
  'transport',
  'repairs',
  'other_variable',
  'salaries_gl',
  'staff_welfare',
  'professional',
  'communication',
  'repairs_fixed',
  'conveyance',
  'finance_charges',
  'interest_delayed',
  'rates_taxes',
  'admin',
  'gratuity',
  'doubtful_debts',
  'other_income',
  'selling',
  'ignore',
] as const
export type GlLine = (typeof GL_LINES)[number] | 'unmapped'

/** An account-name pattern (SQL ILIKE: % any text, _ one character) and the MIS line it feeds. */
export type GlRule = { match: string; line: (typeof GL_LINES)[number]; side?: 'income' | 'expense' }

export const DEFAULT_GL_RULES: readonly GlRule[] = [
  // income: sales, returns and COGS are the sales value of production; the rest is other income
  { side: 'income', match: 'Sales%', line: 'ignore' },
  { side: 'income', match: 'Price Difference%', line: 'ignore' },
  { side: 'income', match: 'Cost Of Goods Sold%', line: 'ignore' },
  { side: 'income', match: '%', line: 'other_income' },
  // materials: banana & cassava at what was bought in the month (as the MIS); other materials from SAP's issues
  { match: 'Purchases - Agri%', line: 'banana_cassava' },
  { match: 'Purchase%', line: 'ignore' },
  { match: 'Cost Of Goods Sold%', line: 'ignore' },
  { match: 'Work in Progress%', line: 'ignore' },
  { match: 'Price Difference%', line: 'ignore' },
  { match: 'Stock Diff%', line: 'ignore' },
  { match: 'Inventory%', line: 'ignore' },
  { match: 'Depreciation%', line: 'ignore' },
  // variable costs
  { match: 'Electricity%', line: 'power' },
  { match: 'Power%', line: 'power' },
  { match: 'Water%', line: 'water' },
  { match: 'Goods Transport%', line: 'transport' },
  { match: 'Repair%Plant%', line: 'repairs' },
  { match: 'Repair%Machinery%', line: 'repairs' },
  { match: 'Repair%Others%', line: 'repairs' },
  { match: 'Freight%', line: 'other_variable' },
  { match: 'Industrial Gas%', line: 'other_variable' },
  { match: 'Common Facility%', line: 'other_variable' },
  { match: 'Waste Di%', line: 'other_variable' },
  { match: 'Quality Control%', line: 'other_variable' },
  { match: 'Production Consumable%', line: 'other_variable' },
  { match: 'Lab%', line: 'other_variable' },
  { match: 'Cleaning%', line: 'other_variable' },
  { match: 'Loading%', line: 'other_variable' },
  // salaries: used only when the HR files have no payroll for the month
  { match: 'Salary and allowances%', line: 'salaries_gl' },
  { match: 'Wages%', line: 'salaries_gl' },
  { match: 'Employer Contribution%', line: 'salaries_gl' },
  { match: 'Employee Contribution%', line: 'salaries_gl' },
  { match: 'Bonus%', line: 'salaries_gl' },
  // fixed costs
  { match: 'Canteen%', line: 'staff_welfare' },
  { match: 'Food%', line: 'staff_welfare' },
  { match: 'Medical%', line: 'staff_welfare' },
  { match: 'Rent Staff%', line: 'staff_welfare' },
  { match: 'Staff Welfare%', line: 'staff_welfare' },
  { match: 'Tea%', line: 'staff_welfare' },
  { match: '%Professional%', line: 'professional' },
  { match: 'Filing%', line: 'professional' },
  { match: 'Profession Tax%', line: 'professional' },
  { match: 'Communication%', line: 'communication' },
  { match: 'Internet%', line: 'communication' },
  { match: 'Telephone%', line: 'communication' },
  { match: 'Repair%', line: 'repairs_fixed' },
  { match: 'Travel%', line: 'conveyance' },
  { match: '%Conveyance%', line: 'conveyance' },
  { match: 'Interest on delayed%', line: 'interest_delayed' },
  { match: 'Inter%Loan%', line: 'finance_charges' },
  { match: 'Interest on MSME%', line: 'finance_charges' },
  { match: 'Bank Charges%', line: 'finance_charges' },
  { match: 'Rates and Taxes%', line: 'rates_taxes' },
  { match: 'Provision For Gratu%', line: 'gratuity' },
  { match: 'Provision for Doubtful%', line: 'doubtful_debts' },
  { match: 'Sales Promotion%', line: 'selling' },
  { match: 'Selling%', line: 'selling' },
  { match: 'Accomadation%', line: 'admin' },
  { match: 'Accommodation%', line: 'admin' },
  { match: 'Courier%', line: 'admin' },
  { match: 'Donation%', line: 'admin' },
  { match: 'House keeping%', line: 'admin' },
  { match: 'Meeting%', line: 'admin' },
  { match: 'Office%', line: 'admin' },
  { match: 'Printing%', line: 'admin' },
  { match: 'Safety%', line: 'admin' },
  { match: 'Subscription%', line: 'admin' },
  { match: 'License%', line: 'admin' },
  { match: 'Registration%', line: 'admin' },
  { match: 'Insurance%', line: 'admin' },
  { match: 'Inter%Penalt%', line: 'admin' },
  { match: 'Pest Control%', line: 'admin' },
  { match: 'Application Fee%', line: 'admin' },
  { match: 'Round off%', line: 'admin' },
  { match: 'Land Filling%', line: 'admin' },
  { match: 'Administrat%', line: 'admin' },
]

/** A finished good's MIS customer: by SAP card (first) or item-code prefix. */
export type CustomerRule = { label: string; card?: string; prefix?: string }

/** From the June 2026 MIS columns: the MIS names brands (TATA is Fabsta for Trent, US Mandate is Dwaraka). */
export const DEFAULT_CUSTOMER_RULES: readonly CustomerRule[] = [
  { card: 'C0142', label: 'Snackable' },
  { card: 'C0101', label: 'Reliance' },
  { prefix: 'FGTYMC', label: 'Too Yumm Cassava' },
  { prefix: 'FGTYM', label: 'Too Yumm' },
  { prefix: 'FGLTO', label: "Let's Try" },
  { prefix: 'FGFBO', label: 'TATA' },
  { prefix: 'FGDWK', label: 'US Mandate' },
  { prefix: 'FGMLB', label: 'Malabar' },
  { prefix: 'FGWPR', label: 'Wipro' },
  { prefix: 'FGTNO', label: 'Tasty Nibbles' },
  { prefix: 'FGFKD', label: 'Flipkart' },
  { prefix: 'FGMOM', label: 'MOM' },
  { prefix: 'FGKCK', label: 'Kappo Cassava' },
  { prefix: 'FGKBK', label: 'Kappo' },
  { prefix: 'FGOMG', label: 'OMG Snacking' },
]

function asGlRules(value: unknown): GlRule[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (rule): rule is GlRule =>
      !!rule &&
      typeof rule === 'object' &&
      typeof (rule as GlRule).match === 'string' &&
      (GL_LINES as readonly string[]).includes((rule as GlRule).line) &&
      ((rule as GlRule).side === undefined || ['income', 'expense'].includes((rule as GlRule).side!)),
  )
}

function asCustomerRules(value: unknown): CustomerRule[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (rule): rule is CustomerRule =>
      !!rule &&
      typeof rule === 'object' &&
      typeof (rule as CustomerRule).label === 'string' &&
      (rule as CustomerRule).label.trim() !== '' &&
      (typeof (rule as CustomerRule).card === 'string' || typeof (rule as CustomerRule).prefix === 'string'),
  )
}

export type MisSettings = { glRules: GlRule[]; customerRules: CustomerRule[]; customGl: number; customCustomers: number }

/** The rules in force: the saved ones first, then the defaults. */
export async function misSettings(store: Pick<Store, 'getSetting'>): Promise<MisSettings> {
  const [gl, customers] = await Promise.all([store.getSetting(SETTING_GL_RULES), store.getSetting(SETTING_CUSTOMER_RULES)])
  const customGl = asGlRules(gl)
  const customCustomers = asCustomerRules(customers)
  return {
    glRules: [...customGl, ...DEFAULT_GL_RULES],
    customerRules: [...customCustomers, ...DEFAULT_CUSTOMER_RULES],
    customGl: customGl.length,
    customCustomers: customCustomers.length,
  }
}

export function validGlRules(value: unknown): GlRule[] | null {
  return Array.isArray(value) && asGlRules(value).length === value.length ? asGlRules(value) : null
}

export function validCustomerRules(value: unknown): CustomerRule[] | null {
  return Array.isArray(value) && asCustomerRules(value).length === value.length ? asCustomerRules(value) : null
}

/** SQL ILIKE in JavaScript: % any run, _ one character, case-insensitive, whole name. */
export function likeMatch(pattern: string, value: string): boolean {
  const regex = pattern
    .split('')
    .map((ch) => (ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${regex}$`, 'is').test(value.trim())
}

export function glLineOf(rules: readonly GlRule[], account: { name: string; side: 'income' | 'expense' }): GlLine {
  for (const rule of rules) {
    if (rule.side && rule.side !== account.side) continue
    if (!rule.side && account.side === 'income') continue
    if (likeMatch(rule.match, account.name)) return rule.line
  }
  return 'unmapped'
}

export function customerLabelOf(
  rules: readonly CustomerRule[],
  order: { itemCode: string; cardCode: string | null; fallback: string },
): string {
  for (const rule of rules) {
    if (rule.card && rule.card === order.cardCode) return rule.label
    if (rule.prefix && order.itemCode.toUpperCase().startsWith(rule.prefix.toUpperCase())) return rule.label
  }
  return order.fallback
}

/** First month of the financial year (April) a month is in. */
export function fyStart(month: string): string {
  const year = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return `${m >= 4 ? year : year - 1}-04-01`
}

/** Months from the financial year's April to the month, oldest first. */
export function fyMonths(month: string): string[] {
  const out: string[] = []
  for (let m = fyStart(month); m <= month; m = addMonths(m, 1)) out.push(m)
  return out
}

/** The MIS month when none is named: the SAP data month when the data reaches its last day, else the month before. */
export function defaultMisMonth(dataAsOf: string | null, today: string): string {
  const day = dataAsOf ?? today
  const month = `${day.slice(0, 7)}-01`
  return day >= lastDayOf(month) ? month : addMonths(month, -1)
}

// ------------------------------------------------------------------------------------------------- the P&L lines

export type PnlKey =
  | 'productionKg'
  | 'sales'
  | 'otherIncome'
  | 'banana'
  | 'packing'
  | 'oil'
  | 'flavour'
  | 'materials'
  | 'mom'
  | 'lpg'
  | 'power'
  | 'peeling'
  | 'water'
  | 'transport'
  | 'wages'
  | 'repairs'
  | 'otherVariable'
  | 'variable'
  | 'contribution'
  | 'salaryFixed'
  | 'selling'
  | 'staffWelfare'
  | 'professional'
  | 'communication'
  | 'repairsFixed'
  | 'conveyance'
  | 'financeCharges'
  | 'interestDelayed'
  | 'ratesTaxes'
  | 'admin'
  | 'gratuity'
  | 'doubtfulDebts'
  | 'fixed'
  | 'ebitda'

export type PnlMonth = Record<PnlKey, number> & {
  month: string
  /** Labour came from the HR payroll (split) or SAP's salary journal (one line, under wages). */
  labourSource: 'hr' | 'gl' | 'none'
  /** Finished goods re-issued into production (rework), taken off the kg received. */
  reworkKg: number
  bananaKg: number
  /** Pieces made that had no invoice price within 90 days (no sales value). */
  unpricedKg: number
}

export const VARIABLE_KEYS: PnlKey[] = ['lpg', 'power', 'peeling', 'water', 'transport', 'wages', 'repairs', 'otherVariable']
export const FIXED_KEYS: PnlKey[] = ['salaryFixed', 'staffWelfare', 'professional', 'communication', 'repairsFixed', 'conveyance', 'financeCharges', 'interestDelayed', 'ratesTaxes', 'admin', 'gratuity', 'doubtfulDebts']
export const MATERIAL_KEYS: PnlKey[] = ['banana', 'packing', 'oil', 'flavour']

export function emptyPnl(month: string): PnlMonth {
  const keys: PnlKey[] = ['productionKg', 'sales', 'otherIncome', ...MATERIAL_KEYS, 'materials', 'mom', ...VARIABLE_KEYS, 'variable', 'contribution', ...FIXED_KEYS, 'fixed', 'ebitda', 'selling']
  return { ...(Object.fromEntries(keys.map((key) => [key, 0])) as Record<PnlKey, number>), month, labourSource: 'none', reworkKg: 0, bananaKg: 0, unpricedKg: 0 }
}

function r2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Fills the totals: materials, margin on materials, variable, contribution, fixed, EBITDA (= contribution - fixed +
 * other income, as the MIS). Sales promotion (selling) is a memo line outside EBITDA: the MIS considers it separately.
 */
export function closePnl(p: PnlMonth): PnlMonth {
  p.materials = r2(MATERIAL_KEYS.reduce((sum, key) => sum + p[key], 0))
  p.mom = r2(p.sales - p.materials)
  p.variable = r2(VARIABLE_KEYS.reduce((sum, key) => sum + p[key], 0))
  p.contribution = r2(p.mom - p.variable)
  p.fixed = r2(FIXED_KEYS.reduce((sum, key) => sum + p[key], 0))
  p.ebitda = r2(p.contribution - p.fixed + p.otherIncome)
  return p
}

export function sumPnl(months: readonly PnlMonth[], label: string): PnlMonth {
  const total = emptyPnl(label)
  for (const m of months) {
    for (const key of Object.keys(total) as Array<keyof PnlMonth>) {
      if (typeof total[key] === 'number' && typeof m[key] === 'number') (total[key] as number) += m[key] as number
    }
  }
  total.labourSource = months.every((m) => m.labourSource === 'hr') ? 'hr' : months.some((m) => m.labourSource !== 'none') ? 'gl' : 'none'
  for (const key of Object.keys(total) as Array<keyof PnlMonth>) if (typeof total[key] === 'number') (total[key] as number) = r2(total[key] as number)
  return closePnl(total)
}

export function perKgOf(value: number, kg: number): number | null {
  return kg ? r2(value / kg) : null
}

export type Reconciliation = { label: string; amount: number }[]

/**
 * The MIS's EBITDA reconciliation, month on month: the change in margin per kg and in volume, in variable cost per
 * kg and with volume, in fixed costs and other income. The steps add up to the change in EBITDA.
 */
export function reconcile(previous: PnlMonth, current: PnlMonth): Reconciliation {
  const kg0 = previous.productionKg
  const kg1 = current.productionKg
  const momKg0 = kg0 ? previous.mom / kg0 : 0
  const momKg1 = kg1 ? current.mom / kg1 : 0
  const vcKg0 = kg0 ? previous.variable / kg0 : 0
  const vcKg1 = kg1 ? current.variable / kg1 : 0
  if (!kg0 || !kg1) {
    // a month without production has no per-kg figures to split by: the changes in total
    return [
      { label: `EBITDA for ${monthLabel(previous.month)}`, amount: previous.ebitda },
      { label: 'Change in margin on materials', amount: r2(current.mom - previous.mom) },
      { label: 'Change in variable costs', amount: r2(-(current.variable - previous.variable)) },
      { label: 'Change in fixed costs', amount: r2(-(current.fixed - previous.fixed)) },
      { label: 'Change in other income', amount: r2(current.otherIncome - previous.otherIncome) },
      { label: `EBITDA for ${monthLabel(current.month)}`, amount: current.ebitda },
    ]
  }
  return [
    { label: `EBITDA for ${monthLabel(previous.month)}`, amount: previous.ebitda },
    { label: 'Change in margin on materials per kg', amount: r2((momKg1 - momKg0) * kg1) },
    { label: 'Change in volume (at last month\'s margin per kg)', amount: r2((kg1 - kg0) * momKg0) },
    { label: 'Change in variable cost per kg', amount: r2(-(vcKg1 - vcKg0) * kg1) },
    { label: 'Variable cost with the change in volume', amount: r2(-(kg1 - kg0) * vcKg0) },
    { label: 'Change in fixed costs', amount: r2(-(current.fixed - previous.fixed)) },
    { label: 'Change in other income', amount: r2(current.otherIncome - previous.otherIncome) },
    { label: `EBITDA for ${monthLabel(current.month)}`, amount: current.ebitda },
  ]
}
