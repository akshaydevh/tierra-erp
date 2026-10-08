import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'tierra_session'

export function newSessionToken(): string {
  return randomBytes(32).toString('hex')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=')
    if (rawKey === name) return rest.join('=')
  }
  return null
}

function cookieFlags(secure: boolean): string {
  return `HttpOnly; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure = false): string {
  return `${SESSION_COOKIE}=${token}; ${cookieFlags(secure)}; Max-Age=${maxAgeSeconds}`
}

export function clearSessionCookie(secure = false): string {
  return `${SESSION_COOKIE}=; ${cookieFlags(secure)}; Max-Age=0`
}

export function safeEqual(left: string | undefined, right: string): boolean {
  if (!left) return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
