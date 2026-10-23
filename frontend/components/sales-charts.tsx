import { AgentChart, type ChartSpec } from './agent-chart'
import { dayShort, inrShort } from '@/lib/format'
import type { SalesCharts } from '@/lib/types'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** A customer without its legal suffix, so branches of one company stay apart in a narrow label. */
function shortName(name: string): string {
  return name
    .replace(/\b(?:private|pvt\.?)\s+(?:limited|ltd\.?)|\blimited\b|\bltd\b\.?|\bllp\b/gi, '')
    .replace(/\s*-\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The command centre's sales charts: the last twelve complete months of invoicing, then what sold and to whom over 90 days. */
export function SalesChartGrid({ charts, asOf }: { charts: SalesCharts; asOf: string }) {
  const window = `${dayShort(charts.windowFrom)} – ${dayShort(asOf)}`
  const lastDay = new Date(Date.UTC(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)), 0)).getUTCDate()
  const partial = Number(asOf.slice(8, 10)) < lastDay

  // A month still running would read as a collapse at the end of the line: show complete months, and say the rest.
  const months = (partial ? charts.monthly.slice(0, -1) : charts.monthly.slice(1)).slice(-12)
  const running = partial ? charts.monthly.at(-1) : undefined
  const trend: ChartSpec = {
    type: 'line',
    title: 'Invoiced sales by month',
    labels: months.map((row) => row.month),
    series: [{ name: 'Invoiced', values: months.map((row) => row.value) }],
    unit: 'inr',
    note: `Including tax.${running ? ` ${MONTHS[Number(asOf.slice(5, 7)) - 1]} so far: ${inrShort(running.value)} to ${dayShort(asOf)}.` : ''}`,
  }
  const items: ChartSpec | null = charts.topItems.rows.length
    ? {
        type: 'pie',
        title: 'Top products',
        labels: [...charts.topItems.rows.map((row) => row.name), ...(charts.topItems.other > 0 ? ['All other products'] : [])],
        series: [
          {
            name: 'Invoiced before tax',
            values: [...charts.topItems.rows.map((row) => row.value), ...(charts.topItems.other > 0 ? [charts.topItems.other] : [])],
          },
        ],
        unit: 'inr',
        other: charts.topItems.other > 0,
        note: `Before tax · ${window}`,
      }
    : null
  const customers: ChartSpec | null = charts.topCustomers.length
    ? {
        type: 'bar',
        title: 'Top customers',
        labels: charts.topCustomers.map((row) => shortName(row.name)),
        series: [{ name: 'Invoiced', values: charts.topCustomers.map((row) => row.value) }],
        unit: 'inr',
        note: `Including tax · ${window}`,
      }
    : null

  return (
    <div className="dashcharts">
      <div className="card dashchart wide">
        <AgentChart chart={trend} />
      </div>
      <div className="card dashchart">
        {items ? <AgentChart chart={items} /> : <p className="muted">No invoices from {window}.</p>}
      </div>
      <div className="card dashchart">
        {customers ? <AgentChart chart={customers} /> : <p className="muted">No invoices from {window}.</p>}
      </div>
    </div>
  )
}
