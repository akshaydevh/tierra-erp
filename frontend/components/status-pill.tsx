type Tone = 'ok' | 'amber' | 'coral' | 'grey' | 'ink'

const STATUS: Record<string, { tone: Tone; label: string }> = {
  // Sales orders, purchase orders, production orders
  open: { tone: 'ok', label: 'Open' },
  closed: { tone: 'grey', label: 'Closed' },
  // SAP line status letters, in case a view passes them through
  o: { tone: 'ok', label: 'Open' },
  c: { tone: 'grey', label: 'Closed' },
  cancelled: { tone: 'coral', label: 'Cancelled' },
  planned: { tone: 'grey', label: 'Planned' },
  released: { tone: 'ok', label: 'Released' },
  stale: { tone: 'amber', label: 'Stale' },
  // Approvals
  approved: { tone: 'ok', label: 'Approved' },
  rejected: { tone: 'coral', label: 'Rejected' },
  waiting: { tone: 'amber', label: 'Waiting' },
  // Customer POs received (P3) and their inventory check
  received: { tone: 'grey', label: 'Received' },
  needs_review: { tone: 'amber', label: 'Needs review' },
  awaiting_proceed: { tone: 'amber', label: 'Repeat · waiting' },
  short: { tone: 'coral', label: 'Short' },
  checked: { tone: 'ok', label: 'Checked' },
  pass: { tone: 'ok', label: 'Pass' },
  pass_with_incoming: { tone: 'amber', label: 'Pass with incoming' },
  fail: { tone: 'coral', label: 'Fail' },
  ok: { tone: 'ok', label: 'OK' },
  short_now: { tone: 'amber', label: 'Short now' },
  // Tierra sales orders (P4) and their approvals
  draft: { tone: 'grey', label: 'Draft' },
  pending_approval: { tone: 'amber', label: 'Waiting for approval' },
  sent: { tone: 'ok', label: 'Sent to customer' },
  approved_unsent: { tone: 'amber', label: 'Approved · not sent' },
  in_sap: { tone: 'ok', label: 'In SAP' },
  pending: { tone: 'amber', label: 'Waiting' },
  sent_back: { tone: 'amber', label: 'Sent back' },
  superseded: { tone: 'grey', label: 'Superseded' },
  // Procurement requests and unposted receipts
  production: { tone: 'ink', label: 'Production' },
  expedite: { tone: 'amber', label: 'Expedite' },
  shortage: { tone: 'coral', label: 'Shortage' },
  done: { tone: 'ok', label: 'Done' },
  active: { tone: 'amber', label: 'Unposted' },
  absorbed: { tone: 'ok', label: 'In SAP' },
  // Production order type
  standard: { tone: 'grey', label: 'Standard' },
  disassembly: { tone: 'amber', label: 'Disassembly' },
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).replace(/_/g, ' ')
}

/** A domain status as a pill. Unknown statuses fall back to grey with the raw text. */
export function StatusPill({ status, label, tone }: { status: string | null | undefined; label?: string; tone?: Tone }) {
  if (!status) return <span className="pill grey">—</span>
  const known = STATUS[status.toLowerCase()]
  return <span className={`pill ${tone ?? known?.tone ?? 'grey'}`}>{label ?? known?.label ?? capitalised(status)}</span>
}

/**
 * IRN status text comes from the e-invoice add-on as free text; read it loosely.
 * Failures are coral, cancellations grey, successes green, anything else amber.
 */
export function irnTone(status: string | null | undefined): Tone {
  if (!status) return 'grey'
  if (/fail|error|reject/i.test(status)) return 'coral'
  if (/cancel/i.test(status)) return 'grey'
  if (/success|generated|active|done|ok/i.test(status)) return 'ok'
  return 'amber'
}

/** An e-way bill number, with a grey "cancelled" pill when it was cancelled on the portal. */
export function EwbNumber({ ewbNo, cancelled }: { ewbNo: string | null; cancelled: boolean }) {
  if (!ewbNo) return 'None'
  return (
    <>
      {ewbNo}
      {cancelled ? (
        <>
          {' '}
          <span className="pill grey">cancelled</span>
        </>
      ) : null}
    </>
  )
}
