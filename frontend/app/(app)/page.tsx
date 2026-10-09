import { TaskBoard } from './task-board'
import { DataAsOf, NotImported } from '@/components/data-as-of'
import { Kpi, KpiStrip } from '@/components/kpi'
import { SalesOrderTable } from '@/components/sales-order-table'
import { SectionHead } from '@/components/section-head'
import { api, getMeta } from '@/lib/api'
import { day, dayShort, inrShort, num } from '@/lib/format'
import type { CommandCentre } from '@/lib/types'

function whatsappLabel(status: CommandCentre['whatsapp']['status']): string {
  if (status === 'connected') return 'Connected'
  if (status === 'qr_pending') return 'Waiting for scan'
  return 'Not connected'
}

function monthStart(iso: string): string {
  return `${iso.slice(0, 8)}01`
}

export default async function CommandCentrePage() {
  const [meta, data] = await Promise.all([getMeta(), api<CommandCentre>('/api/command-centre')])
  const asOf = data.dataAsOf ?? meta.dataAsOf
  const { kpis } = data
  return (
    <>
      <DataAsOf meta={{ ...meta, dataAsOf: asOf }}>
        WhatsApp{' '}
        <span className={data.whatsapp.status === 'connected' ? 'pill ok' : 'pill amber'}>
          {whatsappLabel(data.whatsapp.status)}
        </span>
        {data.whatsapp.phoneNumber ? <span className="num"> {data.whatsapp.phoneNumber}</span> : null}
      </DataAsOf>
      {asOf ? (
        <KpiStrip label="Today in figures">
          <Kpi
            chip="SO"
            label="Open sales orders"
            href="/orders?state=open"
            value={num(kpis.openSalesOrders)}
            stamp={kpis.staleOpenSalesOrders > 0 ? `${num(kpis.staleOpenSalesOrders)} older than 90 days` : 'None older than 90 days'}
            attn={kpis.staleOpenSalesOrders > 0}
          />
          <Kpi
            chip="₹"
            tone="leaf"
            label="Sales this month"
            value={inrShort(kpis.salesMtdValue)}
            stamp={`Including tax · ${num(kpis.salesMtdCount)} raised, ${dayShort(monthStart(asOf))} – ${dayShort(asOf)}`}
          />
          <Kpi
            chip="INV"
            label="Invoices on the last day"
            href="/dispatch"
            value={num(kpis.invoicesLastDay)}
            stamp={`Dated ${day(asOf)}`}
          />
          <Kpi
            chip="FG"
            tone={kpis.fgShortItems > 0 ? 'amber' : 'ink'}
            label="Finished goods short"
            href="/inventory?tab=fg"
            value={num(kpis.fgShortItems)}
            stamp="Items with more committed than on hand"
            attn={kpis.fgShortItems > 0}
          />
        </KpiStrip>
      ) : (
        <NotImported what="Sales, invoice and stock figures" />
      )}
      <section className="sec">
        <SectionHead
          title="Task board"
          sub="Add work, give it a category, and assign it. Drag a card to move it."
          zid="Zone 1 · Tasks"
        />
        <TaskBoard />
      </section>
      <section className="sec">
        <SectionHead title="Recent sales orders" sub="The five newest sales orders in SAP" zid="Zone 1 · Orders" />
        <SalesOrderTable
          caption="Five newest sales orders"
          rows={data.recentSalesOrders ?? []}
          empty={<p>{asOf ? 'No sales orders in SAP yet.' : 'Sales orders appear after the SAP import.'}</p>}
        />
      </section>
    </>
  )
}
