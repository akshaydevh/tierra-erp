import { TypeSafeClient, choice } from '@typesafe-ai/sdk'
import { TASK_CATEGORIES, type TaskCategory } from '../db/types'

export type TaskExtraction = {
  title: string | null
  category: TaskCategory | null
  assigneeName: string | null
  assigneeUnknown: boolean
}

export type TaskExtractInput = {
  text: string
  quotedText: string | null
  accountNames: string[]
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

const CONFIDENCE_FLOOR = 0.5

export function createExtractTask(env: {
  typesafeApiKey: string
}): (input: TaskExtractInput) => Promise<TaskExtraction> {
  return async (input) => {
    const title = input.text.trim() || input.quotedText?.trim() || null
    if (!env.typesafeApiKey) {
      return { title, category: null, assigneeName: null, assigneeUnknown: false }
    }
    const names = [...new Set(input.accountNames.map((name) => name.trim()).filter(Boolean))]
    const assigneeCriteria: Record<string, string> = {
      unassigned: 'The message does not name anyone to do the task.',
      unknown: 'The message names a person who is not one of the Tierra accounts.',
    }
    for (const name of names) assigneeCriteria[name] = `${name} should do this task.`
    const client = new TypeSafeClient({ apiKey: env.typesafeApiKey })
    const response = await client.systemOne({
      state: {
        text: input.text,
        quotedText: input.quotedText,
        accounts: names,
      },
      questions: {
        category: choice(
          'Which category does this task belong to? Choose missing when the message does not state administration, operations, quality, procurement, production, dispatch, or finance.',
          CATEGORY_CRITERIA,
        ),
        assignee: choice(
          'Who should do this task? Choose unassigned when nobody is named. Choose unknown when a person is named who is not a Tierra account. Otherwise choose that account name.',
          assigneeCriteria,
        ),
      },
    })
    const categoryChoice = response.answers.category.choice
    const category =
      categoryChoice === 'missing' || response.answers.category.confidence < CONFIDENCE_FLOOR
        ? null
        : categoryChoice
    const assigneeChoice = response.answers.assignee.choice
    const assigneeUnclear = response.answers.assignee.confidence < CONFIDENCE_FLOOR
    const assigneeUnknown = assigneeChoice === 'unknown' || (assigneeUnclear && assigneeChoice !== 'unassigned')
    const assigneeName =
      assigneeUnknown || assigneeChoice === 'unassigned' || assigneeChoice === 'unknown' ? null : assigneeChoice
    if (category && !(TASK_CATEGORIES as readonly string[]).includes(category)) {
      return { title, category: null, assigneeName, assigneeUnknown }
    }
    return { title, category, assigneeName, assigneeUnknown }
  }
}
