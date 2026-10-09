import Link from 'next/link'
import { forbidden } from 'next/navigation'
import { DataAsOf, NotImported } from '@/components/data-as-of'
import { DataTable, type Column } from '@/components/data-table'
import { Kpi, KpiStrip } from '@/components/kpi'
import { Pager } from '@/components/pager'
import { SearchBox } from '@/components/search-box'
import { SectionHead } from '@/components/section-head'
import { Tabs } from '@/components/tabs'
import { api, getMeta } from '@/lib/api'
import { day, inr, inrShort, num, qty, rate } from '@/lib/format'
import { canOpen } from '@/lib/nav'
import { first, hrefFor, oneOf, pageOf, type Query, type SearchParams } from '@/lib/query'
import {
  COSTING_SPANS,
  COSTING_TABS,
  type CostingKpis,
  type CostingResponse,
  type MarginRow,
  type Me,
  type ProductionCostRow,
  type ValuationRow,
} from '@/lib/types'

const PATH = '/costing'

const TAB_OPTIONS = [
  { key: 'skus', label: 'Margin by SKU' },
  { key: 'customers', label: 'Margin by customer' },
  { key: 'orders', label: 'Production orders' },
  { key: 'mix', label: 'Material mix' },
  { key: 'valuation', label: 'Stock valuation' },
]

const ROLE_LABELS: Record<string, string> = {
  raw_banana: 'Raw banana',
  raw_cassava: 'Raw cassava',
  oil: 'Oil',
  laminate: 'Laminate',
  carton: 'Cartons',
  seasoning: 'Flavour / seasoning',
  tape: 'Tape',
  consumable: 'Consumables (LPG, diesel …)',
  fg: 'Finished goods reworked',
  fg_reused: 'Finished goods reworked',
  overhead: 'Labour, power, water (₹0 in SAP)',
  other: 'Other',
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
}

function change(now: number | null, before: number | null): string {
  if (now == null || before == null || before === 0) return ''
  const pct = ((now - before) / Math.abs(before)) * 100
  return `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}% on last month.`
}

const perPc = (n: number | null) => (n == null ? '—' : rate(n))

function marginColumns(by: 'sku' | 'customer'): Column<MarginRow>[] {
  return [
    by === 'sku'
      ? { key: 'name', label: 'SKU', render: (row) => <b>{row.itemCode}</b>, sub: (row) => row.name }
      : { key: 'name', label: 'Customer (company)', render: (row) => <b>{row.name}</b>, sub: (row) => `${num(row.cards)} ${row.cards === 1 ? 'card' : 'cards'}` },
    { key: 'qty', label: 'Pieces sold', num: true, render: (row) => num(row.qty) },
    { key: 'kg', label: 'kg', num: true, render: (row) => num(row.kg) },
    { key: 'revenue', label: 'Invoiced', num: true, render: (row) => inr(row.revenue) },
    ...(by === 'sku'
      ? [
          { key: 'pricePerPc', label: 'Price / pc', num: true, render: (row: MarginRow) => perPc(row.pricePerPc) } as Column<MarginRow>,
          {
            key: 'costPerPc',
            label: 'Material / pc',
            num: true,
            render: (row: MarginRow) => perPc(row.costPerPc),
            sub: (row: MarginRow) => (row.cogsFallbackPct >= 100 ? 'SAP COGS (not made)' : row.cogsPerPc != null ? `SAP COGS ${rate(row.cogsPerPc)}` : undefined),
          } as Column<MarginRow>,
          { key: 'marginPerPc', label: 'Margin / pc', num: true, render: (row: MarginRow) => perPc(row.marginPerPc), tone: (row: MarginRow) => ((row.marginPerPc ?? 0) < 0 ? 'neg' : undefined) } as Column<MarginRow>,
        ]
      : [{ key: 'materialCost', label: 'Material cost', num: true, render: (row: MarginRow) => inr(row.materialCost) } as Column<MarginRow>]),
    { key: 'margin', label: 'Material margin', num: true, render: (row) => inr(row.margin), tone: (row) => (row.margin < 0 ? 'neg' : undefined) },
    { key: 'marginPerKg', label: 'Margin / kg', num: true, render: (row) => perPc(row.marginPerKg) },
    { key: 'marginPct', label: 'Margin %', num: true, render: (row) => (row.marginPct == null ? '—' : `${row.marginPct.toFixed(1)}%`) },
  ]
}

const orderColumns: Column<ProductionCostRow>[] = [
  { key: 'docNo', label: 'Order', nowrap: true, render: (row) => <Link href={`/production/${row.docEntry}`}><b>{row.docNo}</b></Link>, sub: (row) => day(row.lastReceipt) },
  { key: 'itemCode', label: 'Made', render: (row) => row.itemCode, sub: (row) => row.itemName ?? undefined },
  { key: 'customerName', label: 'For', render: (row) => row.customerName ?? '—' },
  { key: 'producedQty', label: 'Pieces', num: true, render: (row) => num(row.producedQty) },
  { key: 'producedKg', label: 'kg', num: true, render: (row) => num(row.producedKg) },
  { key: 'materialCost', label: 'Material cost', num: true, render: (row) => inr(row.materialCost), sub: (row) => (row.returnedValue ? `${inr(row.returnedValue)} returned` : undefined) },
  { key: 'costPerPc', label: '₹ / pc', num: true, render: (row) => perPc(row.costPerPc) },
  { key: 'costPerKg', label: '₹ / kg', num: true, render: (row) => perPc(row.costPerKg) },
  {
    key: 'breakdown',
    label: 'Largest materials',
    render: (row) =>
      [...row.breakdown]
        .sort((a, b) => b.value - a.value)
        .slice(0, 3)
        .map((part) => `${ROLE_LABELS[part.role] ?? part.role} ${inrShort(part.value)}`)
        .join(' · ') || '—',
  },
]

const valuationColumns: Column<ValuationRow>[] = [
  { key: 'groupName', label: 'Item group', render: (row) => <b>{row.groupName}</b>, sub: (row) => (row.customerSupplied ? 'includes customer-supplied stock at ₹0' : undefined) },
  { key: 'whsCode', label: 'Warehouse' },
  { key: 'method', label: 'Valued by' },
  { key: 'items', label: 'Items', num: true, render: (row) => num(row.items) },
  { key: 'value', label: 'Value', num: true, render: (row) => inr(row.value) },
]

function PeriodForm({ query, data }: { query: Query; data: CostingResponse }) {
  return (
    <form className="daypick" action={PATH} method="get">
      <input type="hidden" name="tab" value={data.tab} />
      {query.q ? <input type="hidden" name="q" value={query.q} /> : null}
      <label htmlFor="cost-month">Month</label>
      <select id="cost-month" name="month" defaultValue={data.month.slice(0, 7)}>
        {data.months.map((month) => (
          <option key={month} value={month.slice(0, 7)}>
            {monthLabel(month)}
            {month.slice(0, 7) === data.asOf.slice(0, 7) ? ' (to date)' : ''}
          </option>
        ))}
      </select>
      <label htmlFor="cost-span">Months</label>
      <select id="cost-span" name="span" defaultValue={data.span}>
        {COSTING_SPANS.map((span) => (
          <option key={span} value={span}>
            {span === '1' ? 'This month only' : `${span} months to it`}
          </option>
        ))}
      </select>
      <button type="submit" className="btn-sec">
        Show
      </button>
    </form>
  )
}

function Kpis({ kpis, asOf }: { kpis: { current: CostingKpis; previous: CostingKpis }; asOf: string }) {
  const { current: now, previous: before } = kpis
  // a month still running is not compared with a whole one; rates per kg are
  const partial = now.month.slice(0, 7) === asOf.slice(0, 7)
  const toDate = partial ? ` to ${day(asOf)}` : ''
  return (
    <KpiStrip label="Costing">
      <Kpi
        chip="KG"
        label={`Produced, ${monthLabel(now.month)}${toDate}`}
        value={`${num(now.producedKg)} kg`}
        stamp={`${num(now.producedPcs)} pieces of finished goods.${partial ? ' Month to date.' : ` ${change(now.producedKg, before.producedKg)}`}`}
      />
      <Kpi chip="₹" tone="leaf" label="Value of production" value={inrShort(now.productionValue)} stamp="At SAP's receipt value (the material issued)" />
      <Kpi chip="MAT" tone="amber" label="Material cost per kg" value={now.materialCostPerKg == null ? '—' : rate(now.materialCostPerKg)} stamp={`${change(now.materialCostPerKg, before.materialCostPerKg)} Labour and overheads not in SAP`} />
      <Kpi
        chip="MGN"
        tone={now.marginPerKg != null && now.marginPerKg < 0 ? 'coral' : 'ink'}
        label="Material margin per kg sold"
        value={now.marginPerKg == null ? '—' : rate(now.marginPerKg)}
        stamp={`${now.marginPct == null ? '' : `${now.marginPct.toFixed(1)}% of ${inrShort(now.revenue)} invoiced. `}${change(now.marginPerKg, before.marginPerKg)}`}
      />
    </KpiStrip>
  )
}

export default async function CostingPage({ searchParams }: { searchParams: SearchParams }) {
  const { user } = await api<{ user: Me }>('/api/auth/me')
  if (!canOpen(user.role, PATH)) forbidden()
  const params = await searchParams
  const tab = oneOf(first(params.tab), COSTING_TABS, 'skus')
  const query: Query = { tab, month: first(params.month), span: first(params.span), q: first(params.q), page: first(params.page) }
  const meta = await getMeta()
  if (!meta.dataAsOf) {
    return (
      <>
        <DataAsOf meta={meta} />
        <NotImported what="Production costs and margins" />
      </>
    )
  }
  const data = await api<CostingResponse>(hrefFor('/api/costing', query))
  const period = data.from === data.to ? monthLabel(data.to) : `${monthLabel(data.from)} to ${monthLabel(data.to)}`
  const mixMonths = [...new Set(data.mix?.map((row) => row.month) ?? [])].sort()
  const mixRoles = [...new Set(data.mix?.map((row) => row.role) ?? [])]
  const mixValue = (role: string, month: string) => data.mix?.find((row) => row.role === role && row.month === month)
  const roleTotal = (role: string) => data.mix?.filter((row) => row.role === role).reduce((sum, row) => sum + row.netValue, 0) ?? 0
  mixRoles.sort((a, b) => roleTotal(b) - roleTotal(a))

  return (
    <>
      <DataAsOf meta={meta} />
      <div className="notices">
        <div className="notice">
          <p>
            <b>Material cost only.</b> {data.note} Margins here are invoice value before GST less the material cost of what was sold; they are
            not profit.
          </p>
        </div>
      </div>
      <Kpis kpis={data.kpis} asOf={data.asOf} />
      <div className="toolbar">
        <Tabs label="Costing views" options={TAB_OPTIONS} active={tab} param="tab" path={PATH} query={query} reset={{ q: undefined }} />
      </div>

      {(tab === 'skus' || tab === 'customers') && data.margins ? (
        <section className="sec" aria-labelledby="margin-head">
          <SectionHead
            id="margin-head"
            title={tab === 'skus' ? `Material margin by SKU, ${period}` : `Material margin by customer, ${period}`}
            sub={`${num(data.margins.count)} ${tab === 'skus' ? 'SKUs' : 'customers'} invoiced. Material cost per piece is what SAP valued that SKU's production at in these months; a SKU not made in them uses SAP's cost of goods sold at invoice. Credit notes are not netted.`}
            zid="Zone 1 · Margin"
          />
          <div className="toolbar">
            <PeriodForm query={query} data={data} />
            <SearchBox path={PATH} query={query} label="Search SKUs or customers" placeholder="SKU, product or customer" />
          </div>
          <DataTable
            caption="Material margin"
            columns={marginColumns(tab === 'skus' ? 'sku' : 'customer')}
            rows={data.margins.rows}
            rowKey={(row) => row.key}
            empty={<p>Nothing invoiced in {period}.</p>}
            total={{
              qty: num(data.margins.totals.qty),
              kg: num(data.margins.totals.kg),
              revenue: inr(data.margins.totals.revenue),
              materialCost: inr(data.margins.totals.materialCost),
              margin: inr(data.margins.totals.margin),
              marginPerKg: perPc(data.margins.totals.marginPerKg),
              marginPct: data.margins.totals.marginPct == null ? '—' : `${data.margins.totals.marginPct.toFixed(1)}%`,
            }}
          />
        </section>
      ) : null}

      {tab === 'orders' && data.orders ? (
        <section className="sec" aria-labelledby="orders-head">
          <SectionHead
            id="orders-head"
            title={`Production orders, ${period}`}
            sub={`${num(data.orders.totals.orders)} finished-goods orders with output in the period: ${num(data.orders.totals.producedQty)} pieces, ${num(data.orders.totals.producedKg)} kg, ${inr(data.orders.totals.materialCost)} of material${data.orders.totals.costPerKg != null ? ` (${rate(data.orders.totals.costPerKg)} a kg)` : ''}. Material cost = issued less returned to stock; SAP posts no labour or overheads to them.`}
            zid="Zone 2 · Orders"
          />
          <div className="toolbar">
            <PeriodForm query={query} data={data} />
            <SearchBox path={PATH} query={query} label="Search production orders" placeholder="PR number, item or customer" />
          </div>
          <DataTable caption="Production order costs" columns={orderColumns} rows={data.orders.rows} rowKey={(row) => row.docEntry} empty={<p>No finished-goods output in {period}.</p>} />
          <Pager page={pageOf(query.page)} pageSize={data.orders.pageSize} total={data.orders.total} path={PATH} query={query} noun="orders" />
        </section>
      ) : null}

      {tab === 'mix' && data.mix ? (
        <section className="sec" aria-labelledby="mix-head">
          <SectionHead
            id="mix-head"
            title="Material into production, by month"
            sub="Goods issued to production orders, less material returned from them, at SAP's stock price. SAP issues labour, power and water as quantities at ₹0, so they show no value."
            zid="Zone 3 · Mix"
          />
          <div className="toolbar">
            <PeriodForm query={query} data={data} />
          </div>
          {mixRoles.length ? (
            <div className="tblwrap">
              <table className="dt" style={{ minWidth: Math.max(560, (mixMonths.length + 2) * 110) }}>
                <caption className="sr">Material mix by month</caption>
                <thead>
                  <tr>
                    <th scope="col">Material</th>
                    {mixMonths.map((month) => (
                      <th key={month} scope="col" className="r">
                        {monthLabel(month)}
                      </th>
                    ))}
                    <th scope="col" className="r">
                      Share
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {mixRoles.map((role) => {
                    const all = mixRoles.reduce((sum, name) => sum + roleTotal(name), 0)
                    return (
                      <tr key={role}>
                        <td>
                          <b>{ROLE_LABELS[role] ?? role}</b>
                        </td>
                        {mixMonths.map((month) => {
                          const cell = mixValue(role, month)
                          return (
                            <td key={month} className="r num">
                              {cell ? (role === 'overhead' ? qty(cell.issuedQty) : inrShort(cell.netValue)) : '—'}
                              {cell?.issuedKg && role !== 'overhead' ? <div className="sub">{num(cell.issuedKg)} kg</div> : null}
                            </td>
                          )
                        })}
                        <td className="r num">{all && role !== 'overhead' ? `${((roleTotal(role) / all) * 100).toFixed(0)}%` : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total</td>
                    {mixMonths.map((month) => (
                      <td key={month} className="r num">
                        {inrShort(data.mix!.filter((row) => row.month === month).reduce((sum, row) => sum + row.netValue, 0))}
                      </td>
                    ))}
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <div className="card empty">
              <p>No material issued to production in these months.</p>
            </div>
          )}
        </section>
      ) : null}

      {tab === 'valuation' && data.valuation ? (
        <section className="sec" aria-labelledby="valuation-head">
          <SectionHead
            id="valuation-head"
            title={`Stock value ${inr(data.valuation.total)}`}
            sub={`From SAP's valuation layers, as of ${day(data.asOf)}. The GL inventory accounts hold ${inr(data.valuation.glInventory)} (difference ${inr(data.valuation.glInventory - data.valuation.total)}); work in progress on the GL ${inr(data.valuation.wipBalance)}.`}
            zid="Zone 4 · Valuation"
          />
          <DataTable caption="Stock valuation" columns={valuationColumns} rows={data.valuation.rows} rowKey={(row) => `${row.groupName}-${row.whsCode}-${row.method}`} total={{ value: inr(data.valuation.total) }} />
        </section>
      ) : null}

      <section className="sec" aria-labelledby="wip-head">
        <SectionHead
          id="wip-head"
          title={`SAP WIP variance: ${inr(data.wip.balance)} to date`}
          sub={`${data.wip.account ?? 'The WIP variance account'}: what production orders closed at against what was issued to them, by month (12 months to ${monthLabel(data.month)}). A large balance means SAP's production values do not tie out; it is not a cost of production.`}
          zid="Zone 5 · Variance"
        />
        <DataTable
          caption="WIP variance by month"
          columns={[
            { key: 'month', label: 'Month', render: (row) => monthLabel(row.month) },
            { key: 'debit', label: 'Debits', num: true, render: (row) => inr(row.debit) },
            { key: 'credit', label: 'Credits', num: true, render: (row) => inr(row.credit) },
            { key: 'net', label: 'Net', num: true, render: (row) => inr(row.net), tone: (row) => (row.net < 0 ? 'neg' : undefined) },
          ]}
          rows={data.wip.rows}
          rowKey={(row) => row.month}
          empty={<p>No WIP variance postings in these months.</p>}
        />
      </section>
    </>
  )
}
