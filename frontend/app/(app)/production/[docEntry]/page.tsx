import Link from 'next/link'
import { DataTable, type Column } from '@/components/data-table'
import { DetailFrame, Facts, Milestones, type Milestone } from '@/components/detail-frame'
import { SectionHead } from '@/components/section-head'
import { StatusPill } from '@/components/status-pill'
import { apiOr404 } from '@/lib/api'
import { day, inr, num, qty } from '@/lib/format'
import { materialRoleLabel, type ProductionComponent, type ProductionOrderResponse, type ProductionRow } from '@/lib/types'

const ISSUE_METHODS: Record<string, string> = { B: 'Backflush', M: 'Manual' }

function issueMethod(code: string | null): string {
  if (!code) return '—'
  return ISSUE_METHODS[code] ?? code
}

function variance(component: ProductionComponent): number {
  return component.issuedQty - component.plannedQty
}

function componentColumns(withValue: boolean): Column<ProductionComponent>[] {
  const columns: Column<ProductionComponent>[] = [
    { key: 'itemCode', label: 'Component', sub: (row) => row.itemName },
    {
      key: 'materialRole',
      label: 'Role',
      render: (row) => materialRoleLabel(row.materialRole),
      sub: (row) => (row.issueMethod ? `${issueMethod(row.issueMethod)} issue` : undefined),
    },
    { key: 'plannedQty', label: 'Planned', num: true, render: (row) => qty(row.plannedQty, row.uom) },
    {
      key: 'issuedQty',
      label: 'Issued',
      num: true,
      render: (row) => qty(row.issuedQty, row.uom),
      tone: (row) => (row.issuedQty < 0 ? 'neg' : undefined),
    },
    {
      key: 'variance',
      label: 'Over / under',
      num: true,
      render: (row) => {
        const diff = variance(row)
        return diff === 0 ? '0' : `${diff > 0 ? '+' : ''}${qty(diff)}`
      },
      tone: (row) => (variance(row) > 0 ? 'warn' : undefined),
    },
  ]
  if (withValue) columns.push({ key: 'issuedValue', label: 'Issued ₹', num: true, render: (row) => inr(row.issuedValue) })
  return columns
}

function historySteps(order: ProductionRow): Milestone[] {
  const steps: Milestone[] = [{ key: 'posted', title: 'Work order posted', when: day(order.postDate) }]
  if (order.startDate) steps.push({ key: 'start', title: 'Start date', when: day(order.startDate) })
  if (order.status === 'closed') steps.push({ key: 'closed', title: 'Closed', when: day(order.closeDate) })
  else if (order.status === 'cancelled') steps.push({ key: 'cancelled', title: 'Cancelled', when: day(order.closeDate) })
  else steps.push({ key: 'due', title: order.status === 'planned' ? 'Planned, not released' : 'Released, due', when: day(order.dueDate), waiting: true })
  return steps
}

export default async function ProductionOrderPage({ params }: { params: Promise<{ docEntry: string }> }) {
  const { docEntry } = await params
  const { order, components } = await apiOr404<ProductionOrderResponse>(`/api/production/${encodeURIComponent(docEntry)}`)
  const withValue = components.some((row) => row.issuedValue !== undefined && row.issuedValue !== null)
  const issuedTotal = components.reduce((sum, row) => sum + (row.issuedValue ?? 0), 0)

  return (
    <DetailFrame rail={<Milestones title="History" items={historySteps(order)} empty="" />}>
      <section className="sec" aria-labelledby="wo-head">
        <SectionHead
          id="wo-head"
          title={order.docNo}
          sub={`${order.itemCode} · ${order.itemName}`}
          actions={
            <span className="pills">
              <StatusPill status={order.type} />
              <StatusPill status={order.status} />
            </span>
          }
        />
        <Facts
          label="Work order details"
          items={[
            { label: 'Customer', value: order.customerName ?? '—' },
            { label: 'Planned', value: <span className="num">{qty(order.plannedQty)}</span> },
            { label: 'Completed', value: <span className="num">{qty(order.completedQty)}</span> },
            { label: 'Posted', value: day(order.postDate) },
            { label: 'Due', value: day(order.dueDate) },
            { label: 'Closed', value: day(order.closeDate) },
            { label: 'Material issued', value: <span className="num">{inr(order.issuedValue)}</span> },
            { label: 'Goods received', value: <span className="num">{inr(order.receivedValue)}</span> },
            { label: 'Stock type', value: order.stockType ?? '—' },
          ]}
        />
        {order.comments ? <p className="note">{order.comments}</p> : null}
      </section>
      <section className="sec" aria-labelledby="comp-head">
        <SectionHead
          id="comp-head"
          title="Against the recipe"
          sub={`${num(components.length)} components. Planned is what the bill of materials asked for; issued is what left the store.`}
        />
        <DataTable
          caption={`Components of ${order.docNo}, planned against issued`}
          columns={componentColumns(withValue)}
          rows={components}
          rowKey={(row) => row.lineNum}
          empty={<p>No components on this work order.</p>}
          total={withValue ? { issuedValue: inr(issuedTotal) } : undefined}
        />
      </section>
      <p>
        <Link className="backlink" href="/production">
          All work orders
        </Link>
      </p>
    </DetailFrame>
  )
}
