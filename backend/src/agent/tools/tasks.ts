import { z } from 'zod/v4'
import { ROLE_ALIASES, ROLES, TASK_CATEGORIES, roleFromName, roleLabel, type TaskRecord } from '../../db/types'
import { resolveAssignee } from '../../domain/routing'
import { canFinish, isOpenTask } from '../../tasks/done'
import { defineTool, type ToolContext } from './types'

function speakerOf(ctx: ToolContext) {
  if (ctx.audience.kind !== 'internal') throw new Error('Task tools need a Tierra account')
  return ctx.audience
}

function taskSummary(task: TaskRecord) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    category: task.category,
    holder: task.assigneeName,
    role: task.assigneeRole,
    due: task.dueAt,
    raisedBy: task.createdVia === 'system' ? 'Tierra Bot' : task.createdByName,
    createdAt: task.createdAt,
  }
}

/** "2026-10-12" (6 pm IST) or "2026-10-12T10:30" (IST) -> a Date; null when unreadable. */
export function dueFrom(value: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(value.trim())
  if (!match) return null
  const at = new Date(`${match[1]}T${match[2] ?? '18'}:${match[3] ?? '00'}:00+05:30`)
  return Number.isNaN(at.getTime()) ? null : at
}

export const taskTools = [
  defineTool({
    name: 'my_tasks',
    description:
      "The asker's open tasks: the ones they hold, the ones addressed to their role, and the ones they raised that others still have to do.",
    scope: 'internal',
    args: z.object({}),
    async run(ctx) {
      const me = speakerOf(ctx)
      const open = (await ctx.deps.store.listTasks()).filter(isOpenTask)
      const mine = open.filter((task) => task.assigneeId === me.userId)
      const myRole = open.filter((task) => task.assigneeRole === me.role && task.assigneeId !== me.userId)
      const waiting = open.filter((task) => task.createdBy === me.userId && task.assigneeId !== me.userId)
      return {
        holding: { total: mine.length, rows: mine.slice(0, 10).map(taskSummary) },
        forMyRole: { total: myRole.length, rows: myRole.slice(0, 10).map(taskSummary) },
        waitingOnOthers: { total: waiting.length, rows: waiting.slice(0, 10).map(taskSummary) },
      }
    },
  }),
  defineTool({
    name: 'create_task',
    description:
      'Add a task to the Tierra task board for a role (admin = Alex, manager = Joshy, procurement and the plant, office = paperwork and follow-ups). The holder gets a WhatsApp notice. It is created after your reply.',
    scope: 'internal',
    args: z.object({
      title: z.string().min(3).max(200).describe('Short imperative title, e.g. "Call Acme Cartons about PO 12"'),
      role: z.enum([...ROLES, ...(Object.keys(ROLE_ALIASES) as Array<keyof typeof ROLE_ALIASES & string>)] as [string, ...string[]]).describe('admin, manager or office (qa is the office)'),
      due: z.string().optional().describe('YYYY-MM-DD (6 pm IST) or YYYY-MM-DDTHH:mm in IST'),
      description: z.string().max(1000).optional(),
      category: z.enum(TASK_CATEGORIES).optional().describe('Defaults to operations'),
    }),
    async run(ctx, args) {
      const me = speakerOf(ctx)
      const role = roleFromName(args.role) ?? 'office'
      const dueAt = args.due ? dueFrom(args.due) : null
      if (args.due && !dueAt) return { error: 'due must be YYYY-MM-DD or YYYY-MM-DDTHH:mm' }
      const assignment = resolveAssignee(await ctx.deps.store.listAccountLinks(), { assigneeRole: role })
      const earlier = ctx.effects.filter((effect) => effect.kind === 'create_task').length
      ctx.effects.push({
        kind: 'create_task',
        input: {
          title: args.title.trim(),
          category: args.category ?? 'operations',
          assigneeRole: role,
          description: args.description?.trim() || null,
          dueAt,
          subjectType: 'wa_message',
          subjectId: earlier === 0 ? ctx.messageId : `${ctx.messageId}#${earlier + 1}`,
          createdVia: ctx.via,
          createdBy: me.userId,
        },
      })
      const holder = assignment?.holder
      return {
        queued: true,
        title: args.title.trim(),
        willBeHeldBy: holder ? `${holder.name} (${roleLabel(role).toLowerCase()})` : `the ${role} (nobody holds it yet)`,
        due: dueAt?.toISOString() ?? null,
      }
    },
  }),
  defineTool({
    name: 'complete_task',
    description: 'Mark one open task done, by its id from my_tasks. Only its holder or the admin may. It is done after your reply.',
    scope: 'internal',
    args: z.object({ task_id: z.string().min(1) }),
    async run(ctx, args) {
      const me = speakerOf(ctx)
      const task = await ctx.deps.store.getTask(args.task_id.trim())
      if (!task) return { error: `There is no task ${args.task_id}.` }
      if (!isOpenTask(task)) return { error: `"${task.title}" is already ${task.status}.` }
      if (!canFinish(task, me)) return { error: `Only ${task.assigneeName ?? 'its holder'} or the admin can finish "${task.title}".` }
      if (!ctx.effects.some((effect) => effect.kind === 'complete_task' && effect.taskId === task.id)) {
        ctx.effects.push({ kind: 'complete_task', taskId: task.id, title: task.title })
      }
      return { queued: true, title: task.title }
    },
  }),
  defineTool({
    name: 'factory_brief',
    description:
      "What is going on: open sales orders, finished goods short (more committed than on hand), the data day's dispatch and the open tasks.",
    scope: 'internal',
    args: z.object({}),
    async run(ctx) {
      return ctx.deps.dataBrief()
    },
  }),
]
