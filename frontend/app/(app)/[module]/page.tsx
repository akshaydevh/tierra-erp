import { notFound } from 'next/navigation'
import { placeholderTitle } from '@/lib/nav'

export default async function PlaceholderPage({ params }: { params: Promise<{ module: string }> }) {
  const { module } = await params
  const title = placeholderTitle(module)
  if (!title) notFound()
  return (
    <section className="sec">
      <div className="card empty">
        <h3>{title}</h3>
        <p>This module is not in the first slice. Command Centre, Orders, Inventory, and Settings are live.</p>
      </div>
    </section>
  )
}
