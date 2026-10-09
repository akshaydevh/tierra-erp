import type { ReactNode } from 'react'

export function SectionHead({
  title,
  sub,
  zid,
  actions,
  id,
}: {
  title: ReactNode
  sub?: ReactNode
  /** Review anchor shown at the right, e.g. "Zone 1 · Book". */
  zid?: string
  /** Controls or a status pill shown at the right, before the zone id. */
  actions?: ReactNode
  /** Id for the heading, so a section or table can be labelled by it. */
  id?: string
}) {
  return (
    <div className="sechead">
      <div>
        <h3 id={id}>{title}</h3>
        {sub ? <p>{sub}</p> : null}
      </div>
      {actions || zid ? (
        <div className="secside">
          {actions}
          {zid ? <span className="zid">{zid}</span> : null}
        </div>
      ) : null}
    </div>
  )
}
