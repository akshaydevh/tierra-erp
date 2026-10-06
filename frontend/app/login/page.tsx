'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Logo } from '@/components/logo'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError('')
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    setPending(false)
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null
      setError(body?.error ?? 'Could not sign in')
      return
    }
    router.push('/')
    router.refresh()
  }

  return (
    <main className="login">
      <div className="brandmark">
        <Logo />
      </div>
      <form className="logincard" onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        {error ? <p className="formerror">{error}</p> : null}
        <button className="btn-ink" type="submit" disabled={pending}>
          {pending ? 'Signing in' : 'Sign in'}
        </button>
      </form>
      <p className="loginnote">Preview accounts are listed in the project README.</p>
    </main>
  )
}
