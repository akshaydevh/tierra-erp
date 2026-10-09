import type { ReactNode } from 'react'

/** Record page: the record in the main column, its history on the right rail (stacks below 1240px). */
export function DetailFrame({ children, rail, railLabel = 'History' }: { children: ReactNode; rail: ReactNode; railLabel?: string }) {
  return (
    <div className="detail">
      <div className="detailmain">{children}</div>
      <aside className="rail" aria-label={railLabel}>
        {rail}
      </aside>
    </div>
  )
}

export type Fact = { label: string; value: ReactNode }

/** Label/value pairs for a record header. */
export function Facts({ items, label }: { items: Fact[]; label?: string }) {
  return (
    <dl className="card p6 facts" aria-label={label}>
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export type Milestone = {
  key: string
  title: ReactNode
  when?: ReactNode
  note?: ReactNode
  /** The step still waiting gets the filled dark marker. */
  waiting?: boolean
}

/** History on the rail, oldest first. System-written; nothing to edit. */
export function Milestones({ title, items, empty }: { title: string; items: Milestone[]; empty: string }) {
  return (
    <article className="card p6">
      <div className="zid">{title}</div>
      {items.length === 0 ? (
        <p className="stamp railempty">{empty}</p>
      ) : (
        <ol className="mslist">
          {items.map((item, index) => (
            <li key={item.key} className="msrow">
              <span className={item.waiting ? 'msi wait' : 'msi'} aria-hidden="true">
                {index + 1}
              </span>
              <div>
                <b>{item.title}</b>
                {item.note ? <div className="msnote">{item.note}</div> : null}
                {item.when ? <div className="stamp">{item.when}</div> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </article>
  )
}
