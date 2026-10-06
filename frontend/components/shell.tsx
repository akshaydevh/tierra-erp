'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Icon } from './icon'
import { Logo } from './logo'
import { navItems, titleForPath } from '@/lib/nav'
import type { Me } from '@/lib/types'

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
  let groupSeen = ''

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
    router.refresh()
  }

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <Logo variant="mark" />
        </div>
        <nav className="nav">
          {navItems.map((item) => {
            const showGroup = item.group && item.group !== groupSeen
            if (item.group) groupSeen = item.group
            const active = item.href === '/' ? path === '/' : path === item.href || path.startsWith(`${item.href}/`)
            return (
              <span key={item.href} style={{ display: 'contents' }}>
                {showGroup ? <div className="grp">{item.group}</div> : null}
                <Link href={item.href} className={active ? 'on' : undefined}>
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
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
              <span>{user.role === 'admin' ? 'Admin' : 'Office'}</span>
            </div>
            <div className="av">{initials(user.name)}</div>
          </div>
        </header>
        <div className="page">{children}</div>
      </div>
    </div>
  )
}
