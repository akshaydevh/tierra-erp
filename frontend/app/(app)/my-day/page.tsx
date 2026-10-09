import { ApprovalActions, DecisionNotices, DoneButton } from '@/components/approval-actions'
import { ClampText } from '@/components/clamp-text'
import { Kpi, KpiStrip } from '@/components/kpi'
import { SectionHead } from '@/components/section-head'
import { StatusPill } from '@/components/status-pill'
import { ApprovalPdfs, ApprovalSummary, DueChip, KindChip, RecordRef, chainText, holderName } from '@/components/task-bits'
import { api } from '@/lib/api'
import { dayTime, num, time } from '@/lib/format'
import type { ApprovalView, Me, MyDayResponse, Task } from '@/lib/types'

function ApprovalBlock({ approval, taskId, me }: { approval: ApprovalView; taskId: string; me: Me }) {
  const order = approval.order
  const canDecide = approval.status === 'pending' && me.role === approval.approverRole
  return (
    <div className="apcard">
      <div className="aphead">
        <div>
          <b>{order ? `${order.docNo} · ${order.partyName ?? order.cardCode}` : 'Sales order not found'}</b>
          {order?.customerPoNo ? <div className="stamp">Customer PO {order.customerPoNo}</div> : null}
        </div>
        <span className="pills">
          {approval.status !== 'pending' ? <StatusPill status={approval.status} /> : null}
          {approval.selfRaised ? (
            <span className="pill amber" title="The approver also forwarded the PO">
              Self-raised
            </span>
          ) : null}
        </span>
      </div>
      <ApprovalSummary approval={approval} />
      <ApprovalPdfs approval={approval} />
      {canDecide ? <ApprovalActions taskId={taskId} docNo={order?.docNo ?? 'this sales order'} /> : null}
    </div>
  )
}

function OpenCard({ task, approval, me, now }: { task: Task; approval?: ApprovalView; me: Me; now: Date }) {
  const isApproval = task.kind === 'approval'
  return (
    <article className="card daycard" aria-label={task.title}>
      <div className="daytop">
        <b>{task.title}</b>
        <span className="taskchips">
          <KindChip task={task} />
          <DueChip dueAt={task.dueAt} now={now} />
        </span>
      </div>
      <div className="daymeta">
        <span className="stamp">
          {chainText(task, me.id)} · raised {dayTime(task.createdAt)}
        </span>
        <RecordRef task={task} approval={approval} />
      </div>
      {task.description ? <ClampText text={task.description} /> : null}
      {isApproval ? (
        approval ? (
          <ApprovalBlock approval={approval} taskId={task.id} me={me} />
        ) : (
          <p className="note">The approval behind this task could not be found.</p>
        )
      ) : (
        <DoneButton taskId={task.id} title={task.title} />
      )}
    </article>
  )
}

function groupByHolder(tasks: Task[]): [string, Task[]][] {
  const groups = new Map<string, Task[]>()
  for (const task of tasks) {
    const key = holderName(task)
    groups.set(key, [...(groups.get(key) ?? []), task])
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}

export default async function MyDayPage() {
  const [{ user: me }, data] = await Promise.all([api<{ user: Me }>('/api/auth/me'), api<MyDayResponse>('/api/my-day')])
  const now = new Date()
  const overdue = data.open.filter((task) => task.dueAt && new Date(task.dueAt) < now).length
  const approvalsWaiting = data.open.filter((task) => task.kind === 'approval').length
  const waitingGroups = groupByHolder(data.waiting)
  const doneToday = data.closedToday.length
  const all = doneToday + data.open.length

  return (
    <DecisionNotices>
      <KpiStrip label="Your day in figures">
        <Kpi chip="ME" label="Open · your move" value={num(data.open.length)} stamp="Yours and your role’s, by due time" />
        <Kpi chip="!" tone="coral" label="Overdue" value={num(overdue)} stamp="Past their due time" attn={overdue > 0} />
        <Kpi chip="OK" tone="amber" label="Approvals waiting" value={num(approvalsWaiting)} stamp="Sales orders for your yes" attn={approvalsWaiting > 0} />
        <Kpi chip="✓" tone="leaf" label="Closed today" value={num(doneToday)} stamp={all ? `${num(doneToday)} of ${num(all)} done` : 'Nothing yet'} />
      </KpiStrip>

      <section className="sec" aria-labelledby="open-head">
        <SectionHead
          id="open-head"
          title="Open · your move"
          sub="Tasks you hold and tasks addressed to your role, soonest due first."
          zid="Zone 1 · Open"
        />
        {data.open.length ? (
          <div className="daylist">
            {data.open.map((task) => (
              <OpenCard key={task.id} task={task} approval={data.approvals[task.id]} me={me} now={now} />
            ))}
          </div>
        ) : (
          <div className="card empty">
            <p>Nothing waiting on you. New tasks and approvals land here as they are raised.</p>
          </div>
        )}
      </section>

      <section className="sec" aria-labelledby="waiting-head">
        <SectionHead
          id="waiting-head"
          title="Waiting on others"
          sub="Tasks you raised that someone else holds, by who holds them."
          zid="Zone 2 · Waiting"
        />
        {waitingGroups.length ? (
          <div className="daygroups">
            {waitingGroups.map(([holder, tasks]) => (
              <article key={holder} className="card p6 daygroup">
                <h4>
                  {holder.charAt(0).toUpperCase() + holder.slice(1)}
                  <span className="num">{num(tasks.length)}</span>
                </h4>
                <ul className="dayrows">
                  {tasks.map((task) => (
                    <li key={task.id}>
                      <div>
                        <b>{task.title}</b>
                        <div className="stamp">
                          <KindLabel task={task} /> · raised {dayTime(task.createdAt)}
                        </div>
                      </div>
                      <span className="taskchips">
                        <DueChip dueAt={task.dueAt} now={now} />
                        <RecordRef task={task} />
                      </span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        ) : (
          <div className="card empty">
            <p>Nobody is holding anything you raised.</p>
          </div>
        )}
      </section>

      <section className="sec" aria-labelledby="closed-head">
        <SectionHead
          id="closed-head"
          title="Closed today"
          sub={doneToday ? `${num(doneToday)} done since midnight, India time.` : 'Tasks you or your role finish today show here.'}
          zid="Zone 3 · Closed"
        />
        {doneToday ? (
          <article className="card p6">
            <ul className="dayrows">
              {data.closedToday.map((task) => (
                <li key={task.id}>
                  <div>
                    <b>{task.title}</b>
                    <div className="stamp">
                      {chainText(task, me.id)}
                    </div>
                  </div>
                  <span className="taskchips">
                    <span className="pill ok">Done {time(task.completedAt)}</span>
                    <RecordRef task={task} approval={data.approvals[task.id]} />
                  </span>
                </li>
              ))}
            </ul>
          </article>
        ) : (
          <div className="card empty">
            <p>Nothing closed yet today.</p>
          </div>
        )}
      </section>
    </DecisionNotices>
  )
}

function KindLabel({ task }: { task: Task }) {
  return <>{task.kind === 'approval' ? 'Approval' : task.category.charAt(0).toUpperCase() + task.category.slice(1)}</>
}
