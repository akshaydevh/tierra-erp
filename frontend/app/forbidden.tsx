import Link from 'next/link'

/** What forbidden() renders (HTTP 403): a page this role may not open, e.g. Payroll for anyone but the admin. */
export default function Forbidden() {
  return (
    <main className="page">
      <section className="sec">
        <div className="card empty">
          <h3>Not for your role</h3>
          <p>This page is limited to other roles. Payroll and attendance are for the admin only; costing and payments for the manager and the admin.</p>
          <p>
            <Link href="/">Back to the Command Centre</Link>
          </p>
        </div>
      </section>
    </main>
  )
}
