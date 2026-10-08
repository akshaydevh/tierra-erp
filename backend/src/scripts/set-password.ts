import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { hashPassword } from '../auth/password'
import * as schema from '../db/schema'
import { loadEnv } from '../env'

async function main(): Promise<number> {
  const [email, password] = process.argv.slice(2)
  if (!email || !password) {
    console.error('Usage: npm run set-password -- <email> <password>')
    return 2
  }
  const sql = postgres(loadEnv().databaseUrl, { max: 1 })
  try {
    const db = drizzle(sql, { schema })
    const updated = await db
      .update(schema.users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(schema.users.email, email.trim().toLowerCase()))
      .returning({ id: schema.users.id, name: schema.users.name })
    if (updated.length === 0) {
      console.error(`No user with email ${email}`)
      return 1
    }
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, updated[0].id))
    console.log(`Password updated for ${updated[0].name} (${email}); existing sessions signed out`)
    return 0
  } finally {
    await sql.end()
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  },
)
