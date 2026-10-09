import { notFound } from 'next/navigation'
import { api } from '@/lib/api'
import { canOpen, placeholderTitle } from '@/lib/nav'
import type { Me } from '@/lib/types'

export default async function PlaceholderPage({ params }: { params: Promise<{ module: string }> }) {
  const { module } = await params
  const title = placeholderTitle(module)
  if (!title) notFound()
  const { user } = await api<{ user: Me }>('/api/auth/me')
  if (!canOpen(user.role, `/${module}`)) notFound()
  return (
    <section className="sec">
      <div className="card empty">
        <h3>{title}</h3>
        <p>This module is not built yet. Command Centre, My Day, Approvals, Orders, Production, Procurement, Dispatch, Inventory, Payments, Costing, Payroll and attendance, Reports and Settings are live.</p>
      </div>
    </section>
  )
}
