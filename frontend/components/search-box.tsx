'use client'

import { useRouter } from 'next/navigation'
import { useId, useRef, type FormEvent } from 'react'
import { hrefFor, type Query } from '@/lib/query'

/**
 * Search that writes `?q=` to the URL. It is a plain GET form, so it works before
 * hydration; once hydrated it navigates without a full reload. Paging resets on search.
 */
export function SearchBox({
  path,
  query,
  label,
  placeholder,
}: {
  path: string
  /** The page's current filters; carried over as hidden fields. */
  query: Query
  label: string
  placeholder?: string
}) {
  const router = useRouter()
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const keep = Object.entries(query).filter(([key, value]) => key !== 'q' && key !== 'page' && value)

  function go(q: string) {
    router.push(hrefFor(path, query, { q: q.trim() || undefined, page: undefined }))
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    go(input.current?.value ?? '')
  }

  return (
    <form className="search" role="search" action={path} method="get" onSubmit={submit}>
      <label htmlFor={id} className="sr">
        {label}
      </label>
      {keep.map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      <input
        id={id}
        type="search"
        name="q"
        ref={input}
        key={query.q ?? ''}
        defaultValue={query.q}
        placeholder={placeholder ?? label}
        autoComplete="off"
      />
      <button type="submit" className="btn-sec">
        Search
      </button>
      {query.q ? (
        <button type="button" className="linkbtn" onClick={() => go('')}>
          Clear
        </button>
      ) : null}
    </form>
  )
}
