import type { Store } from '../db/store'
import type { TaskRecord } from '../db/types'
import type { SapSql } from '../sap/db'
import { dispatchDay } from './dispatch'
import { fgShortRows, type FgShortRow } from './inventory'
import { importMeta } from './meta'
import { orderBook, salesSummary } from './sales'

/** The factory_brief tool: open orders, short finished goods, the data day's dispatch and open tasks. */
export type DataBrief = {
  dataAsOf: string | null
  openSalesOrders: {
    count: number
    latest: Array<{ docNo: string; customer: string; total: number; customerPoNo: string | null }>
  }
  fgShort: FgShortRow[]
  lastDayDispatch: { date: string | null; invoices: number; value: number }
  openTasks: Array<Pick<TaskRecord, 'title' | 'category' | 'status' | 'assigneeName'>>
}

function openTasks(tasks: TaskRecord[]): DataBrief['openTasks'] {
  return tasks
    .filter((task) => task.status === 'todo' || task.status === 'doing')
    .map((task) => ({ title: task.title, category: task.category, status: task.status, assigneeName: task.assigneeName }))
}

export async function dataBrief(sql: SapSql, store: Store): Promise<DataBrief> {
  const [meta, tasks] = await Promise.all([importMeta(sql), store.listTasks()])
  const asOf = meta.dataAsOf
  if (!asOf) {
    return {
      dataAsOf: null,
      openSalesOrders: { count: 0, latest: [] },
      fgShort: [],
      lastDayDispatch: { date: null, invoices: 0, value: 0 },
      openTasks: openTasks(tasks),
    }
  }
  const [summary, latest, fgShort, dispatch] = await Promise.all([
    salesSummary(sql, asOf),
    orderBook(sql, { state: 'open', pageSize: 5 }),
    fgShortRows(sql, 10),
    dispatchDay(sql, asOf, 'all'),
  ])
  return {
    dataAsOf: asOf,
    openSalesOrders: {
      count: summary.openSalesOrders,
      latest: latest.rows.map((row) => ({
        docNo: row.docNo,
        customer: row.cardName,
        total: row.total,
        customerPoNo: row.customerPoNo,
      })),
    },
    fgShort,
    lastDayDispatch: { date: asOf, invoices: dispatch.kpis.invoices, value: dispatch.kpis.value },
    openTasks: openTasks(tasks),
  }
}
