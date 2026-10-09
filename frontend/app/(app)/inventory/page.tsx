import Link from 'next/link'
import { DataAsOf, NotImported } from '@/components/data-as-of'
import { DataTable, type Column } from '@/components/data-table'
import { Kpi, KpiStrip } from '@/components/kpi'
import { Pager } from '@/components/pager'
import { SearchBox } from '@/components/search-box'
import { SectionHead } from '@/components/section-head'
import { FilterChips, Tabs, type LinkOption } from '@/components/tabs'
import { api, getMeta } from '@/lib/api'
import { num, qty } from '@/lib/format'
import { first, hrefFor, oneOf, pageOf, type Query, type SearchParams } from '@/lib/query'
import {
  INVENTORY_TABS,
  MATERIAL_ROLES,
  materialRoleLabel,
  type InventoryResponse,
  type MaterialRole,
  type StockRow,
} from '@/lib/types'

const PATH = '/inventory'

const columns: Column<StockRow>[] = [
  { key: 'itemCode', label: 'Item', nowrap: true, sub: (row) => row.itemName },
  { key: 'materialRole', label: 'Role', render: (row) => materialRoleLabel(row.materialRole) },
  { key: 'whsCode', label: 'Warehouse' },
  { key: 'onHand', label: 'On hand', num: true, render: (row) => qty(row.onHand), tone: (row) => (row.onHand < 0 ? 'neg' : undefined) },
  { key: 'committed', label: 'Committed', num: true, render: (row) => qty(row.committed) },
  {
    key: 'free',
    label: 'Free',
    num: true,
    render: (row) => qty(row.free),
    // Short against orders is amber; short with nothing on the shelf at all is coral.
    tone: (row) => (row.free >= 0 ? undefined : row.onHand <= 0 ? 'neg' : 'warn'),
  },
  { key: 'onOrder', label: 'On order', num: true, render: (row) => qty(row.onOrder) },
  {
    key: 'uom',
    label: 'UoM',
    render: (row) => row.uom ?? 'Not set',
    sub: (row) => (row.uomInferred ? 'Inferred from recipe' : undefined),
    tone: (row) => (row.uomInferred || !row.uom ? 'warn' : undefined),
  },
  {
    key: 'ownerName',
    label: 'Owner',
    render: (row) => (row.customerSupplied ? (row.ownerName ?? 'A customer') : (row.ownerName ?? 'Tierra')),
    sub: (row) => (row.customerSupplied ? 'Customer-supplied' : undefined),
  },
]

function roleOptions(counts: InventoryResponse['roleCounts'], active: MaterialRole | undefined): LinkOption[] {
  const roles = MATERIAL_ROLES.filter((role) => role !== 'fg' && ((counts[role] ?? 0) > 0 || role === active))
  const all = roles.reduce((sum, role) => sum + (counts[role] ?? 0), 0)
  return [
    { key: '', label: 'All materials', count: all },
    ...roles.map((role) => ({ key: role, label: materialRoleLabel(role), count: counts[role] ?? 0 })),
  ]
}

export default async function InventoryPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const tab = oneOf(first(params.tab), INVENTORY_TABS, 'fg')
  const roleParam = first(params.role)
  const role = tab === 'materials' && MATERIAL_ROLES.includes(roleParam as MaterialRole) ? (roleParam as MaterialRole) : undefined
  const q = first(params.q)
  const page = pageOf(first(params.page))
  const query: Query = { tab: tab === 'fg' ? undefined : tab, role, q, page: page > 1 ? String(page) : undefined }

  const meta = await getMeta()
  if (!meta.dataAsOf) {
    return (
      <>
        <DataAsOf meta={meta} />
        <NotImported what="Stock by item and warehouse" />
      </>
    )
  }
  const data = await api<InventoryResponse>(hrefFor('/api/inventory', { tab, role, q, page: String(page) }))
  const { kpis } = data
  const filtered = Boolean(q || role)

  return (
    <>
      <DataAsOf meta={meta} />
      <KpiStrip label="Stock in figures">
        <Kpi chip="FG" label="Finished goods" value={num(kpis.fgItems)} stamp="Items with stock or orders against them" />
        <Kpi
          chip="!"
          tone="amber"
          label="Finished goods short"
          value={num(kpis.fgShort)}
          stamp="More committed than on hand"
          attn={kpis.fgShort > 0}
        />
        <Kpi
          chip="−"
          tone="coral"
          label="Materials below zero"
          value={num(kpis.materialsBelowZero)}
          stamp="On hand is negative in SAP"
          attn={kpis.materialsBelowZero > 0}
        />
        <Kpi
          chip="CS"
          tone="leaf"
          label="Customer-supplied items"
          value={num(kpis.customerSuppliedItems)}
          stamp="Held for a customer, not owned by Tierra"
        />
      </KpiStrip>
      <section className="sec" aria-labelledby="stock-head">
        <SectionHead
          id="stock-head"
          title={tab === 'fg' ? 'Finished goods' : 'Materials'}
          sub={
            tab === 'fg'
              ? 'Packed stock in the finished-goods store. Free is on hand less what open sales orders have committed.'
              : 'Laminate, cartons, seasoning, raw fruit and everything else the plant draws on, per warehouse.'
          }
          zid="Zone 1 · Stock"
        />
        <div className="toolbar">
          <Tabs
            label="Stock views"
            param="tab"
            path={PATH}
            query={query}
            reset={{ role: undefined }}
            active={tab}
            options={[
              { key: 'fg', label: 'Finished goods' },
              { key: 'materials', label: 'Materials' },
            ]}
          />
          <SearchBox path={PATH} query={query} label="Search items" placeholder="Item code or name" />
        </div>
        {tab === 'materials' ? (
          <FilterChips
            label="Material role"
            param="role"
            path={PATH}
            query={query}
            active={role ?? ''}
            options={roleOptions(data.roleCounts ?? {}, role)}
          />
        ) : null}
        <DataTable
          caption={tab === 'fg' ? 'Finished goods stock by warehouse' : 'Material stock by warehouse'}
          columns={columns}
          rows={data.rows}
          rowKey={(row) => `${row.itemCode}·${row.whsCode}`}
          empty={
            filtered ? (
              <p>
                Nothing matches these filters. <Link href={hrefFor(PATH, { tab: query.tab })}>Clear the filters</Link>
              </p>
            ) : (
              <p>No stock recorded for this view.</p>
            )
          }
        />
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} path={PATH} query={query} noun="stock rows" />
      </section>
    </>
  )
}
