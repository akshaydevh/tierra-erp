'use client'

import { useRouter } from 'next/navigation'
import { useId, type FormEvent } from 'react'
import { hrefFor, type Query } from '@/lib/query'

/**
 * A calendar day written to `?date=`. Picking a day navigates straight away; without
 * JavaScript the Show button submits the same GET form.
 */
export function DayPicker({
  path,
  query,
  value,
  max,
  label,
}: {
  path: string
  query: Query
  value: string
  max?: string
  label: string
}) {
  const router = useRouter()
  const id = useId()

  function go(date: string) {
    // Typing a year digit by digit passes through dates like 0002-07-23; wait for a real one.
    if (/^(19|20)\d{2}-\d{2}-\d{2}$/.test(date)) router.push(hrefFor(path, query, { date }))
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const field = event.currentTarget.elements.namedItem('date')
    if (field instanceof HTMLInputElement) go(field.value)
  }

  return (
    <form className="daypick" action={path} method="get" onSubmit={submit}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="date"
        name="date"
        defaultValue={value}
        key={value}
        max={max}
        required
        onChange={(event) => go(event.target.value)}
      />
      <button type="submit" className="btn-sec">
        Show
      </button>
    </form>
  )
}
