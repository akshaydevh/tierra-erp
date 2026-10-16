import { api } from '@/lib/api'
import type { Me } from '@/lib/types'
import { PeoplePanel } from './people-panel'

export default async function MastersPage() {
  const { user } = await api<{ user: Me }>('/api/auth/me')
  return <PeoplePanel me={user} />
}
