import { Shell } from '@/components/shell'
import { api } from '@/lib/api'
import type { Me } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user } = await api<{ user: Me }>('/api/auth/me')
  const eyebrow = new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date())
  return (
    <Shell user={user} eyebrow={eyebrow}>
      {children}
    </Shell>
  )
}
