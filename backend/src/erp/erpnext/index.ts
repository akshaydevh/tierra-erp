import type { SapSql } from '../../sap/db'
import { ErpnextClient, type ErpnextConfig } from './client'
import { applyCompat } from './compat'
import { ErpnextMirror } from './mirror'

export type ErpnextEnv = ErpnextConfig & {
  /** mysql://tierra_ro:...@127.0.0.1:3307/<site db>: the read-only MariaDB user. */
  dbUrl: string
  /** How often the mirror looks for ERPNext changes and copies them (ms). */
  syncMs: number
}

export type Erpnext = {
  client: ErpnextClient
  /** Copies ERPNext now (after a write, so the next read sees it). Concurrent calls share one run. */
  syncNow: () => Promise<void>
  stop: () => Promise<void>
}

/**
 * The ERPNext read model at boot: mirror tables, a first copy, the sap compat views and the erp views over them,
 * then a check every syncMs that copies again only when ERPNext changed. A failed copy keeps the last good one
 * (the copy runs in one transaction).
 */
export async function startErpnext(sql: SapSql, env: ErpnextEnv): Promise<Erpnext> {
  const mirror = new ErpnextMirror(sql, env.dbUrl)
  await mirror.prepare()
  const first = (await mirror.syncIfChanged(true))!
  await applyCompat(sql)
  await sql`select erp.refresh()`
  console.log(`erpnext mirror: ${first.rows} rows from ${first.tables} tables in ${first.ms} ms; erp views ready`)

  let running: Promise<void> | null = null
  let again = false
  const syncNow = (): Promise<void> => {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      do {
        again = false
        try {
          const result = await mirror.syncIfChanged()
          if (result) console.log(`erpnext mirror: ${result.rows} rows in ${result.ms} ms`)
        } catch (error) {
          console.error('erpnext mirror sync failed (keeping the last copy)', error)
        }
      } while (again)
    })().finally(() => {
      running = null
    })
    return running
  }
  const timer = setInterval(() => void syncNow(), env.syncMs)
  return {
    client: new ErpnextClient(env),
    syncNow,
    stop: async () => {
      clearInterval(timer)
      await running
      await mirror.close()
    },
  }
}
