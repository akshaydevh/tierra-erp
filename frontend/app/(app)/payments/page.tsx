import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DataAsOf, NotImported } from '@/components/data-as-of'
import { DataTable, type Column } from '@/components/data-table'
import { Kpi, KpiStrip } from '@/components/kpi'
import { Pager } from '@/components/pager'
import { SearchBox } from '@/components/search-box'
import { SectionHead } from '@/components/section-head'
import { FilterChips, Tabs } from '@/components/tabs'
import { api, getMeta } from '@/lib/api'
import { day, dayShort, dayTime, inr, inrShort, isIsoDay, num } from '@/lib/format'
import { canOpen } from '@/lib/nav'
import { first, hrefFor, oneOf, pageOf, type Query, type SearchParams } from '@/lib/query'
import {
  AGE_BUCKETS,
  PAYMENT_TABS,
  type AgeBucket,
  type AgeingGroup,
  type BankBookRow,
  type CardBalance,
  type Me,
  type PaymentRequestRow,
  type PaymentRow,
  type PaymentsResponse,
  type PurposeRow,
} from '@/lib/types'

const PATH = '/payments'

const TAB_OPTIONS = [
  { key: 'bank', label: 'Bank book' },
  { key: 'receipts', label: 'Receipts' },
  { key: 'purposes', label: 'Payments by purpose' },
  { key: 'receivables', label: 'Receivables ageing' },
  { key: 'payables', label: 'Payables' },
  { key: 'approvals', label: 'Awaiting approval' },
]

const BUCKET_LABELS: Record<AgeBucket, string> = {
  not_due: 'Not due',
  '1_30': '1–30',
  '31_60': '31–60',
  '61_90': '61–90',
  '91_180': '91–180',
  over_180: 'Over 180',
}

const money = (n: number) => (n ? inr(n, 2) : '')

const bankColumns: Column<BankBookRow>[] = [
  { key: 'refDate', label: 'Date', nowrap: true, render: (row) => dayShort(row.refDate) },
  {
    key: 'label',
    label: 'Particulars',
    render: (row) => (
      <>
        {row.label}
        {row.paymentCancelled ? <span className="pill grey"> cancelled</span> : null}
      </>
    ),
    sub: (row) => row.paymentMemo ?? row.memo ?? undefined,
  },
  {
    key: 'ref',
    label: 'Voucher',
    nowrap: true,
    render: (row) => (row.transType === '24' ? `RT ${row.sourceNo}` : row.transType === '46' ? `PA ${row.sourceNo}` : `JE ${row.transId}`),
  },
  { key: 'debit', label: 'In', num: true, render: (row) => money(row.debit) },
  { key: 'credit', label: 'Out', num: true, render: (row) => money(row.credit) },
  { key: 'balance', label: 'Balance', num: true, render: (row) => inr(row.balance, 2), tone: (row) => (row.balance < 0 ? 'neg' : undefined) },
]

function paymentColumns(direction: 'in' | 'out'): Column<PaymentRow>[] {
  return [
    { key: 'docNo', label: direction === 'in' ? 'Receipt' : 'Payment', nowrap: true, sub: (row) => day(row.docDate) },
    {
      key: 'party',
      label: direction === 'in' ? 'From' : 'To',
      render: (row) => (row.transfer ? `Transfer ⇄ ${row.purposeName ?? ''}` : (row.cardName ?? row.purposeName ?? '—')),
      sub: (row) => (row.kind === 'account' && !row.transfer ? 'Account payment' : row.cardCode ?? undefined),
    },
    { key: 'bank', label: 'Bank' },
    { key: 'amount', label: 'Amount', num: true, render: (row) => inr(row.amount, 2) },
    ...(direction === 'in'
      ? [{ key: 'onAccount', label: 'On account', num: true, render: (row: PaymentRow) => (row.onAccount ? inr(row.onAccount, 2) : '—') } as Column<PaymentRow>]
      : []),
    { key: 'memo', label: 'Memo', render: (row) => row.memo ?? '—' },
  ]
}

const purposeColumns = (query: Query): Column<PurposeRow>[] => [
  {
    key: 'label',
    label: 'Paid for',
    render: (row) => (
      <Link href={hrefFor(PATH, query, { purpose: row.key, page: undefined })}>
        <b>{row.label}</b>
      </Link>
    ),
  },
  { key: 'count', label: 'Payments', num: true, render: (row) => num(row.count) },
  { key: 'amount', label: 'Amount', num: true, render: (row) => inr(row.amount) },
]

function ageingColumns(query: Query, side: 'receivable' | 'payable'): Column<AgeingGroup>[] {
  return [
    {
      key: 'name',
      label: side === 'receivable' ? 'Customer (company)' : 'Supplier (company)',
      render: (row) => (
        <Link href={hrefFor(PATH, query, { group: row.groupKey })}>
          <b>{row.name}</b>
        </Link>
      ),
      sub: (row) => `${row.pan ? `PAN ${row.pan} · ` : ''}${num(row.cards)} ${row.cards === 1 ? 'card' : 'cards'}`,
    },
    {
      key: 'net',
      label: side === 'receivable' ? 'Owes us' : 'We owe',
      num: true,
      render: (row) => inr(row.net),
      tone: (row) => (row.net < 0 ? 'neg' : undefined),
      sub: (row) => (row.net < 0 ? 'advance' : undefined),
    },
    ...AGE_BUCKETS.map(
      (bucket): Column<AgeingGroup> => ({
        key: bucket,
        label: BUCKET_LABELS[bucket],
        num: true,
        render: (row) => (row.buckets[bucket] ? inrShort(row.buckets[bucket]) : '—'),
        tone: (row) => (bucket === 'over_180' && row.buckets[bucket] > 0 ? 'warn' : undefined),
      }),
    ),
  ]
}

const cardColumns: Column<CardBalance>[] = [
  { key: 'cardName', label: 'Card', sub: (row) => row.cardCode },
  { key: 'owed', label: 'Balance', num: true, render: (row) => inr(row.owed), tone: (row) => (row.owed < 0 ? 'neg' : undefined) },
  ...AGE_BUCKETS.map(
    (bucket): Column<CardBalance> => ({
      key: bucket,
      label: BUCKET_LABELS[bucket],
      num: true,
      render: (row) => (row.buckets[bucket] ? inrShort(row.buckets[bucket]) : '—'),
    }),
  ),
  { key: 'lastMoved', label: 'Last entry', nowrap: true, render: (row) => day(row.lastMoved) },
]

const requestColumns: Column<PaymentRequestRow>[] = [
  { key: 'requestedAt', label: 'Raised', nowrap: true, render: (row) => dayTime(row.requestedAt), sub: (row) => row.originator ?? undefined },
  { key: 'party', label: 'Payee / purpose', render: (row) => row.cardName ?? row.purposeName ?? '—', sub: (row) => row.memo ?? undefined },
  { key: 'bank', label: 'Bank' },
  { key: 'amount', label: 'Amount', num: true, render: (row) => inr(row.amount) },
  {
    key: 'decided',
    label: 'Decided',
    nowrap: true,
    render: (row) => (row.decidedAt ? dayTime(row.decidedAt) : '—'),
    sub: (row) => row.approver ?? undefined,
  },
]

function RangeForm({ query, banks, data }: { query: Query; banks?: PaymentsResponse['accounts']; data: PaymentsResponse }) {
  return (
    <form className="daypick" action={PATH} method="get">
      <input type="hidden" name="tab" value={query.tab ?? 'bank'} />
      {banks ? (
        <>
          <label htmlFor="pay-bank">Account</label>
          <select id="pay-bank" name="bank" defaultValue={data.bank?.account.glCode}>
            {banks.map((account) => (
              <option key={account.glCode} value={account.glCode}>
                {account.shortName}
                {account.active ? '' : ' (closed)'}
              </option>
            ))}
          </select>
        </>
      ) : null}
      <label htmlFor="pay-from">From</label>
      <input id="pay-from" type="date" name="from" defaultValue={data.from} max={data.asOf} />
      <label htmlFor="pay-to">To</label>
      <input id="pay-to" type="date" name="to" defaultValue={data.to} max={data.asOf} />
      <button type="submit" className="btn-sec">
        Show
      </button>
    </form>
  )
}

export default async function PaymentsPage({ searchParams }: { searchParams: SearchParams }) {
  const { user } = await api<{ user: Me }>('/api/auth/me')
  if (!canOpen(user.role, PATH)) notFound()
  const params = await searchParams
  const tab = oneOf(first(params.tab), PAYMENT_TABS, 'bank')
  const from = isIsoDay(first(params.from)) ? first(params.from) : undefined
  const to = isIsoDay(first(params.to)) ? first(params.to) : undefined
  const query: Query = {
    tab,
    from,
    to,
    bank: first(params.bank),
    q: first(params.q),
    purpose: first(params.purpose),
    group: first(params.group),
    status: first(params.status),
    page: first(params.page),
  }
  const meta = await getMeta()
  if (!meta.dataAsOf) {
    return (
      <>
        <DataAsOf meta={meta} />
        <NotImported what="Bank balances, payments and receivables" />
      </>
    )
  }
  const data = await api<PaymentsResponse>(hrefFor('/api/payments', query))
  const { kpis } = data
  const page = pageOf(query.page)
  const bankStamp = kpis.banks.map((bank) => `${bank.bank} ${inr(bank.balance)}`).join(' · ')

  return (
    <>
      <DataAsOf meta={meta} />
      <KpiStrip label="Money">
        <Kpi chip="₹" label={`Cash across ${num(kpis.banks.length)} banks`} value={inrShort(kpis.cash)} stamp={bankStamp} />
        <Kpi chip="IN" tone="leaf" label="Receipts this month" value={inrShort(kpis.receiptsMtd)} stamp={`To ${day(kpis.asOf)}, transfers left out`} />
        <Kpi chip="OUT" tone="amber" label="Payments this month" value={inrShort(kpis.paymentsMtd)} stamp={`To ${day(kpis.asOf)}, transfers left out`} />
        <Kpi
          chip="APR"
          tone={kpis.pendingApprovals.count ? 'coral' : 'ink'}
          label="Awaiting approval in SAP"
          value={inrShort(kpis.pendingApprovals.amount)}
          stamp={`${num(kpis.pendingApprovals.count)} payments${kpis.pendingApprovals.oldest ? ` · oldest ${day(kpis.pendingApprovals.oldest)}` : ''}`}
          attn={kpis.pendingApprovals.count > 0}
          href={hrefFor(PATH, { tab: 'approvals' })}
        />
      </KpiStrip>
      <div className="toolbar">
        <Tabs label="Payment views" options={TAB_OPTIONS} active={tab} param="tab" path={PATH} query={query} reset={{ group: undefined, purpose: undefined, q: undefined, status: undefined }} />
      </div>

      {tab === 'bank' && data.bank ? (
        <section className="sec" aria-labelledby="bank-head">
          <SectionHead
            id="bank-head"
            title={`${data.bank.account.shortName} bank book`}
            sub={`${day(data.from)} to ${day(data.to)} · opening ${inr(data.bank.opening, 2)} · in ${inr(data.bank.receipts, 2)} · out ${inr(data.bank.payments, 2)} · closing ${inr(data.bank.closing, 2)}. Lines by SAP posting date.`}
            zid="Zone 1 · Bank"
          />
          <div className="toolbar">
            <RangeForm query={query} banks={data.accounts} data={data} />
          </div>
          <DataTable
            caption={`${data.bank.account.shortName} lines`}
            columns={bankColumns}
            rows={data.bank.rows}
            rowKey={(row) => `${row.transId}-${row.lineId}`}
            empty={<p>No lines on {data.bank.account.shortName} in this range.</p>}
          />
          <Pager page={page} pageSize={data.bank.pageSize} total={data.bank.total} path={PATH} query={query} noun="lines" />
        </section>
      ) : null}

      {tab === 'receipts' && data.list ? (
        <section className="sec" aria-labelledby="receipts-head">
          <SectionHead
            id="receipts-head"
            title="Receipts"
            sub={`${num(data.list.total)} receipts, ${inr(data.list.amount)} from ${day(data.from)} to ${day(data.to)}. Most customer receipts are booked on account in SAP, not against invoices.`}
            zid="Zone 2 · Receipts"
          />
          <div className="toolbar">
            <RangeForm query={query} data={data} />
            <SearchBox path={PATH} query={query} label="Search receipts" placeholder="Party, memo or number" />
          </div>
          <DataTable caption="Receipts" columns={paymentColumns('in')} rows={data.list.rows} rowKey={(row) => row.docEntry} empty={<p>No receipts in this range.</p>} />
          <Pager page={page} pageSize={data.list.pageSize} total={data.list.total} path={PATH} query={query} noun="receipts" />
        </section>
      ) : null}

      {tab === 'purposes' && data.purposes ? (
        <section className="sec" aria-labelledby="purposes-head">
          <SectionHead
            id="purposes-head"
            title="Payments by purpose"
            sub={`${inr(data.purposes.total)} paid out from ${day(data.from)} to ${day(data.to)}: account payments by the GL account they went to (salary, GST, loans, expenses), then suppliers and refunds.`}
            zid="Zone 3 · Purpose"
          />
          <div className="toolbar">
            <RangeForm query={query} data={data} />
          </div>
          <DataTable
            caption="Payments by purpose"
            columns={purposeColumns(query)}
            rows={data.purposes.rows}
            rowKey={(row) => row.key}
            empty={<p>No payments in this range.</p>}
            total={{ amount: inr(data.purposes.total) }}
          />
          {data.list ? (
            <>
              <SectionHead title={data.purposes.rows.find((row) => row.key === data.purpose)?.label ?? 'Payments'} sub={`${num(data.list.total)} payments, ${inr(data.list.amount)}`} />
              <DataTable caption="Payments for this purpose" columns={paymentColumns('out')} rows={data.list.rows} rowKey={(row) => row.docEntry} />
              <Pager page={page} pageSize={data.list.pageSize} total={data.list.total} path={PATH} query={query} noun="payments" />
            </>
          ) : null}
        </section>
      ) : null}

      {(tab === 'receivables' || tab === 'payables') && data.ageing ? (
        <section className="sec" aria-labelledby="ageing-head">
          <SectionHead
            id="ageing-head"
            title={tab === 'receivables' ? `Receivables: ${inr(kpis.netReceivable)} net` : `Payables: ${inr(kpis.netPayable)} net`}
            sub={`Ageing as of ${day(data.asOf)}, netted per company (all branch cards with one PAN), oldest documents counted as paid first. ${
              data.topCards?.length ? `Largest single card: ${data.topCards[0]!.cardName} ${inrShort(data.topCards[0]!.owed)}.` : ''
            }`}
            zid={tab === 'receivables' ? 'Zone 4 · Receivables' : 'Zone 5 · Payables'}
          />
          {data.cards ? (
            <>
              <SectionHead
                title={data.ageing.rows.find((row) => row.groupKey === data.group)?.name ?? 'Cards'}
                sub="Each card's ledger balance and its share of the company's open documents."
                actions={
                  <Link className="btn-sec" href={hrefFor(PATH, query, { group: undefined })}>
                    All companies
                  </Link>
                }
              />
              <DataTable caption="Cards of this company" columns={cardColumns} rows={data.cards} rowKey={(row) => row.cardCode} />
            </>
          ) : null}
          <DataTable
            caption={tab === 'receivables' ? 'Receivables by company' : 'Payables by company'}
            columns={ageingColumns(query, tab === 'receivables' ? 'receivable' : 'payable')}
            rows={data.ageing.rows}
            rowKey={(row) => row.groupKey}
            total={{
              net: inr(data.ageing.totals.net),
              ...Object.fromEntries(AGE_BUCKETS.map((bucket) => [bucket, inrShort(data.ageing!.totals[bucket])])),
            }}
          />
          {data.topCards?.length ? (
            <>
              <SectionHead title="Largest balances by card" sub="Before netting branches: receipts often land on one branch card while its invoices sit on another." />
              <DataTable caption="Largest balances by card" columns={cardColumns} rows={data.topCards} rowKey={(row) => row.cardCode} />
            </>
          ) : null}
        </section>
      ) : null}

      {tab === 'approvals' && data.requests ? (
        <section className="sec" aria-labelledby="approvals-head">
          <SectionHead
            id="approvals-head"
            title="Outgoing payments through SAP approval"
            sub={`${num(data.requests.total)} ${data.status ?? 'pending'}, ${inr(data.requests.amount)}. Approve them in SAP.`}
            zid="Zone 6 · Approval"
          />
          <FilterChips
            label="Approval status"
            options={[
              { key: 'pending', label: 'Waiting' },
              { key: 'approved', label: 'Approved' },
              { key: 'rejected', label: 'Rejected' },
            ]}
            active={data.status ?? 'pending'}
            param="status"
            path={PATH}
            query={query}
          />
          <DataTable caption="Payment approvals" columns={requestColumns} rows={data.requests.rows} rowKey={(row) => row.requestId} empty={<p>Nothing here.</p>} />
          <Pager page={page} pageSize={data.requests.pageSize} total={data.requests.total} path={PATH} query={query} noun="requests" />
        </section>
      ) : null}
    </>
  )
}
