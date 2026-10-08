import { TypeSafeClient, choice } from '@typesafe-ai/sdk'
import { ROLES, TASK_CATEGORIES, type Role, type TaskCategory } from '../db/types'
import { TYPESAFE_TIMEOUT_MS, withTimeout } from './timeout'

export type TaskExtraction = {
  title: string | null
  category: TaskCategory | null
  assigneeRole: Role | null
  assigneeUnknown: boolean
}

export type TaskExtractInput = {
  text: string
  quotedText: string | null
  /** Current role holders; their names are aliases for the role. */
  accounts: Array<{ name: string; role: Role }>
}

const CATEGORY_CRITERIA = {
  administration: 'Office, HR, or general administration.',
  operations: 'Day-to-day plant operations.',
  quality: 'Quality checks, batch release, or QC.',
  procurement: 'Buying materials, banana, or vendor follow-up.',
  production: 'A production run, recipe, or the packing floor.',
  dispatch: 'Loading, trips, or finished goods leaving the plant.',
  finance: 'Payments, costing, or accounts.',
  missing: 'The message does not state one of those categories.',
} as const

const ROLE_CRITERIA: Record<Role, string> = {
  admin: 'The admin, the owner who runs the company, should do this task.',
  manager: 'The manager (general manager), who runs the plant and owns procurement, should do this task.',
  office: 'The office staff, who handle paperwork, data entry, and follow-ups, should do this task.',
}

const CONFIDENCE_FLOOR = 0.5

export function roleCriteria(accounts: TaskExtractInput['accounts']): Record<string, string> {
  const criteria: Record<string, string> = {
    unassigned: 'The message does not name anyone or any role to do the task.',
    unknown: 'The message names a person who is not one of the Tierra accounts below.',
  }
  for (const role of ROLES) {
    const names = [...new Set(accounts.filter((account) => account.role === role).map((account) => account.name.trim()))]
      .filter(Boolean)
    criteria[role] = names.length > 0 ? `${ROLE_CRITERIA[role]} Also called: ${names.join(', ')}.` : ROLE_CRITERIA[role]
  }
  return criteria
}

function asRoleChoice(value: string): Role | null {
  return (ROLES as readonly string[]).includes(value) ? (value as Role) : null
}

export function createExtractTask(env: {
  typesafeApiKey: string
}): (input: TaskExtractInput) => Promise<TaskExtraction> {
  return async (input) => {
    const title = input.text.trim() || input.quotedText?.trim() || null
    if (!env.typesafeApiKey) {
      return { title, category: null, assigneeRole: null, assigneeUnknown: false }
    }
    const client = new TypeSafeClient({ apiKey: env.typesafeApiKey })
    const response = await withTimeout(
      client.systemOne({
        state: {
          text: input.text,
          quotedText: input.quotedText,
          accounts: input.accounts.map((account) => ({ name: account.name, role: account.role })),
        },
        questions: {
          category: choice(
            'Which category does this task belong to? Choose missing when the message does not state administration, operations, quality, procurement, production, dispatch, or finance.',
            CATEGORY_CRITERIA,
          ),
          assignee: choice(
            'Which role should do this task? A person’s name stands for the role they hold. Choose unassigned when nobody is named. Choose unknown when a person is named who is not a Tierra account.',
            roleCriteria(input.accounts),
          ),
        },
      }),
      TYPESAFE_TIMEOUT_MS,
      'The task reader',
    )
    const categoryChoice = response.answers.category.choice
    const category =
      categoryChoice === 'missing' || response.answers.category.confidence < CONFIDENCE_FLOOR
        ? null
        : categoryChoice
    const assigneeChoice = response.answers.assignee.choice
    const assigneeUnclear = response.answers.assignee.confidence < CONFIDENCE_FLOOR
    const assigneeUnknown = assigneeChoice === 'unknown' || (assigneeUnclear && assigneeChoice !== 'unassigned')
    const assigneeRole = assigneeUnknown ? null : asRoleChoice(assigneeChoice)
    if (category && !(TASK_CATEGORIES as readonly string[]).includes(category)) {
      return { title, category: null, assigneeRole, assigneeUnknown }
    }
    return { title, category, assigneeRole, assigneeUnknown }
  }
}
