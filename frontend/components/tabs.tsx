import Link from 'next/link'
import { num } from '@/lib/format'
import { hrefFor, type Query } from '@/lib/query'

export type LinkOption = {
  key: string
  label: string
  count?: number
}

type Props = {
  /** Accessible name for the group, e.g. "Order views". */
  label: string
  options: LinkOption[]
  active: string
  /** The search param this group sets. */
  param: string
  /** Page path and the current query; other filters carry over, paging resets. */
  path: string
  query: Query
  /** Extra params to change when switching, e.g. clearing a chip that belongs to one tab. */
  reset?: Query
}

function optionHref({ param, path, query, reset }: Props, key: string): string {
  return hrefFor(path, query, { ...reset, [param]: key, page: undefined })
}

/** Segmented links that switch a page view; server-rendered, state lives in the URL. */
export function Tabs(props: Props) {
  return (
    <nav className="tabs" aria-label={props.label}>
      {props.options.map((option) => {
        const on = option.key === props.active
        return (
          <Link
            key={option.key}
            href={optionHref(props, option.key)}
            className={on ? 'on' : undefined}
            aria-current={on ? 'page' : undefined}
          >
            {option.label}
            {option.count !== undefined ? <span className="ct num">{num(option.count)}</span> : null}
          </Link>
        )
      })}
    </nav>
  )
}

/** Filter chips with optional counts; the active chip is marked for screen readers. */
export function FilterChips(props: Props) {
  return (
    <nav className="fchips" aria-label={props.label}>
      {props.options.map((option) => {
        const on = option.key === props.active
        return (
          <Link
            key={option.key}
            href={optionHref(props, option.key)}
            className={on ? 'fchip on' : 'fchip'}
            aria-current={on ? 'true' : undefined}
          >
            {option.label}
            {option.count !== undefined ? <span className="ct num">{num(option.count)}</span> : null}
          </Link>
        )
      })}
    </nav>
  )
}
