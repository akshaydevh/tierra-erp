import { forbidden } from 'next/navigation'
import { DataTable, type Column } from '@/components/data-table'
import { Kpi, KpiStrip } from '@/components/kpi'
import { SectionHead } from '@/components/section-head'
import { ApiError, api } from '@/lib/api'
import { dayTime, inr, inrShort, num } from '@/lib/format'
import { canOpen } from '@/lib/nav'
import { first, hrefFor, type SearchParams } from '@/lib/query'
import type { Me, PayrollCategory, PayrollResponse, PayrollRunSummary } from '@/lib/types'

const PATH = '/payroll'

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
}

/** Attendance codes as the register's legend spells them, with a tone for the grid. */
const CODES: Array<{ code: string; label: string; tone: string }> = [
  { code: 'P', label: 'Present', tone: 'ok' },
  { code: 'Offday', label: 'Worked an off day', tone: 'ink' },
  { code: 'OD', label: 'On duty', tone: 'ok' },
  { code: 'W/OFF', label: 'Weekly off', tone: 'grey' },
  { code: 'CL', label: 'Casual leave', tone: 'amber' },
  { code: 'EL', label: 'Earned leave', tone: 'amber' },
  { code: 'PH', label: 'Paid holiday', tone: 'grey' },
  { code: 'C/off', label: 'Compensatory off', tone: 'grey' },
  { code: 'LWP', label: 'Leave without pay', tone: 'coral' },
  { code: 'ESIC', label: 'On ESIC leave', tone: 'coral' },
]
const TONE = Object.fromEntries(CODES.map((entry) => [entry.code, entry.tone]))
const SHORT: Record<string, string> = { Offday: 'OD+', 'W/OFF': 'WO', 'C/off': 'CO' }

const RUN_NOTES: Record<string, string> = {
  voyon: 'The Voyon payroll export: permanent staff, by Voyon department.',
  register: 'The salary register (the payroll actually computed): the same permanent staff by category, plus a few not on Voyon.',
  temp_sheet: 'The temporary workers’ wages sheet: day wages, peeling and attendance incentives, ESI. Outside Voyon and the register.',
}

const categoryColumns: Column<PayrollCategory>[] = [
  { key: 'label', label: 'Category', render: (row) => <b>{row.label}</b> },
  { key: 'people', label: 'People', num: true, render: (row) => num(row.people) },
  { key: 'totalEarning', label: 'Earned', num: true, render: (row) => inr(row.totalEarning) },
  { key: 'pf', label: 'PF', num: true, render: (row) => (row.pf ? inr(row.pf) : '—') },
  { key: 'esi', label: 'ESI', num: true, render: (row) => (row.esi ? inr(row.esi) : '—') },
  { key: 'deductions', label: 'All deductions', num: true, render: (row) => inr(row.deductions) },
  { key: 'net', label: 'Net pay', num: true, render: (row) => inr(row.net) },
]

function RunTable({ run }: { run: PayrollRunSummary }) {
  return (
    <>
      <SectionHead title={`${run.label}: ${num(run.headcount)} people, net ${inr(run.net)}`} sub={`${RUN_NOTES[run.source] ?? ''} File: ${run.fileName}.`} />
      <DataTable
        caption={run.label}
        columns={categoryColumns}
        rows={run.categories}
        rowKey={(row) => row.category}
        total={{ people: num(run.headcount), totalEarning: inr(run.totalEarning), pf: inr(run.pf), esi: inr(run.esi), deductions: inr(run.deductions), net: inr(run.net) }}
      />
    </>
  )
}

function MonthForm({ data }: { data: PayrollResponse }) {
  return (
    <form className="daypick" action={PATH} method="get">
      <label htmlFor="pay-month">Payroll month</label>
      <select id="pay-month" name="month" defaultValue={data.month.slice(0, 7)}>
        {data.months.map((month) => (
          <option key={month} value={month.slice(0, 7)}>
            {monthLabel(month)}
          </option>
        ))}
      </select>
      {data.peelingMonths.length > 1 ? (
        <>
          <label htmlFor="pay-peeling">Peeling month</label>
          <select id="pay-peeling" name="peeling" defaultValue={data.peeling?.month.slice(0, 7)}>
            {data.peelingMonths.map((month) => (
              <option key={month} value={month.slice(0, 7)}>
                {monthLabel(month)}
              </option>
            ))}
          </select>
        </>
      ) : null}
      <button type="submit" className="btn-sec">
        Show
      </button>
    </form>
  )
}

function AttendanceGrid({ attendance }: { attendance: NonNullable<PayrollResponse['attendance']> }) {
  const rows = attendance.rows ?? []
  return (
    <div className="tblwrap">
      <table className="dt attgrid" style={{ minWidth: 260 + attendance.days.length * 34 }}>
        <caption className="sr">Attendance for {monthLabel(attendance.month)}</caption>
        <thead>
          <tr>
            <th scope="col">Person</th>
            {attendance.days.map((date) => (
              <th key={date} scope="col" className="r">
                {Number(date.slice(8, 10))}
              </th>
            ))}
            <th scope="col" className="r">
              Present
            </th>
            <th scope="col" className="r">
              LWP
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.employeeId}>
              <td className="nw">
                {row.name}
                <div className="sub">{row.employeeId}</div>
              </td>
              {attendance.days.map((date) => {
                const code = row.marks[date]
                return (
                  <td key={date} className="r">
                    {code ? (
                      <span className={`att ${TONE[code] ?? 'grey'}`} title={code}>
                        {SHORT[code] ?? code}
                      </span>
                    ) : (
                      ''
                    )}
                  </td>
                )
              })}
              <td className="r num">{num(row.present)}</td>
              <td className={`r num${row.lwp ? ' neg' : ''}`}>{num(row.lwp)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Present</td>
            {attendance.perDay.map((cell) => (
              <td key={cell.date} className="r num">
                {cell.present || ''}
              </td>
            ))}
            <td />
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

export default async function PayrollPage({ searchParams }: { searchParams: SearchParams }) {
  const { user } = await api<{ user: Me }>('/api/auth/me')
  if (!canOpen(user.role, PATH)) forbidden()
  const params = await searchParams
  let data: PayrollResponse
  try {
    data = await api<PayrollResponse>(hrefFor('/api/payroll', { month: first(params.month), peeling: first(params.peeling) }))
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) forbidden()
    if (error instanceof ApiError && error.status === 503) {
      return (
        <div className="card empty">
          <h3>No HR data yet</h3>
          <p>Payroll and attendance come from the HR spreadsheets (Voyon, the salary register, the peeling register), loaded with the importer’s hr command. SAP has none of it.</p>
        </div>
      )
    }
    throw error
  }
  const voyon = data.payroll.runs.find((run) => run.source === 'voyon')
  const register = data.payroll.runs.find((run) => run.source === 'register')
  const lead = voyon ?? register ?? data.payroll.runs[0]
  const rec = data.reconciliation
  const att = data.attendance
  const tempPeople = data.headcount.temps.reduce((sum, row) => sum + row.people, 0)
  const present = att ? (att.codes.P ?? 0) + (att.codes.Offday ?? 0) + (att.codes.OD ?? 0) : 0
  const marked = att ? Object.values(att.codes).reduce((sum, n) => sum + n, 0) : 0

  return (
    <>
      <div className="asof">
        <span className="dot" aria-hidden="true" />
        <span className="asoftext">
          <b>HR files</b> (Voyon, salary register, wages and peeling sheets){data.importedAt ? <span className="asofsub"> · imported {dayTime(data.importedAt)}</span> : null}. SAP keeps no payroll, only the monthly salary journal.
        </span>
      </div>
      <KpiStrip label="Payroll and attendance">
        <Kpi
          chip="₹"
          label={`${monthLabel(data.month)} payroll${lead ? ` (${lead.label})` : ''}`}
          value={lead ? inr(lead.net) : '—'}
          stamp={lead ? `Net pay for ${num(lead.headcount)} people${lead.source === 'voyon' ? ` · basic pay ${inr(lead.basic)} · earned ${inrShort(lead.totalEarning)}` : ''}` : undefined}
        />
        <Kpi
          chip="HC"
          tone="leaf"
          label="On the roll"
          value={num(data.headcount.total + tempPeople)}
          stamp={`${num(data.headcount.voyonMaster)} on Voyon, ${num(data.headcount.onVoyonPayroll)} on its payroll, ${num(data.headcount.registerOnly)} register only, ${num(tempPeople)} temporary`}
        />
        <Kpi
          chip="ATT"
          tone="amber"
          label={att ? `Attendance, ${monthLabel(att.month)}` : 'Attendance'}
          value={att && marked ? `${Math.round((present / marked) * 100)}%` : '—'}
          stamp={att ? `${num(att.people)} people · present ${num(present)} days · LWP ${num(att.codes.LWP ?? 0)}` : 'No attendance sheet loaded'}
        />
        <Kpi
          chip="PEEL"
          label={data.peeling ? `Peeling incentive, ${monthLabel(data.peeling.month)}` : 'Peeling incentive'}
          value={data.peeling ? inr(data.peeling.totalIncentive) : '—'}
          stamp={data.peeling ? `${num(data.peeling.totalKg)} kg peeled over ${num(data.peeling.days)} days` : 'No peeling register loaded'}
        />
      </KpiStrip>
      <div className="toolbar">
        <MonthForm data={data} />
      </div>

      <section className="sec" aria-labelledby="pay-head">
        <SectionHead
          id="pay-head"
          title={`Payroll for ${monthLabel(data.month)} by category`}
          sub="Voyon and the salary register are the same permanent staff: never add them together. The temporary workers are a separate sheet."
          zid="Zone 1 · Payroll"
        />
        {data.payroll.runs.map((run) => (
          <RunTable key={run.runId} run={run} />
        ))}
      </section>

      {rec ? (
        <section className="sec" aria-labelledby="rec-head">
          <SectionHead
            id="rec-head"
            title="Against SAP"
            sub={`SAP books payroll as one salary journal entry a month and pays it from the salary payable account, mostly early the next month. Figures for ${monthLabel(rec.month)}.`}
            zid="Zone 2 · Reconciliation"
          />
          <DataTable
            caption="Payroll against SAP"
            columns={[
              { key: 'what', label: 'Figure', render: (row: { what: string; amount: number | null; note?: string }) => <b>{row.what}</b>, sub: (row) => row.note },
              { key: 'amount', label: 'Amount', num: true, render: (row: { what: string; amount: number | null }) => inr(row.amount) },
            ]}
            rows={[
              { what: 'Salary register, earned', amount: rec.payroll.registerEarned, note: 'Total remuneration before deductions' },
              { what: 'Salary register, net pay', amount: rec.payroll.registerNet },
              { what: 'Voyon, net pay', amount: rec.payroll.voyonNet },
              { what: 'Temporary workers, net pay', amount: rec.payroll.tempNet },
              ...rec.journal.map((row) => ({ what: `SAP salary journal: ${row.account}`, amount: row.amount })),
              { what: 'SAP salary journal, total', amount: rec.journalTotal, note: register ? `${inr(rec.journalTotal - register.totalEarning)} more than the register's earned total` : undefined },
              { what: 'SAP employer PF / ESI', amount: rec.employerContribution },
              { what: `Salary payments in ${monthLabel(rec.month)}`, amount: rec.paidInMonth },
              { what: 'Salary payments the next month', amount: rec.paidNextMonth, note: `${num(rec.paymentsNextMonth)} payments to the salary payable account` },
            ]}
            rowKey={(row) => row.what}
          />
        </section>
      ) : null}

      <section className="sec" aria-labelledby="hc-head">
        <SectionHead id="hc-head" title="Headcount" sub="Voyon departments and the register's categories; temporary workers are on the wages sheet only." zid="Zone 3 · People" />
        <DataTable
          caption="Headcount by department"
          columns={[
            { key: 'department', label: 'Voyon department', render: (row) => <b>{row.department}</b> },
            { key: 'people', label: 'People', num: true, render: (row) => num(row.people) },
            { key: 'onPayroll', label: 'On the Voyon payroll', num: true, render: (row) => num(row.onPayroll) },
          ]}
          rows={data.headcount.byDepartment}
          rowKey={(row) => row.department}
          total={{ people: num(data.headcount.total), onPayroll: num(data.headcount.onVoyonPayroll) }}
        />
        <DataTable
          caption="Headcount by category"
          columns={[
            { key: 'label', label: 'Category', render: (row) => <b>{row.label}</b> },
            { key: 'people', label: 'People', num: true, render: (row) => num(row.people) },
          ]}
          rows={[...data.headcount.byCategory, ...data.headcount.temps.map((row) => ({ category: row.block, label: row.label, people: row.people }))]}
          rowKey={(row) => row.category}
        />
        {data.headcount.punch.length ? (
          <p className="note">Voyon punch report: {data.headcount.punch.map((row) => `${row.status} ${num(row.people)}`).join(' · ')}.</p>
        ) : null}
      </section>

      {att ? (
        <section className="sec" aria-labelledby="att-head">
          <SectionHead
            id="att-head"
            title={`Attendance, ${monthLabel(att.month)}`}
            sub={`${CODES.filter((entry) => att.codes[entry.code]).map((entry) => `${entry.code} ${entry.label.toLowerCase()} ${num(att.codes[entry.code])}`).join(' · ')}. From the salary register's attendance sheet (permanent staff).`}
            zid="Zone 4 · Attendance"
          />
          <AttendanceGrid attendance={att} />
        </section>
      ) : null}

      {data.peeling ? (
        <section className="sec" aria-labelledby="peel-head">
          <SectionHead
            id="peel-head"
            title={`Peeling incentive, ${monthLabel(data.peeling.month)}: ${inr(data.peeling.totalIncentive)}`}
            sub={`${data.peeling.classes.map((row) => `${row.workerClass} ${num(row.workers)} workers, ${num(row.kg)} kg, ${inr(row.incentive)}`).join(' · ')}. Slabs: permanent 161–200 kg a day × ₹0.25, 201–500 kg × ₹0.75; others from 150 kg × ₹0.75.`}
            zid="Zone 5 · Peeling"
          />
          <DataTable
            caption="Peeling incentive leaderboard"
            columns={[
              { key: 'name', label: 'Peeler', render: (row) => <b>{row.name}</b>, sub: (row) => row.workerClass },
              { key: 'days', label: 'Days', num: true, render: (row) => num(row.days) },
              { key: 'kg', label: 'Kg peeled', num: true, render: (row) => num(row.kg) },
              { key: 'avgKg', label: 'Kg a day', num: true, render: (row) => num(row.avgKg) },
              { key: 'incentive', label: 'Incentive', num: true, render: (row) => inr(row.incentive) },
            ]}
            rows={data.peeling.leaderboard ?? []}
            rowKey={(row) => `${row.name}-${row.workerClass}`}
            total={{ kg: num(data.peeling.totalKg), incentive: inr(data.peeling.totalIncentive) }}
          />
        </section>
      ) : null}

      <section className="sec" aria-labelledby="leave-head">
        <SectionHead
          id="leave-head"
          title={`Leave requests: ${num(data.leave.count)}`}
          sub={`From Voyon. ${data.leave.byStatus.map((row) => `${row.status} ${num(row.requests)}`).join(' · ')}.`}
          zid="Zone 6 · Leave"
        />
        <DataTable
          caption="Leave requests by type"
          columns={[
            { key: 'leaveType', label: 'Type', render: (row) => <b>{row.leaveType}</b> },
            { key: 'requests', label: 'Requests', num: true, render: (row) => num(row.requests) },
            { key: 'days', label: 'Days', num: true, render: (row) => num(row.days, 1) },
          ]}
          rows={data.leave.byType}
          rowKey={(row) => row.leaveType}
          empty={<p>No leave requests on file.</p>}
        />
      </section>
    </>
  )
}
