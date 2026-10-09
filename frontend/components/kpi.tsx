import Link from 'next/link'
import type { ReactNode } from 'react'

export type Tone = 'ink' | 'amber' | 'leaf' | 'coral'

/** Four figures across; two below 1240px; one on a phone. */
export function KpiStrip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="kpis" aria-label={label}>
      {children}
    </section>
  )
}

export function Kpi({
  label,
  value,
  stamp,
  chip,
  tone = 'ink',
  attn = false,
  href,
}: {
  label: string
  value: ReactNode
  /** One line of provenance or context under the value. */
  stamp?: ReactNode
  /** Two or three letters in the corner badge. */
  chip?: string
  tone?: Tone
  /** Amber ring: this figure needs someone's attention. */
  attn?: boolean
  /** Where the figure comes from; makes the label a link. */
  href?: string
}) {
  return (
    <article className={`card p6 kpi${attn ? ' attn' : ''}`}>
      {chip ? (
        <div className="top">
          <div className={`chip ${tone}`} aria-hidden="true">
            {chip}
          </div>
        </div>
      ) : null}
      <div className="lab">{href ? <Link href={href}>{label}</Link> : label}</div>
      <div className="val num">{value}</div>
      {stamp ? <div className="stamp">{stamp}</div> : null}
    </article>
  )
}
