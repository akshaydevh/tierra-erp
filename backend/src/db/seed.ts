import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { hashPassword } from '../auth/password'
import * as schema from './schema'
import { seedUsers } from './seed-data'

type Database = PostgresJsDatabase<typeof schema>

export { DEV_PASSWORD } from './seed-data'

/** Demo accounts and the WhatsApp connection row. Business data comes from the SAP import. */
export async function seedIfEmpty(db: Database, password: string): Promise<void> {
  const existing = await db.select({ id: schema.users.id }).from(schema.users).limit(1)
  if (existing.length > 0) return
  const passwordHash = await hashPassword(password)
  await db.transaction(async (tx) => {
    await tx.insert(schema.users).values(
      seedUsers.map((user) => ({
        ...user,
        email: user.email.toLowerCase(),
        passwordHash,
      })),
    )
    await tx
      .insert(schema.whatsappConnection)
      .values({ id: 'default', instanceName: 'tierra', status: 'disconnected' })
      .onConflictDoNothing({ target: schema.whatsappConnection.id })
  })
}
