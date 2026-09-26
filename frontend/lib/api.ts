import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

const apiUrl = process.env.API_URL ?? 'http://localhost:3002'

export async function api<T>(path: string): Promise<T> {
  const jar = await cookies()
  const token = jar.get('tierra_session')?.value
  const response = await fetch(`${apiUrl}${path}`, {
    headers: token ? { cookie: `tierra_session=${token}` } : {},
    cache: 'no-store',
  })
  if (response.status === 401) redirect('/login')
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  return response.json() as Promise<T>
}
