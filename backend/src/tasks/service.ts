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
  await queueTaskNotice(deps, created)
  return { task: (await deps.store.getTask(created.id)) ?? created, assignment }
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

/** Marks a task done and tells whoever raised it, when that is someone else. */
export async function completeTask(deps: AgentDeps, task: TaskRecord, actor: TaskActor): Promise<TaskRecord | null> {
  const wasDone = task.status === 'done'
  const raisedBy = task.createdBy
  const title = task.title
  const done = await deps.store.updateTaskStatus(task.id, 'done')
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
