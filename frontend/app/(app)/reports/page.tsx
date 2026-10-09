import Link from 'next/link'
import { DataAsOf } from '@/components/data-as-of'
import { DayPicker } from '@/components/day-picker'
import { SectionHead } from '@/components/section-head'
import { api, getMeta } from '@/lib/api'
import { addDays, day, dayTime, isIsoDay, num } from '@/lib/format'
import { first, type SearchParams } from '@/lib/query'
import {
  MANPOWER_KEYS,
  MANPOWER_LABELS,
  type DailyInputsResponse,
  type DailyReportPayload,
  type DailyReportResponse,
  type ReportLine,
  type ReportsInfo,
} from '@/lib/types'
import { BasisSelect, InputsForm, SendToWhatsapp } from './report-forms'

const PATH = '/reports'

const money = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const amount = (n: number | null | undefined) => (n == null ? '' : money.format(n))

function yesNo(value: boolean | null): string {
  return value == null ? '—' : value ? 'Yes' : 'No'
}

/** The same payload the PDF prints, as HTML: the sheet's blocks in its order. */
function Preview({ payload }: { payload: DailyReportPayload }) {
  const banks = payload.banks
  const rows = Math.max(payload.receipts.length, payload.payments.length, 1)
  const lineCells = (line: ReportLine | undefined, index: number) => (
    <>
      <td className="r num">{line ? index + 1 : ''}</td>
      <td>
        {line ? line.label : ''}
        {line?.movedFrom ? <sup title={`dated ${day(line.movedFrom)} in SAP`}> *</sup> : null}
        {line?.ref ? <div className="sub">{line.ref}</div> : null}
      </td>
      {banks.map((bank) => (
        <td key={bank.glCode} className={`r num${bank.houseBank ? ' house' : ''}`}>
          {line && line.bank === bank.bank ? amount(line.amount) : ''}
        </td>
      ))}
    </>
  )
  return (
    <div className="card p6 drpreview">
      <div className="drtitle">
        <b>DAILY REPORT</b> · {day(payload.reportDate)}
      </div>
      <table className="dt drgrid">
        <tbody>
          <tr>
            <th>Production</th>
            <td>{yesNo(payload.activity.production.value)}</td>
            <th>Packing</th>
            <td>{yesNo(payload.activity.packing.value)}</td>
            <th>Cartoning</th>
            <td>{yesNo(payload.activity.cartoning.value)}</td>
          </tr>
        </tbody>
      </table>
      {payload.activity.production.detail ? <p className="stamp">SAP: {payload.activity.production.detail}</p> : null}

      <table className="dt drgrid">
        <thead>
          <tr>
            {MANPOWER_KEYS.map((key) => (
              <th key={key} className="r">
                {MANPOWER_LABELS[key]}
              </th>
            ))}
            <th className="r">Total</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            {MANPOWER_KEYS.map((key) => (
              <td key={key} className="r num">
                {payload.manpower.values ? num(payload.manpower.values[key]) : '—'}
              </td>
            ))}
            <td className="r num">
              <b>{payload.manpower.total != null ? num(payload.manpower.total) : '—'}</b>
            </td>
          </tr>
        </tbody>
      </table>
      {payload.manpower.values ? null : <p className="formerror">Manpower not entered — reply *manpower …* to Tierra Bot, or enter it above.</p>}

      {payload.kind === 'full' ? (
        <div className="drsplit">
          <table className="dt drgrid">
            <thead>
              <tr>
                <th colSpan={2}>Bank receipts</th>
                {banks.map((bank) => (
                  <th key={bank.glCode} className={`r${bank.houseBank ? ' house' : ''}`}>
                    {bank.bank}
                  </th>
                ))}
              </tr>
              <tr>
                <td colSpan={2}>
                  <b>Opening balance</b>
                </td>
                {banks.map((bank) => (
                  <td key={bank.glCode} className={`r num${bank.houseBank ? ' house' : ''}`}>
                    {amount(bank.opening)}
                  </td>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, index) => (
                <tr key={index}>{lineCells(payload.receipts[index], index)}</tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>Total</td>
                {banks.map((bank) => (
                  <td key={bank.glCode} className={`r num${bank.houseBank ? ' house' : ''}`}>
                    {amount(bank.receipts)}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
          <table className="dt drgrid">
            <thead>
              <tr>
                <th colSpan={2}>Bank payments</th>
                {banks.map((bank) => (
                  <th key={bank.glCode} className={`r${bank.houseBank ? ' house' : ''}`}>
                    {bank.bank}
                  </th>
                ))}
              </tr>
              <tr>
                <td colSpan={2}>
                  <b>Closing balance</b>
                </td>
                {banks.map((bank) => (
                  <td key={bank.glCode} className={`r num${bank.houseBank ? ' house' : ''}`}>
                    <b>{amount(bank.closing)}</b>
                  </td>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, index) => (
                <tr key={index}>{lineCells(payload.payments[index], index)}</tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>Total</td>
                {banks.map((bank) => (
                  <td key={bank.glCode} className={`r num${bank.houseBank ? ' house' : ''}`}>
                    {amount(bank.payments)}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}

      <div className="drsplit">
        <table className="dt drgrid">
          <thead>
            <tr>
              <th>Material inwards</th>
              <th>Quantity</th>
              <th>Remarks</th>
            </tr>
          </thead>
          <tbody>
            {payload.inwards.map((row) => (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td>
                  {row.quantity ?? ''}
                  {row.grns.length ? <div className="sub">{row.grns.join(', ')}</div> : null}
                </td>
                <td>{row.remarks ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="dt drgrid">
          <thead>
            <tr>
              <th>Material outwards</th>
              <th className="r">Value</th>
            </tr>
          </thead>
          <tbody>
            {payload.outwards.rows.map((row) => (
              <tr key={row.label}>
                <td>
                  {row.label}
                  <div className="sub">{row.invoices.join(', ')}</div>
                </td>
                <td className="r num">{amount(row.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total invoice amount</td>
              <td className="r num">{amount(payload.outwards.total)}</td>
            </tr>
            <tr>
              <td>Monthly total (incl. GST), {payload.outwards.monthLabel}</td>
              <td className="r num">{payload.outwards.monthToDate != null ? amount(payload.outwards.monthToDate) : '—'}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {payload.notes ? <p className="note">Notes: {payload.notes}</p> : null}
      <ul className="drnotes">
        {payload.footnotes.map((line) => (
          <li key={line}>{line.replace(/\*([^*\n]+)\*/g, '$1')}</li>
        ))}
      </ul>
      {payload.knownDifferences.length ? (
        <>
          <p className="stamp">Known differences vs manual sheet</p>
          <ul className="drnotes">
            {payload.knownDifferences.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  )
}

export default async function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const [meta, info] = await Promise.all([getMeta(), api<ReportsInfo>('/api/reports')])
  const asked = first(params.date)
  const date = isIsoDay(asked) ? asked : info.defaultDate
  const [inputs, report] = await Promise.all([
    api<DailyInputsResponse>(`/api/reports/daily-inputs/${date}`),
    info.canSeeReport ? api<DailyReportResponse>(`/api/reports/daily/${date}`) : Promise.resolve(null),
  ])
  const payload = report?.payload ?? null

  return (
    <>
      <DataAsOf meta={meta} />
      <div className="toolbar">
        <DayPicker path={PATH} query={{}} value={date} label="Daily report for" />
        <nav className="actions" aria-label="Nearby days">
          <Link className="btn-sec" href={`${PATH}?date=${addDays(date, -1)}`}>
            Previous day
          </Link>
          <Link className="btn-sec" href={`${PATH}?date=${addDays(date, 1)}`}>
            Next day
          </Link>
        </nav>
      </div>

      <section className="sec" aria-labelledby="inputs-head">
        <SectionHead
          id="inputs-head"
          title={`Inputs for ${day(date)}`}
          sub="What SAP does not have: manpower, the gate estimate of banana and cassava, and whether production, packing and cartoning ran (left as SAP shows unless set)."
          zid="Zone 1 · Inputs"
        />
        <InputsForm key={date} date={date} inputs={inputs.inputs} canEdit={info.canEditInputs} />
      </section>

      {info.canSeeReport && payload ? (
        <section className="sec" aria-labelledby="report-head">
          <SectionHead
            id="report-head"
            title={`Daily report ${day(date)}`}
            sub={
              payload.kind === 'inputs_only'
                ? `SAP data ends ${day(payload.dataAsOf)}: only the inputs can be shown for this day.`
                : `Built from SAP (data as of ${day(payload.dataAsOf)})${report?.latest ? ` · last generated ${dayTime(report.latest.createdAt)}, version ${report.latest.version}` : ''}.`
            }
            zid="Zone 2 · Report"
            actions={
              <span className="actions">
                <a className="btn-pri" href={`/api/reports/daily/${date}.pdf?download=1`}>
                  Download PDF
                </a>
                <SendToWhatsapp date={date} />
              </span>
            }
          />
          {info.canChangeBasis ? <BasisSelect basis={info.basis} /> : null}
          <Preview payload={payload} />
        </section>
      ) : (
        <section className="sec">
          <div className="card empty">
            <h3>The report itself</h3>
            <p>The daily report carries bank balances, so it is for the manager and the admin. Your inputs above go into it.</p>
          </div>
        </section>
      )}
    </>
  )
}
