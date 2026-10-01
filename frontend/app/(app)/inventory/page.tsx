import { api } from '@/lib/api'
import type { InventoryItem } from '@/lib/types'
import { InventoryTable } from './inventory-table'

export default async function InventoryPage() {
  const { items } = await api<{ items: InventoryItem[] }>('/api/inventory')
  return <InventoryTable items={items} />
}
