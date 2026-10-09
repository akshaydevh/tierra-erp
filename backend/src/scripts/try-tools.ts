/**
 * Calls agent tools straight against a database, without a model: `npm run try-tools [-- --calls <file>]`.
 *
 * For checking the tools on the real import. The calls (real document numbers, PANs) live outside the repo, by
 * default in ~/tierra-data/evals/try-tools.yaml:
 *
 *   party: { name: Acme Retail, pans: [AAACA0000A], card_codes: [] }
 *   calls:
 *     - tool: customer_po_status
 *       args: { customer_po_no: "4400012345" }
 *       scopes: [internal, party]          # default: both
 *
 * Every call runs in internal scope (an admin) and/or in the party scope of a temporary party group made from
 * `party`, created for the run and deleted afterwards. Results are printed as the model would see them (the same
 * 4 KB cap). Side-effect tools only queue; nothing is created or completed. The database is migrated first.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { parse } from 'yaml'
import { z } from 'zod'
import type { AgentDeps } from '../agent/deps'
import { istToday } from '../agent/refs'
import { buildAudience, cardsFor, type Audience } from '../agent/scope'
import { runToolCall, toolsFor, type ToolContext } from '../agent/tools'
import { DrizzleStore } from '../db/drizzle-store'
import { migrate } from '../db/migrate'
import * as schema from '../db/schema'
import { holderForRole } from '../domain/routing'
import { loadEnv } from '../env'
import { dataBrief } from '../queries/brief'
import { importMeta } from '../queries/meta'
import type { EvolutionClient } from '../whatsapp/evolution'

const fileSchema = z.object({
  party: z.object({
    name: z.string().min(1),
    pans: z.array(z.string()).default([]),
    card_codes: z.array(z.string()).default([]),
  }),
  calls: z.array(
    z.object({
      tool: z.string(),
      args: z.record(z.unknown()).default({}),
      scopes: z.array(z.enum(['internal', 'party'])).default(['internal', 'party']),
    }),
  ),
})

const TRY_GROUP_JID = 'try-tools@g.us'

async function main(): Promise<number> {
  const index = process.argv.indexOf('--calls')
  const file = (index >= 0 ? process.argv[index + 1] : null) ?? join(homedir(), 'tierra-data', 'evals', 'try-tools.yaml')
  const parsed = fileSchema.safeParse(parse(readFileSync(file, 'utf8')))
  if (!parsed.success) {
    console.error(`${file}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
    return 2
  }
  const env = loadEnv()
  const sql = postgres(env.databaseUrl, { max: 4, connection: { TimeZone: 'Asia/Kolkata' }, onnotice: () => {} })
  await migrate(sql)
  const store = new DrizzleStore(drizzle(sql, { schema }))
  const deps: AgentDeps = {
    store,
    evolution: {} as EvolutionClient,
    sapSql: sql,
    readPurchaseOrder: async () => ({ kind: 'not_po', reason: 'not used here' }),
    dataBrief: () => dataBrief(sql, store),
    chatModel: async () => {
      throw new Error('try-tools never calls the model')
    },
    enqueue: async () => false,
    botMode: env.botMode,
    now: () => new Date(),
  }
  const admin = holderForRole(await store.listAccountLinks(), 'admin')
  const internal: Audience = {
    kind: 'internal',
    userId: admin?.id ?? 'try-tools',
    name: admin?.name ?? 'Try tools',
    role: 'admin',
  }
  const party = await store.createPartyGroup({
    name: `${parsed.data.party.name} (try-tools ${Date.now()})`,
    members: [
      ...parsed.data.party.pans.map((value) => ({ kind: 'pan' as const, value })),
      ...parsed.data.party.card_codes.map((value) => ({ kind: 'card_code' as const, value })),
    ],
  })
  try {
    await store.saveWaGroup(TRY_GROUP_JID, { subject: 'try-tools', partyGroupId: party.id })
    const partyAudience = await buildAudience(deps, { chatKind: 'group', remoteJid: TRY_GROUP_JID, speaker: null })
    if (partyAudience.kind !== 'party') throw new Error('The temporary group did not map to the party')
    console.log(`Party group ${party.name}: ${partyAudience.cardCodes.length} SAP card(s)\n`)
    const dataAsOf = (await importMeta(sql)).dataAsOf
    for (const call of parsed.data.calls) {
      for (const scope of call.scopes) {
        const audience = scope === 'internal' ? internal : partyAudience
        const ctx: ToolContext = {
          deps,
          audience,
          cards: cardsFor(audience),
          dataAsOf,
          referenceDay: dataAsOf ?? istToday(new Date()),
          messageId: `try-tools-${Date.now()}`,
          via: 'whatsapp',
          effects: [],
        }
        const run = await runToolCall(ctx, toolsFor(audience), {
          id: 'try',
          type: 'function',
          function: { name: call.tool, arguments: JSON.stringify(call.args) },
        })
        console.log(`== ${call.tool} ${JSON.stringify(call.args)} [${scope}]`)
        console.log(JSON.stringify(JSON.parse(run.result), null, 1).slice(0, 2500))
        console.log()
      }
    }
    return 0
  } finally {
    await store.deletePartyGroup(party.id)
    await sql`delete from wa_groups where jid = ${TRY_GROUP_JID}`
    console.log(`Deleted the temporary party group ${party.name}.`)
    await sql.end({ timeout: 5 })
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
