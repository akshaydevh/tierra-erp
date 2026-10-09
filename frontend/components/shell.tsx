'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Icon } from './icon'
import { Logo } from './logo'
import { navFor, titleForPath } from '@/lib/nav'
import { roleLabel, type Me, type NavCounts } from '@/lib/types'

const COUNTS_EVERY_MS = 60_000

/** My Day and Approvals counts for the nav badges; reloaded on navigation, on a decision, and once a minute. */
function useNavCounts(path: string): NavCounts | null {
  const [counts, setCounts] = useState<NavCounts | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () => {
      void fetch('/api/nav-counts')
        .then((response) => (response.ok ? (response.json() as Promise<NavCounts>) : null))
        .then((body) => {
          if (!cancelled && body) setCounts(body)
        })
        .catch(() => undefined)
    }
    load()
    const timer = window.setInterval(load, COUNTS_EVERY_MS)
    window.addEventListener('tierra:counts', load)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('tierra:counts', load)
    }
  }, [path])
  return counts
}

function badgeFor(href: string, counts: NavCounts | null): { count: number; word: string } | null {
  if (!counts) return null
  if (href === '/my-day') return { count: counts.myDay, word: 'open' }
  if (href === '/approvals' && counts.approvals > 0) return { count: counts.approvals, word: 'waiting' }
  return null
}

function initials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase()
}

export function Shell({
  user,
  eyebrow,
  children,
}: {
  user: Me
  eyebrow: string
  children: React.ReactNode
}) {
  const path = usePathname()
  const router = useRouter()
  const title = titleForPath(path)
  const counts = useNavCounts(path)
  let groupSeen = ''

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
    router.refresh()
  }

  return (
    <div className="app">
      <a className="skip" href="#content">
        Skip to content
      </a>
      <aside className="side">
        <div className="brand">
          <Logo variant="mark" />
        </div>
        <nav className="nav">
          {navFor(user.role).map((item) => {
            const showGroup = item.group && item.group !== groupSeen
            if (item.group) groupSeen = item.group
            const active = item.href === '/' ? path === '/' : path === item.href || path.startsWith(`${item.href}/`)
            const badge = badgeFor(item.href, counts)
            return (
              <span key={item.href} style={{ display: 'contents' }}>
                {showGroup ? <div className="grp">{item.group}</div> : null}
                <Link href={item.href} className={active ? 'on' : undefined}>
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                  {badge ? (
                    <b className={badge.count > 0 ? 'badge' : 'badge zero'} title={`${badge.count} ${badge.word}`}>
                      {badge.count > 99 ? '99+' : badge.count}
                      <i className="sr"> {badge.word}</i>
                    </b>
                  ) : null}
                </Link>
              </span>
            )
          })}
        </nav>
        <div className="foot">
          <Link href="/settings" className={path === '/settings' ? 'on' : undefined}>
            <Icon name="sliders" />
            <span>Settings</span>
          </Link>
          <button type="button" className="out" onClick={() => void signOut()}>
            <Icon name="signout" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>
      <div className="mainwrap">
        <header className="topbar">
          <div>
            <h2>{title}</h2>
            <div className="eyebrow">{eyebrow}</div>
          </div>
          <div className="who">
            <div className="t">
              <b>{user.name}</b>
              <span>{roleLabel(user.role)}</span>
            </div>
            <div className="av">{initials(user.name)}</div>
          </div>
        </header>
        <main className="page" id="content">
          {children}
        </main>
      </div>
    </div>
  )
}
