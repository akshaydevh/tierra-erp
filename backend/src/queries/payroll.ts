import { day, num, numOrNull, text, timestamp, type SapSql } from '../sap/db'
import { round2 } from './finance'
import { isNotImported } from './meta'

/**
 * Payroll and attendance reads over schema `hr` (tools/sap-import/sql/hr.sql, written by `run.py hr` from the HR
 * spreadsheets; SAP has none of it). Admin only: the routes answer 403 to everyone else and the agent's HR tools are
 * admin-only. Aggregates by default; a function returns names only when asked to (`names: true`), which the callers
 * do only for an explicit admin request.
 *
 * Three payrolls per month, never added together: voyon (the Voyon export, the permanent staff), register (the salary
 * register, the same staff by category, a few more who are not on Voyon) and temp_sheet (temporary workers).
 */

export const CATEGORY_LABELS: Record<string, string> = {
  office_admin: 'Office & Admin',
  peeling: 'Peeling',
  production: 'Production',
  sales_promotion: 'Sales Promotion',
  temporary: 'Temporary (factory)',
  sales_promotion_temp: 'Temporary sales promotion',
}

export const SOURCE_LABELS: Record<string, string> = {
  voyon: 'Voyon payroll',
  register: 'Salary register',
  temp_sheet: 'Temporary wages sheet',
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category
}

/** Runs a read that needs schema hr; null when `run.py hr` has not loaded it on this database. */
export async function hrOrNull<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work()
  } catch (error) {
    if (isNotImported(error)) return null
    throw error
  }
}

export type PayrollRun = {
  runId: string
  month: string
  source: string
  label: string
  fileName: string
  headcount: number
  grossEarned: number
  totalEarning: number
  deductions: number
  net: number
}

export type HrMeta = { importedAt: string | null; months: string[]; runs: PayrollRun[]; attendanceMonths: string[]; peelingMonths: string[] }

function runRow(row: Record<string, unknown>): PayrollRun {
  return {
    runId: String(row.run_id),
    month: day(row.month)!,
    source: String(row.source),
    label: SOURCE_LABELS[String(row.source)] ?? String(row.source),
    fileName: String(row.file_name),
    headcount: num(row.headcount),
    grossEarned: round2(num(row.gross_earned)),
    totalEarning: round2(num(row.total_earning)),
    deductions: round2(num(row.deductions)),
    net: round2(num(row.net)),
  }
}

const SOURCE_ORDER = sqlOrder(['voyon', 'register', 'temp_sheet'])

function sqlOrder(values: string[]): (source: string) => number {
  return (source) => {
    const at = values.indexOf(source)
    return at < 0 ? values.length : at
  }
}

/** What the HR import holds; throws the not-imported error when schema hr is missing (wrap in hrOrNull). */
export async function hrMeta(sql: SapSql): Promise<HrMeta> {
  const [runs, [imported], attendance, peeling] = await Promise.all([
    sql`select * from hr.payroll_runs order by month desc, run_id`,
    sql`select value from hr._import where key = 'imported_at'`,
    sql`select distinct date_trunc('month', work_date)::date as month from hr.attendance_days order by 1 desc`,
    sql`select distinct month from hr.peeling_output order by 1 desc`,
  ])
  const list = runs.map(runRow).sort((a, b) => b.month.localeCompare(a.month) || SOURCE_ORDER(a.source) - SOURCE_ORDER(b.source))
  return {
    importedAt: imported ? timestamp(imported.value) : null,
    months: [...new Set(list.map((run) => run.month))],
    runs: list,
    attendanceMonths: attendance.map((row) => day(row.month)!),
    peelingMonths: peeling.map((row) => day(row.month)!),
  }
}

export type CategoryTotal = {
  category: string
  label: string
  people: number
  grossEarned: number
  totalEarning: number
  pf: number
  esi: number
  deductions: number
  net: number
}

export type PayLine = {
  runId: string
  source: string
  employeeId: string | null
  code: string | null
  name: string
  category: string
  designation: string | null
  daysPaid: number | null
  grossFixed: number
  grossEarned: number
  incentives: number
  totalEarning: number
  pf: number
  esi: number
  tds: number
  advance: number
  deductions: number
  net: number
}

export type PayrollSummary = {
  month: string
  runs: Array<PayrollRun & { pf: number; esi: number; tds: number; basic: number; categories: CategoryTotal[] }>
  /** Per person, only when asked for names. */
  people?: PayLine[]
}

function payLine(row: Record<string, unknown>): PayLine {
  return {
    runId: String(row.run_id),
    source: String(row.source),
    employeeId: text(row.employee_id),
    code: text(row.code),
    name: String(row.name),
    category: String(row.category),
    designation: text(row.designation),
    daysPaid: numOrNull(row.days_paid),
    grossFixed: round2(num(row.gross_fixed)),
    grossEarned: round2(num(row.gross_earned)),
    incentives: round2(
      num(row.off_day_work) + num(row.overtime) + num(row.attendance_incentive) + num(row.performance_incentive) +
        num(row.peeling_incentive) + num(row.production_incentive) + num(row.other_earnings),
    ),
    totalEarning: round2(num(row.total_earning)),
    pf: round2(num(row.pf)),
    esi: round2(num(row.esi)),
    tds: round2(num(row.tds)),
    advance: round2(num(row.advance)),
    deductions: round2(num(row.total_deductions)),
    net: round2(num(row.net)),
  }
}

/** A month's payrolls, each with its totals per category (Voyon: department; register: sheet; temps: block). */
export async function payrollSummary(sql: SapSql, month: string, options: { names?: boolean } = {}): Promise<PayrollSummary> {
  const [runs, cats, people] = await Promise.all([
    sql`
      select r.*, coalesce(sum(l.pf), 0) as pf, coalesce(sum(l.esi), 0) as esi, coalesce(sum(l.tds), 0) as tds,
             coalesce(sum(l.basic), 0) as basic
      from hr.payroll_runs r left join hr.payroll_lines l using (run_id)
      where r.month = ${month}::date group by r.run_id`,
    sql`
      select l.run_id, l.category, count(*) as people, sum(l.gross_earned) as gross_earned, sum(l.total_earning) as total_earning,
             sum(l.pf) as pf, sum(l.esi) as esi, sum(l.total_deductions) as deductions, sum(l.net) as net
      from hr.payroll_lines l join hr.payroll_runs r using (run_id)
      where r.month = ${month}::date group by 1, 2 order by sum(l.net) desc`,
    options.names
      ? sql`
          select l.*, r.source from hr.payroll_lines l join hr.payroll_runs r using (run_id)
          where r.month = ${month}::date order by r.source, l.category, l.net desc`
      : Promise.resolve([]),
  ])
  const summary: PayrollSummary = {
    month,
    runs: runs
      .map((row) => ({
        ...runRow(row),
        pf: round2(num(row.pf)),
        esi: round2(num(row.esi)),
        tds: round2(num(row.tds)),
        basic: round2(num(row.basic)),
        categories: cats
          .filter((cat) => cat.run_id === row.run_id)
          .map((cat) => ({
            category: String(cat.category),
            label: categoryLabel(String(cat.category)),
            people: num(cat.people),
            grossEarned: round2(num(cat.gross_earned)),
            totalEarning: round2(num(cat.total_earning)),
            pf: round2(num(cat.pf)),
            esi: round2(num(cat.esi)),
            deductions: round2(num(cat.deductions)),
            net: round2(num(cat.net)),
          })),
      }))
      .sort((a, b) => SOURCE_ORDER(a.source) - SOURCE_ORDER(b.source)),
  }
  if (options.names) summary.people = people.map(payLine)
  return summary
}

export type Headcount = {
  total: number
  voyonMaster: number
  onVoyonPayroll: number
  registerOnly: number
  temps: Array<{ block: string; label: string; people: number }>
  byDepartment: Array<{ department: string; people: number; onPayroll: number }>
  byCategory: Array<{ category: string; label: string; people: number }>
  punch: Array<{ status: string; people: number }>
}

export async function headcount(sql: SapSql): Promise<Headcount> {
  const [[totals], departments, categories, temps, punch] = await Promise.all([
    sql`
      select count(*) as total,
             count(*) filter (where 'voyon_master' = any (sources)) as master,
             count(*) filter (where on_voyon_payroll) as on_payroll,
             count(*) filter (where code_voyon is null) as register_only
      from hr.employees`,
    sql`
      select coalesce(department, 'Not on Voyon') as department, count(*) as people, count(*) filter (where on_voyon_payroll) as on_payroll
      from hr.employees group by 1 order by 2 desc`,
    sql`select category, count(*) as people from hr.employees where category is not null group by 1 order by 2 desc`,
    sql`select block, count(*) as people from hr.temp_workers group by 1 order by 1`,
    sql`select coalesce(punch_status, 'No punch record') as status, count(*) as people from hr.employees where 'voyon_master' = any (sources) group by 1 order by 2 desc`,
  ])
  return {
    total: num(totals?.total),
    voyonMaster: num(totals?.master),
    onVoyonPayroll: num(totals?.on_payroll),
    registerOnly: num(totals?.register_only),
    temps: temps.map((row) => ({ block: String(row.block), label: categoryLabel(String(row.block)), people: num(row.people) })),
    byDepartment: departments.map((row) => ({ department: String(row.department), people: num(row.people), onPayroll: num(row.on_payroll) })),
    byCategory: categories.map((row) => ({ category: String(row.category), label: categoryLabel(String(row.category)), people: num(row.people) })),
    punch: punch.map((row) => ({ status: String(row.status), people: num(row.people) })),
  }
}

export const ATTENDANCE_CODES = ['P', 'Offday', 'W/OFF', 'LWP', 'CL', 'EL', 'PH', 'OD', 'C/off', 'ESIC'] as const
const PRESENT = new Set(['P', 'Offday', 'OD'])

export type AttendanceMonth = {
  month: string
  days: string[]
  codes: Record<string, number>
  /** Per day: how many were present (P, Offday, OD), on leave (CL / EL / PH / C-off / ESIC), on LWP and off. */
  perDay: Array<{ date: string; present: number; leave: number; lwp: number; off: number }>
  people: number
  /** Per person, only when asked for names. */
  rows?: Array<{ employeeId: string; name: string; category: string | null; marks: Record<string, string>; present: number; lwp: number }>
}

function lastDay(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return `${month.slice(0, 8)}${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}

export async function attendanceMonth(sql: SapSql, month: string, options: { names?: boolean; date?: string | null } = {}): Promise<AttendanceMonth> {
  const from = options.date ?? month
  const to = options.date ?? lastDay(month)
  const marks = await sql`
    select a.employee_id, a.work_date, a.code, e.name, e.category
    from hr.attendance_days a left join hr.employees e using (employee_id)
    where a.work_date between ${from}::date and ${to}::date order by e.category nulls last, e.name, a.work_date`
  const codes: Record<string, number> = {}
  const perDay = new Map<string, { present: number; leave: number; lwp: number; off: number }>()
  const people = new Map<string, { employeeId: string; name: string; category: string | null; marks: Record<string, string>; present: number; lwp: number }>()
  for (const row of marks) {
    const date = day(row.work_date)!
    const code = String(row.code)
    codes[code] = (codes[code] ?? 0) + 1
    const slot = perDay.get(date) ?? { present: 0, leave: 0, lwp: 0, off: 0 }
    if (PRESENT.has(code)) slot.present += 1
    else if (code === 'LWP') slot.lwp += 1
    else if (code === 'W/OFF') slot.off += 1
    else slot.leave += 1
    perDay.set(date, slot)
    const id = String(row.employee_id)
    const person = people.get(id) ?? { employeeId: id, name: String(row.name ?? id), category: text(row.category), marks: {}, present: 0, lwp: 0 }
    person.marks[date] = code
    if (PRESENT.has(code)) person.present += 1
    if (code === 'LWP' || code === 'ESIC') person.lwp += 1
    people.set(id, person)
  }
  const days: string[] = []
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10))
  }
  const result: AttendanceMonth = {
    month,
    days,
    codes,
    perDay: days.map((date) => ({ date, ...(perDay.get(date) ?? { present: 0, leave: 0, lwp: 0, off: 0 }) })),
    people: people.size,
  }
  if (options.names) result.rows = [...people.values()]
  return result
}

export type PeelingMonth = {
  month: string
  days: number
  classes: Array<{ workerClass: string; workers: number; kg: number; incentive: number }>
  totalKg: number
  totalIncentive: number
  /** Per worker, only when asked for names. */
  leaderboard?: Array<{ name: string; workerClass: string; kg: number; days: number; avgKg: number; incentive: number }>
}

export async function peelingMonth(sql: SapSql, month: string, options: { names?: boolean; limit?: number } = {}): Promise<PeelingMonth> {
  const [classes, [days], workers] = await Promise.all([
    sql`
      select worker_class, count(distinct row_no) as workers, sum(kg) as kg, sum(incentive) as incentive
      from hr.peeling_output where month = ${month}::date group by 1 order by 1`,
    sql`select count(distinct work_date) as n from hr.peeling_output where month = ${month}::date`,
    options.names
      ? sql`
          select worker_name, worker_class, sum(kg) as kg, count(*) as days, sum(incentive) as incentive
          from hr.peeling_output where month = ${month}::date group by row_no, worker_name, worker_class
          order by sum(incentive) desc, sum(kg) desc limit ${options.limit ?? 100}`
      : Promise.resolve([]),
  ])
  const list = classes.map((row) => ({
    workerClass: String(row.worker_class),
    workers: num(row.workers),
    kg: round2(num(row.kg)),
    incentive: round2(num(row.incentive)),
  }))
  const result: PeelingMonth = {
    month,
    days: num(days?.n),
    classes: list,
    totalKg: round2(list.reduce((sum, row) => sum + row.kg, 0)),
    totalIncentive: round2(list.reduce((sum, row) => sum + row.incentive, 0)),
  }
  if (options.names) {
    result.leaderboard = workers.map((row) => ({
      name: String(row.worker_name).trim(),
      workerClass: String(row.worker_class),
      kg: round2(num(row.kg)),
      days: num(row.days),
      avgKg: round2(num(row.kg) / Math.max(num(row.days), 1)),
      incentive: round2(num(row.incentive)),
    }))
  }
  return result
}

export type LeaveSummary = {
  from: string | null
  to: string | null
  count: number
  days: number
  byType: Array<{ leaveType: string; requests: number; days: number }>
  byStatus: Array<{ status: string; requests: number }>
  rows?: Array<{ name: string | null; code: string; leaveType: string; from: string | null; to: string | null; days: number | null; status: string | null; reason: string | null }>
}

export async function leaveSummary(
  sql: SapSql,
  filter: { from?: string | null; to?: string | null; codes?: readonly string[] | null; names?: boolean } = {},
): Promise<LeaveSummary> {
  const codes = filter.codes ? `{${filter.codes.map((code) => `"${code.replace(/"/g, '')}"`).join(',')}}` : null
  const where = sql`
    where (${filter.from ?? null}::date is null or coalesce(to_date, from_date) >= ${filter.from ?? null}::date)
      and (${filter.to ?? null}::date is null or from_date <= ${filter.to ?? null}::date)
      and (${codes}::text[] is null or code_voyon = any(${codes}::text[]) or employee_id = any(${codes}::text[]))`
  const [types, statuses, rows] = await Promise.all([
    sql`select leave_type, count(*) as n, coalesce(sum(days), 0) as days from hr.leave_requests ${where} group by 1 order by 2 desc`,
    sql`select coalesce(status, 'Unknown') as status, count(*) as n from hr.leave_requests ${where} group by 1 order by 2 desc`,
    filter.names ? sql`select * from hr.leave_requests ${where} order by from_date desc, request_no desc limit 50` : Promise.resolve([]),
  ])
  const result: LeaveSummary = {
    from: filter.from ?? null,
    to: filter.to ?? null,
    count: types.reduce((sum, row) => sum + num(row.n), 0),
    days: round2(types.reduce((sum, row) => sum + num(row.days), 0)),
    byType: types.map((row) => ({ leaveType: String(row.leave_type), requests: num(row.n), days: round2(num(row.days)) })),
    byStatus: statuses.map((row) => ({ status: String(row.status), requests: num(row.n) })),
  }
  if (filter.names) {
    result.rows = rows.map((row) => ({
      name: text(row.employee_name),
      code: String(row.code_voyon),
      leaveType: String(row.leave_type),
      from: day(row.from_date),
      to: day(row.to_date),
      days: numOrNull(row.days),
      status: text(row.status),
      reason: text(row.reason),
    }))
  }
  return result
}

export type Reconciliation = {
  month: string
  payroll: { voyonNet: number | null; voyonEarned: number | null; registerEarned: number | null; registerNet: number | null; tempEarned: number | null; tempNet: number | null }
  /** The month's salary journal entry in SAP, per salary account (debits less credits). */
  journal: Array<{ account: string; amount: number }>
  journalTotal: number
  employerContribution: number
  /** Payments to the salary payable account in this month and the next (salaries are paid early the next month). */
  paidInMonth: number
  paidNextMonth: number
  paymentsNextMonth: number
}

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

/** A month's payroll against SAP: the lump salary JE and the salary payments (SAP books payroll only as money). */
export async function reconciliation(sql: SapSql, month: string): Promise<Reconciliation> {
  const next = nextMonth(month)
  const [runs, journal, [paid]] = await Promise.all([
    sql`select r.source, sum(l.net) as net, sum(l.total_earning) as earned from hr.payroll_runs r join hr.payroll_lines l using (run_id) where r.month = ${month}::date group by r.source`,
    sql`
      select account_name, kind, sum(net) as net from erp.cost_gl_monthly
      where month = ${month}::date and kind in ('salary_expense', 'employer_contribution') group by 1, 2 order by 3 desc`,
    sql`
      select coalesce(sum(p.amount) filter (where p.doc_date >= ${month}::date and p.doc_date < ${next}::date), 0) as in_month,
             coalesce(sum(p.amount) filter (where p.doc_date >= ${next}::date and p.doc_date < (${next}::date + interval '1 month')), 0) as next_month,
             count(*) filter (where p.doc_date >= ${next}::date and p.doc_date < (${next}::date + interval '1 month')) as n_next
      from erp.payments p where not p.cancelled and p.direction = 'out'
        and p.purpose_gl in (select gl_code from erp.cost_gl_accounts where kind = 'salary_payable')`,
  ])
  const run = (source: string) => runs.find((row) => row.source === source)
  const pick = (source: string, field: 'net' | 'earned') => (run(source) ? round2(num(run(source)![field])) : null)
  const salary = journal.filter((row) => row.kind === 'salary_expense')
  return {
    month,
    payroll: {
      voyonNet: pick('voyon', 'net'),
      voyonEarned: pick('voyon', 'earned'),
      registerEarned: pick('register', 'earned'),
      registerNet: pick('register', 'net'),
      tempEarned: pick('temp_sheet', 'earned'),
      tempNet: pick('temp_sheet', 'net'),
    },
    journal: salary.map((row) => ({ account: String(row.account_name), amount: round2(num(row.net)) })),
    journalTotal: round2(salary.reduce((sum, row) => sum + num(row.net), 0)),
    employerContribution: round2(journal.filter((row) => row.kind === 'employer_contribution').reduce((sum, row) => sum + num(row.net), 0)),
    paidInMonth: round2(num(paid?.in_month)),
    paidNextMonth: round2(num(paid?.next_month)),
    paymentsNextMonth: num(paid?.n_next),
  }
}

/** A Voyon (TF901) or salary-register (T99, TFL0999) employee code. */
export const EMPLOYEE_CODE = /^(?:TFL|TF|T)\d{1,5}$/i

export type EmployeeMatch = { employeeId: string; name: string; codeVoyon: string | null; codeRegister: string | null; department: string | null; designation: string | null; category: string | null }

/** One person by a code (TF…, T…, TFL…) or their name; several when a name is not unique. */
export async function findEmployees(sql: SapSql, query: string): Promise<EmployeeMatch[]> {
  const value = query.trim()
  const code = value.toUpperCase().replace(/\s+/g, '')
  const words = value.toLowerCase().replace(/[^a-z ]+/g, ' ').trim()
  const rows = EMPLOYEE_CODE.test(code)
    ? await sql`select * from hr.employees where upper(code_voyon) = ${code} or upper(code_register) = ${code} or employee_id = ${code}`
    : words.length >= 3
      ? await sql`select * from hr.employees where name_key like ${`%${words.split(/\s+/).join('%')}%`} order by name limit 5`
      : []
  return rows.map((row) => ({
    employeeId: String(row.employee_id),
    name: String(row.name),
    codeVoyon: text(row.code_voyon),
    codeRegister: text(row.code_register),
    department: text(row.department),
    designation: text(row.designation),
    category: text(row.category),
  }))
}

/** One person's pay lines in a month (every payroll that has them). */
export async function employeePay(sql: SapSql, employeeId: string, month: string): Promise<PayLine[]> {
  const rows = await sql`
    select l.*, r.source from hr.payroll_lines l join hr.payroll_runs r using (run_id)
    where r.month = ${month}::date and l.employee_id = ${employeeId} order by r.source`
  return rows.map(payLine)
}
