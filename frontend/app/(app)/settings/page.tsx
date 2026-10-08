import { api } from '@/lib/api'
import type { Me } from '@/lib/types'
import { SettingsPanel } from './settings-panel'

export default async function SettingsPage() {
  const { user } = await api<{ user: Me }>('/api/auth/me')
  return <SettingsPanel me={user} />
}
