'use client'

import { Suspense, createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { PageLoading } from './page-loading'

/**
 * Instant feedback while the next page's data loads. Pages render on the server, so Next only swaps them in once
 * their API calls are done; until then this shows where you are going:
 * - another page: its title and nav item light up, and a skeleton replaces the content;
 * - the same page with a new tab, filter, search or page number: a bar under the top bar, the content dimmed.
 * (loading.tsx boundaries would do the first, but with Next 15.5 they left some query-only navigations hanging.)
 */

/** Fired by startNavigation before a router.push (search box, day picker), so they show progress like a link does. */
const NAVIGATING_EVENT = 'tierra:navigating'

/** A navigation that never lands (offline, a server error) stops showing progress after this long. */
const GIVE_UP_MS = 20_000

type Pending = { kind: 'route' | 'query'; path: string } | null

const PendingContext = createContext<Pending>(null)

/** Path and query, normalised so "?q=a+b" and "?q=a%20b" compare equal. */
function place(url: URL): string {
  return `${url.pathname}?${new URLSearchParams(url.search).toString()}`
}

/** What navigating to this URL means from here: null when it is where we already are. */
function pendingFor(url: URL): Pending {
  const here = new URL(window.location.href)
  if (place(url) === place(here)) return null
  return { kind: url.pathname === here.pathname ? 'query' : 'route', path: url.pathname }
}

/** Call before router.push: shows progress unless the push goes nowhere new. */
export function startNavigation(href: string): void {
  window.dispatchEvent(new CustomEvent(NAVIGATING_EVENT, { detail: href }))
}

/** The URL a click on this element navigates to inside the app, or null. */
function clickTarget(event: MouseEvent): URL | null {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null
  const anchor = (event.target as Element | null)?.closest?.('a[href]')
  if (!(anchor instanceof HTMLAnchorElement)) return null
  if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return null
  const url = new URL(anchor.href, window.location.href)
  // /api/... links are files (PDFs, attachments) that open in a tab, not pages
  if (url.origin !== window.location.origin || url.pathname.startsWith('/api/')) return null
  return url
}

/** Reports each landed URL. Apart because useSearchParams needs a Suspense boundary of its own. */
function Landed({ onLand }: { onLand: () => void }) {
  const path = usePathname()
  const search = useSearchParams()
  useEffect(onLand, [path, search, onLand])
  return null
}

export function NavPendingProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending>(null)
  const [clear] = useState(() => () => setPending(null))

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const url = clickTarget(event)
      if (url) setPending(pendingFor(url))
    }
    const onNavigating = (event: Event) => {
      const href = (event as CustomEvent<string>).detail
      setPending(pendingFor(new URL(href, window.location.href)))
    }
    document.addEventListener('click', onClick)
    window.addEventListener(NAVIGATING_EVENT, onNavigating)
    return () => {
      document.removeEventListener('click', onClick)
      window.removeEventListener(NAVIGATING_EVENT, onNavigating)
    }
  }, [])

  useEffect(() => {
    if (!pending) return
    const content = document.getElementById('content')
    content?.setAttribute('data-pending', pending.kind)
    content?.setAttribute('aria-busy', 'true')
    if (pending.kind === 'route') content?.scrollTo({ top: 0 })
    const timer = window.setTimeout(clear, GIVE_UP_MS)
    return () => {
      window.clearTimeout(timer)
      content?.removeAttribute('data-pending')
      content?.removeAttribute('aria-busy')
    }
  }, [pending, clear])

  return (
    <PendingContext.Provider value={pending}>
      <Suspense fallback={null}>
        <Landed onLand={clear} />
      </Suspense>
      {children}
    </PendingContext.Provider>
  )
}

/** The path being opened, or null when nothing is loading (or only the query changes). */
export function usePendingPath(): string | null {
  const pending = useContext(PendingContext)
  return pending?.kind === 'route' ? pending.path : null
}

/** The bar under the top bar while anything loads. */
export function NavProgressBar() {
  return useContext(PendingContext) ? <div className="navprogress" role="progressbar" aria-label="Loading" /> : null
}

/** The skeleton in place of the page while another page loads. */
export function RouteSkeleton() {
  return usePendingPath() ? <PageLoading /> : null
}
