import Link from 'next/link'
import { DataTable, type Column } from '@/components/data-table'
import { DetailFrame, Facts, Milestones, type Milestone } from '@/components/detail-frame'
import { SectionHead } from '@/components/section-head'
import { StatusPill } from '@/components/status-pill'
import { apiOr404 } from '@/lib/api'
import { day, dayTime, inr, num, qty } from '@/lib/format'
import type { CheckLine, CustomerPoLine, CustomerPoResponse, RepeatHit } from '@/lib/types'
import { PoReview } from './po-review'

const MATCH_LABEL: Record<string, string> = {
  article: 'Article ref',
  ean: 'EAN ref',
  history: 'Earlier orders',
  name: 'Name only — confirm',
  manual: 'Set by hand',
}

const PCS_LABEL: Record<string, string> = {
  ea: 'EA row on the PO',
  ref: 'customer ref',
  npu: 'pcs per carton in SAP',
  pcs: 'ordered in pieces',
}

const ROLE_LABEL: Record<string, string> = {
  fg: 'Finished good',
  laminate: 'Laminate',
  carton: 'Carton',
  seasoning: 'Seasoning',
  raw_banana: 'Banana',
  raw_cassava: 'Cassava',
  oil: 'Oil',
  tape: 'Tape',
  consumable: 'Consumable',
}

const lineColumns: Column<CustomerPoLine>[] = [
  { key: 'lineNo', label: '#', num: true },
  {
    key: 'articleNo',
    label: 'Customer article',
    sub: (line) => [line.description, line.ean ? `EAN ${line.ean}` : null].filter(Boolean).join(' · '),
  },
  {
    key: 'qty',
    label: 'Ordered',
    num: true,
    render: (line) => `${qty(line.qty)} ${line.uom ?? ''}`.trim(),
    sub: (line) => (line.eaQty ? `${qty(line.eaQty)} EA` : undefined),
  },
  {
    key: 'itemCode',
    label: 'Tierra item',
    render: (line) => line.itemCode ?? <span className="neg">Not matched</span>,
    sub: (line) =>
      [line.itemName, line.matchMethod ? MATCH_LABEL[line.matchMethod] : null, line.note].filter(Boolean).join(' · ') || undefined,
    tone: (line) => (line.itemCode && !line.matchConfirmed ? 'warn' : undefined),
  },
  {
    key: 'pcs',
    label: 'Pieces',
    num: true,
    render: (line) => qty(line.pcs),
    sub: (line) => (line.pcsSource ? `from ${PCS_LABEL[line.pcsSource]}` : undefined),
  },
  { key: 'unitPrice', label: 'Per piece', num: true, render: (line) => (line.unitPrice !== null ? `₹${line.unitPrice.toFixed(4)}` : '—') },
  {
    key: 'lineTotal',
    label: 'Base value',
    num: true,
    render: (line) => inr(line.lineTotal, 2),
    sub: (line) => (line.gstPct !== null ? `GST ${num(line.gstPct, 2)}% · HSN ${line.hsn ?? '—'}` : undefined),
  },
]

function amount(value: number, uom: string | null): string {
  return qty(value, uom)
}

const checkColumns: Column<CheckLine>[] = [
  {
    key: 'itemCode',
    label: 'Item',
    sub: (line) =>
      [ROLE_LABEL[line.role ?? ''] ?? line.role, line.itemName, line.estimated ? 'estimated' : null, line.checked ? null : 'warning only']
        .filter(Boolean)
        .join(' · '),
  },
  {
    key: 'need',
    label: 'Need',
    num: true,
    render: (line) => amount(line.need, line.uom),
    sub: (line) =>
      line.kind === 'fg'
        ? `${qty(line.fromStock)} from stock · make ${qty(line.toMake)}`
        : line.forItems.length
          ? `for ${line.forItems.join(', ')}`
          : undefined,
  },
  {
    key: 'free',
    label: 'Free',
    num: true,
    render: (line) => qty(line.free),
    sub: (line) => `${qty(line.onHand)} on hand − ${qty(line.committed)} committed${line.reserved ? ` − ${qty(line.reserved)} reserved` : ''}`,
    tone: (line) => (line.free < 0 ? 'neg' : undefined),
  },
  {
    key: 'onOrder',
    label: 'On order',
    num: true,
    render: (line) => qty(line.onOrder),
    sub: (line) => (line.incoming.length ? line.incoming.join(', ') : undefined),
  },
  {
    key: 'shortNow',
    label: 'Short now',
    num: true,
    render: (line) => (line.shortNow > 0 ? qty(line.shortNow) : '—'),
    tone: (line) => (line.shortNow > 0 ? 'warn' : undefined),
  },
  {
    key: 'shortAfterIncoming',
    label: 'Short after incoming',
    num: true,
    render: (line) => (line.shortAfterIncoming > 0 ? qty(line.shortAfterIncoming) : '—'),
    tone: (line) => (line.shortAfterIncoming > 0 ? 'neg' : undefined),
  },
  {
    key: 'owner',
    label: 'Owner',
    render: (line) =>
      line.owner === 'customer' ? (line.ownerName ?? line.ownerCardCode) : line.owner === 'customer_unknown' ? 'Customer (unknown)' : line.owner ? 'Tierra' : '—',
  },
  { key: 'status', label: 'Result', render: (line) => <StatusPill status={line.status} /> },
]

function repeatText(hit: RepeatHit): string {
  if (hit.source === 'sap') {
    return `SAP ${hit.docNo} of ${day(hit.docDate)}${hit.invoices.length ? `, invoiced ${hit.invoices.join(', ')}` : ''} (${hit.status})`
  }
  return `${hit.docNo}, received ${day(hit.docDate)} (${hit.status.replace(/_/g, ' ')})`
}

function sourceText(chat: string | null, sender: string | null, raisedBy: string | null): string {
  if (!chat) return sender ? `From ${sender}` : 'Source not recorded'
  if (chat.startsWith('desk:')) return `Agent desk, from ${sender ?? 'someone'}`
  if (chat.endsWith('@g.us')) return `WhatsApp group, from ${sender ?? 'someone'}`
  return raisedBy ? `WhatsApp DM from ${sender ?? 'a Tierra account'}` : `WhatsApp DM from an unknown number ${sender ?? ''}`.trim()
}

export default async function CustomerPoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { po, cardName, check, document, tasks, salesOrder } = await apiOr404<CustomerPoResponse>(`/api/customer-pos/${encodeURIComponent(id)}`)
  const salesOrders = salesOrder ? [salesOrder] : []
  const resolution = po.resolution
  const fg = check?.lines.filter((line) => line.kind === 'fg') ?? []
  const components = check?.lines.filter((line) => line.kind === 'component') ?? []

  const history: Milestone[] = [
    { key: 'received', title: 'Received', note: sourceText(po.sourceChat, po.sourceSender, po.raisedBy), when: dayTime(po.createdAt) },
    ...(check ? [{ key: 'check', title: <>Checked: <StatusPill status={check.verdict} /></>, note: check.dataAsOf ? `SAP data as of ${day(check.dataAsOf)}` : undefined, when: dayTime(check.createdAt) }] : []),
    {
      key: 'status',
      title: <StatusPill status={po.status} />,
      note:
        po.status === 'awaiting_proceed'
          ? 'Waiting for the admin to reply *proceed*'
          : po.status === 'checked' && !salesOrders.length
            ? 'Next: the Tierra sales order'
            : undefined,
      waiting: po.status === 'awaiting_proceed' || po.status === 'needs_review',
    },
    ...salesOrders.map((order) => ({
      key: `tso-${order.id}`,
      title: (
        <Link className="tasklink" href={`/orders/tso/${encodeURIComponent(order.id)}`}>
          {order.docNo}
        </Link>
      ),
      note: <StatusPill status={order.status} />,
      when: dayTime(order.createdAt),
      waiting: order.status === 'pending_approval' || order.status === 'draft',
    })),
  ]
  const taskSteps: Milestone[] = tasks.map((task) => ({
    key: task.id,
    title: task.title,
    note: `${task.assigneeName ?? 'Unassigned'} · ${task.status}`,
    when: dayTime(task.createdAt),
    waiting: task.status === 'todo' || task.status === 'doing',
  }))

  return (
    <DetailFrame
      rail={
        <>
          <Milestones title="History" items={history} empty="" />
          <Milestones title="Tasks" items={taskSteps} empty="No tasks about this PO." />
        </>
      }
    >
      <section className="sec" aria-labelledby="po-head">
        <SectionHead
          id="po-head"
          title={`PO ${po.poNo ?? '(no number)'}${po.revision > 1 ? ` · revision ${po.revision}` : ''}`}
          sub={[po.partyName ?? po.buyerName, cardName].filter(Boolean).join(' · ') || 'Customer not resolved'}
          actions={
            <span className="pills">
              <StatusPill status={po.status} />
              {check ? <StatusPill status={check.verdict} /> : null}
            </span>
          }
        />
        {po.repeatOf.length > 0 ? (
          <article className="card p6" role="note" style={{ marginBottom: 16 }}>
            <b>Repeat PO.</b> This number is already on {po.repeatOf.map(repeatText).join('; ')}.
            {po.status === 'awaiting_proceed' ? ' The admin was asked to reply *proceed* before it goes any further.' : null}
          </article>
        ) : null}
        {po.status === 'needs_review' && po.reviewReason ? (
          <article className="card p6" role="alert" style={{ marginBottom: 16 }}>
            <b>Needs review.</b> {po.reviewReason}
          </article>
        ) : null}
        {po.status === 'needs_review' ? <PoReview poId={po.id} cardCode={po.cardCode} cardName={cardName} lines={po.lines} /> : null}
        <Facts
          label="PO details"
          items={[
            { label: 'Buyer', value: po.buyerName ?? '—' },
            {
              label: 'Ship-to card',
              value: po.cardCode ? `${po.cardCode}${cardName ? ` ${cardName}` : ''}` : 'Not resolved',
            },
            {
              label: 'How it was found',
              value: resolution?.note ?? resolution?.reason ?? '—',
            },
            { label: 'Site', value: po.siteCode ?? '—' },
            { label: 'Ship-to GSTIN', value: po.shipToGstin ?? '—' },
            { label: 'PO date', value: day(po.poDate) },
            { label: 'Delivery', value: day(po.deliveryDate) },
            { label: 'Vendor code', value: po.vendorCode ?? '—' },
            { label: 'Value', value: <span className="num">{inr(po.total, 2)}</span> },
            { label: 'Of which tax', value: <span className="num">{inr(po.taxTotal, 2)}</span> },
            {
              label: 'Tierra SO',
              value: salesOrders.length
                ? salesOrders.map((order, index) => (
                    <span key={order.id}>
                      {index ? ', ' : null}
                      <Link className="tasklink" href={`/orders/tso/${encodeURIComponent(order.id)}`}>
                        {order.docNo}
                      </Link>
                    </span>
                  ))
                : 'Not raised yet',
            },
            { label: 'Read by', value: po.reader === 'z_mat_poprint' ? 'Z_MAT_POPRINT reader' : po.reader === 'llm' ? 'AI reader' : '—' },
            {
              label: 'PO PDF',
              value: document ? (
                <a href={`/api/documents/${document.id}`} target="_blank" rel="noreferrer">
                  {document.filename}
                </a>
              ) : (
                '—'
              ),
            },
          ]}
        />
        {po.shipToAddress ? <p className="note" style={{ marginTop: 12 }}>Deliver to: {po.shipToAddress}</p> : null}
      </section>

      <section className="sec" aria-labelledby="po-lines-head">
        <SectionHead id="po-lines-head" title="Lines" sub="Each customer article, the Tierra item it maps to and the pieces it means." />
        <DataTable
          caption={`Lines of PO ${po.poNo ?? ''}`}
          columns={lineColumns}
          rows={po.lines}
          rowKey={(line) => line.lineNo}
          empty={<p>No lines were read from this PO.</p>}
          total={{ lineTotal: inr(po.lines.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0), 2) }}
          totalLabel="Before tax"
        />
      </section>

      <section className="sec" aria-labelledby="po-check-head">
        <SectionHead
          id="po-check-head"
          title="Stock and materials check"
          sub="Finished stock first; what has to be made is exploded through its SAP BOM. Short now means not in free stock today; short after incoming counts open purchase orders too."
          actions={check ? <StatusPill status={check.verdict} /> : undefined}
        />
        {check ? (
          <>
            <DataTable caption="Finished goods" columns={checkColumns} rows={fg} rowKey={(line) => `fg-${line.itemCode}`} />
            <div style={{ height: 16 }} />
            <DataTable
              caption="Materials"
              columns={checkColumns}
              rows={components}
              rowKey={(line) => `c-${line.itemCode}`}
              empty={<p>Everything comes from finished stock; no materials are needed.</p>}
            />
            {check.warnings.length ? (
              <ul className="note" style={{ marginTop: 12 }}>
                {check.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <div className="card empty">
            <p>Not checked: the customer or a line still needs review.</p>
          </div>
        )}
      </section>

      {po.notes.length ? (
        <section className="sec" aria-labelledby="po-notes-head">
          <SectionHead id="po-notes-head" title="Buyer notes" />
          <article className="card p6">
            <ul className="note">
              {po.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </article>
        </section>
      ) : null}

      <p>
        <Link className="backlink" href="/orders?tab=intake">
          All received POs
        </Link>
      </p>
    </DetailFrame>
  )
}
