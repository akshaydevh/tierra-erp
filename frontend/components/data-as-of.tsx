import type { ReactNode } from 'react'
import { day, dayTime } from '@/lib/format'
import type { Meta } from '@/lib/types'

/** One line saying how fresh the SAP figures are. `children` sits at the right (e.g. WhatsApp status). */
export function DataAsOf({ meta, children }: { meta: Meta; children?: ReactNode }) {
  const imported = Boolean(meta.dataAsOf)
  return (
    <div className={imported ? 'asof' : 'asof missing'}>
      <span className="dot" aria-hidden="true" />
      <span className="asoftext">
        {imported ? (
          <>
            SAP data as of <b>{day(meta.dataAsOf)}</b>
            {meta.importedAt ? <span className="asofsub"> · imported {dayTime(meta.importedAt)}</span> : null}
          </>
        ) : (
          <b>SAP data not imported yet</b>
        )}
      </span>
      {children ? <span className="asofside">{children}</span> : null}
    </div>
  )
}

/** Stands in for a page's figures and tables until the first SAP import. */
export function NotImported({ what }: { what: string }) {
  return (
    <div className="card empty">
      <h3>No SAP data yet</h3>
      <p>
        {what} come from the SAP import. Once the import has run, this page fills in on the next load.
      </p>
    </div>
  )
}
