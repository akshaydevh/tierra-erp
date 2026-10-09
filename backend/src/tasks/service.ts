import type { AgentDeps } from '../agent/handle-message'
import { sendDm } from '../agent/send'
import type { Role, TaskCategory, TaskKind, TaskRecord, TaskVia } from '../db/types'
import { resolveAssignee, type Assignment } from '../domain/routing'
import { queueTaskNotice } from './notify'

export class UnknownAssigneeError extends Error {
  constructor() {
    super('That account does not exist')
  }
}

export type TaskInput = {
  title: string
  category: TaskCategory
  kind?: TaskKind
  assigneeId?: string | null
  assigneeRole?: Role | null
  description?: string | null
  dueAt?: Date | null
  subjectType?: string | null
  subjectId?: string | null
  createdVia: TaskVia
  createdBy: string
  /**
   * The same subject's task is already done (one task per subject and kind): open it again with this title and
   * description and a fresh notice, instead of quietly returning the finished one.
   */
  reopen?: boolean
}

export type TaskActor = {
  userId: string
  name: string
}

async function assign(
  deps: AgentDeps,
  input: { assigneeId?: string | null; assigneeRole?: Role | null },
): Promise<Assignment> {
  const assignment = resolveAssignee(await deps.store.listAccountLinks(), input)
  if (!assignment) throw new UnknownAssigneeError()
  return assignment
}

/** Every task is created here, so every holder hears about it on WhatsApp. */
export async function createTaskAndNotify(
  deps: AgentDeps,
  input: TaskInput,
): Promise<{ task: TaskRecord; assignment: Assignment }> {
  const assignment = await assign(deps, input)
  const created = await deps.store.createTask({
    title: input.title,
    category: input.category,
    kind: input.kind,
    assigneeId: assignment.assigneeId,
    assigneeRole: assignment.assigneeRole,
    description: input.description ?? null,
    dueAt: input.dueAt ?? null,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    createdVia: input.createdVia,
    createdBy: input.createdBy,
  })
  const task = input.reopen && created.status === 'done' ? ((await deps.store.reopenTask(created.id, { title: input.title, description: input.description ?? null })) ?? created) : created
  await queueTaskNotice(deps, task)
  return { task: (await deps.store.getTask(task.id)) ?? task, assignment }
}

/** Moves a task to another person or role. A new holder gets the notice again. */
export async function reassignTask(
  deps: AgentDeps,
  task: TaskRecord,
  input: { assigneeId: string | null; assigneeRole: Role | null },
): Promise<TaskRecord | null> {
  const previous = task.assigneeId
  const assignment = await assign(deps, input)
  const updated = await deps.store.updateTaskAssignment(task.id, {
    assigneeId: assignment.assigneeId,
    assigneeRole: assignment.assigneeRole,
  })
  if (updated && updated.assigneeId !== previous) await queueTaskNotice(deps, updated)
  return updated ? ((await deps.store.getTask(task.id)) ?? updated) : null
}

/**
 * What finishing a task sets off (plan §P4): the manager's procurement or customer follow-up task on a PO on hold
 * rechecks the PO; the office's revision of a sent-back sales order sends the next version for approval.
 */
async function afterDone(deps: AgentDeps, task: TaskRecord): Promise<void> {
  if (!task.subjectId) return
  if (task.subjectType === 'customer_po' && (task.kind === 'procurement' || task.kind === 'customer_followup')) {
    await deps.enqueue({
      kind: 'po.recheck',
      payload: { customerPoId: task.subjectId, taskId: task.id },
      // after the "Marked … done" reply, so the recheck's news reads in order
      runAfter: new Date(deps.now().getTime() + 2_000),
      idempotencyKey: `po.recheck:${task.id}:${deps.now().getTime()}`,
    })
  } else if (task.subjectType === 'sales_order_revision') {
    const [salesOrderId, version] = task.subjectId.split(':v')
    await deps.enqueue({
      kind: 'so.revise',
      payload: { salesOrderId, fromVersion: Number(version) },
      idempotencyKey: `so.revise:${task.subjectId}`,
    })
  }
}

/** Marks a task done and tells whoever raised it, when that is someone else. */
export async function completeTask(deps: AgentDeps, task: TaskRecord, actor: TaskActor): Promise<TaskRecord | null> {
  const wasDone = task.status === 'done'
  const raisedBy = task.createdBy
  const title = task.title
  const done = await deps.store.updateTaskStatus(task.id, 'done')
  if (done && !wasDone) {
    await afterDone(deps, done).catch((error: unknown) => console.error(`Task ${task.id}: what follows could not be queued`, error))
  }
  if (!done || wasDone || raisedBy === actor.userId) return done
  const raiser = (await deps.store.listAccountLinks()).find((account) => account.id === raisedBy)
  if (!raiser?.phoneNumber) return done
  try {
    await sendDm(deps, raiser.phoneNumber, `${actor.name} finished “${title}”.`, {
      purpose: 'task_done',
      subjectType: 'task',
      subjectId: task.id,
    })
  } catch (error) {
    console.error(`Could not tell ${raiser.name} that task ${task.id} is done`, error)
  }
  return done
}
