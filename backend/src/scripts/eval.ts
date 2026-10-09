/**
 * Live agent eval: `npm run eval [-- --cases <file>] [--only <id,id>]`.
 *
 * Runs each case in ~/tierra-data/evals/cases.real.yaml through the real pre-resolver, tools and model
 * (OPENAI_AGENT_MODEL) against the database in DATABASE_URL, and prints pass/fail. It is a gate to run by hand or
 * nightly, not a CI test: it costs model calls and reads real data, which therefore stays outside the repo. Side
 * effects (create_task, complete_task) are recorded, never carried out. Each run's transcripts (the prompt log) go
 * to ~/tierra-data/evals/runs/.
 *
 * A case:
 *   - id: free-stock-100g
 *     as: admin                 # admin | manager | office (internal), or public
 *     party: { name: Acme Retail, pans: [AAACA0000A], card_codes: [] }   # instead of `as`: a customer group
 *     ask: how many Tierra 100g chips are free?
 *     must_contain: [FGABC100, "167"]          # every one, in the reply (case and Indian commas ignored)
 *     must_contain_any: [not found, cannot]    # at least one, in the reply
 *     must_not_contain: ["1,175"]              # none, in the reply
 *     tools: [free_stock]                       # each must have been called
 *     no_tools: true                            # no tool may be offered
 *     seen_must_not_contain: [Other Foods, C9999] # none, anywhere the model saw (prompt, references, tool results)
 *     effects: [create_task]                    # side effects that must have been queued
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { parse } from 'yaml'
import { z } from 'zod'
import type { AgentDeps } from '../agent/deps'
import { createChatModel } from '../agent/llm'
import { answerTurn } from '../agent/route'
import { partyCardCodes, type Audience } from '../agent/scope'
import { toolsFor } from '../agent/tools'
import { DrizzleStore } from '../db/drizzle-store'
import * as schema from '../db/schema'
import { ROLES } from '../db/types'
import { holderForRole } from '../domain/routing'
import { loadEnv } from '../env'
import { dataBrief } from '../queries/brief'
import type { EvolutionClient } from '../whatsapp/evolution'
import type { IncomingMessage } from '../whatsapp/parse'
import type { Person } from '../whatsapp/people'

const caseSchema = z
  .object({
    id: z.string().min(1),
    as: z.enum([...ROLES, 'public']).optional(),
    party: z
      .object({ name: z.string(), pans: z.array(z.string()).default([]), card_codes: z.array(z.string()).default([]) })
      .optional(),
    ask: z.string().min(1),
    must_contain: z.array(z.coerce.string()).default([]),
    must_contain_any: z.array(z.coerce.string()).default([]),
    must_not_contain: z.array(z.coerce.string()).default([]),
    tools: z.array(z.string()).default([]),
    no_tools: z.boolean().default(false),
    seen_must_not_contain: z.array(z.coerce.string()).default([]),
    effects: z.array(z.string()).default([]),
  })
  .refine((value) => Boolean(value.as) !== Boolean(value.party), { message: 'give exactly one of as or party' })

type EvalCase = z.infer<typeof caseSchema>

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index >= 0 ? (process.argv[index + 1] ?? null) : null
}

/** Case-insensitive, and 1,175 matches 1175 (and the other way round). */
function contains(haystack: string, needle: string): boolean {
  const plain = (value: string) => value.toLowerCase().replace(/(\d),(?=\d)/g, '$1')
  return plain(haystack).includes(plain(needle))
}

const noWhatsapp = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error('The eval never talks to WhatsApp')
    },
  },
) as EvolutionClient

async function main(): Promise<number> {
  const env = loadEnv()
  if (!env.openaiApiKey) {
    console.error('OPENAI_API_KEY is not set (backend/.env or the environment). The live eval needs the real model; nothing was run.')
    return 2
  }
  const casesFile = argValue('--cases') ?? process.env.EVAL_CASES ?? join(homedir(), 'tierra-data', 'evals', 'cases.real.yaml')
  let raw: unknown
  try {
    raw = parse(readFileSync(casesFile, 'utf8'))
  } catch (error) {
    console.error(`Could not read ${casesFile}: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const parsed = z.array(caseSchema).safeParse(raw)
  if (!parsed.success) {
    console.error(`${casesFile} is not a list of eval cases: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
    return 2
  }
  const only = argValue('--only')?.split(',')
  const cases = only ? parsed.data.filter((item) => only.includes(item.id)) : parsed.data

  const sql = postgres(env.databaseUrl, { max: 4, connection: { TimeZone: 'Asia/Kolkata' }, onnotice: () => {} })
  const store = new DrizzleStore(drizzle(sql, { schema }))
  const deps: AgentDeps = {
    store,
    evolution: noWhatsapp,
    sapSql: sql,
    readPurchaseOrder: async () => ({ kind: 'not_po', reason: 'not used here' }),
    dataBrief: () => dataBrief(sql, store),
    chatModel: createChatModel(env),
    enqueue: async () => false,
    botMode: env.botMode,
    now: () => new Date(),
  }
  const accounts = await store.listAccountLinks()
  const runs: unknown[] = []
  let failed = 0
  console.log(`Live eval: ${cases.length} case(s) from ${casesFile}, model ${env.openaiAgentModel}\n`)
  try {
    for (const item of cases) {
      const { audience, speaker } = await audienceFor(item, accounts, sql)
      const message: IncomingMessage = {
        id: `eval-${item.id}-${Date.now()}`,
        remoteJid: `eval:${item.id}`,
        fromMe: false,
        text: item.ask,
        quotedText: null,
        quotedId: null,
        quotedParticipant: null,
        mentionedJids: [],
        participantJid: null,
        participantAltJid: null,
        aliasJid: null,
        control: false,
        kind: 'text',
        reaction: null,
        pdf: null,
        raw: null,
        embeddedBase64: null,
      }
      const started = Date.now()
      const result = await answerTurn(deps, { message, speaker, audience, text: item.ask, quotedText: null })
      const seen = JSON.stringify(result.messages)
      const called = result.toolRuns.map((run) => run.name)
      const problems: string[] = []
      if (result.status !== 'answered') problems.push(`status ${result.status}`)
      for (const needle of item.must_contain) if (!contains(result.text, needle)) problems.push(`reply lacks "${needle}"`)
      if (item.must_contain_any.length > 0 && !item.must_contain_any.some((needle) => contains(result.text, needle))) {
        problems.push(`reply has none of ${item.must_contain_any.map((needle) => `"${needle}"`).join(', ')}`)
      }
      for (const needle of item.must_not_contain) if (contains(result.text, needle)) problems.push(`reply has "${needle}"`)
      for (const tool of item.tools) if (!called.includes(tool)) problems.push(`${tool} was not called`)
      if (item.no_tools && (called.length > 0 || toolsFor(audience).length > 0)) {
        problems.push(`tools were available or called (${called.join(', ') || toolsFor(audience).length})`)
      }
      for (const needle of item.seen_must_not_contain) if (contains(seen, needle)) problems.push(`the model saw "${needle}"`)
      const queued = result.effects.map((effect) => effect.kind)
      for (const effect of item.effects) if (!queued.includes(effect as never)) problems.push(`${effect} was not queued`)
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      if (problems.length > 0) failed += 1
      console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'}  ${item.id}  (${seconds} s, ${result.rounds} round(s), tools: ${called.join(', ') || 'none'})`)
      console.log(`      ${result.text.replace(/\n/g, '\n      ')}`)
      for (const problem of problems) console.log(`      ✗ ${problem}`)
      runs.push({ id: item.id, ask: item.ask, audience, status: result.status, problems, reply: result.text, toolRuns: result.toolRuns, effects: result.effects, messages: result.messages })
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
  const dir = join(homedir(), 'tierra-data', 'evals', 'runs')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, JSON.stringify({ model: env.openaiAgentModel, cases: runs }, null, 2))
  console.log(`\n${cases.length - failed}/${cases.length} passed. Transcripts: ${file}`)
  return failed > 0 ? 1 : 0
}

async function audienceFor(
  item: EvalCase,
  accounts: Awaited<ReturnType<DrizzleStore['listAccountLinks']>>,
  sql: postgres.Sql,
): Promise<{ audience: Audience; speaker: Person | null }> {
  if (item.party) {
    return {
      speaker: null,
      audience: {
        kind: 'party',
        partyGroupId: `eval-${item.party.name}`,
        name: item.party.name,
        pans: item.party.pans,
        cardCodes: await partyCardCodes(sql, item.party.pans, item.party.card_codes),
        groupSubject: `${item.party.name} – Tierra`,
        speakerName: null,
      },
    }
  }
  if (item.as === 'public' || !item.as) return { speaker: null, audience: { kind: 'public', reason: 'unknown_sender' } }
  const holder = holderForRole(accounts, item.as)
  const speaker: Person = {
    userId: holder?.id ?? `eval-${item.as}`,
    name: holder?.name ?? `Eval ${item.as}`,
    role: item.as,
    phoneNumber: holder?.phoneNumber ?? '',
  }
  return { speaker, audience: { kind: 'internal', userId: speaker.userId, name: speaker.name, role: item.as } }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
