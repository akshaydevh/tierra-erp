import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { hashPassword } from '../auth/password'
import * as schema from '../db/schema'

type Database = PostgresJsDatabase<typeof schema>

export const MIN_PASSWORD_LENGTH = 8

export class PasswordInputError extends Error {}

async function firstLine(input: Readable): Promise<string> {
  const lines = createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    lines.close()
    return line
  }
  return ''
}

/**
 * The new password comes from NEW_PASSWORD or one line on stdin, never from the command line:
 * arguments end up in shell history and in the process list.
 */
export async function readPassword(input: {
  argvPassword: string | undefined
  envPassword: string | undefined
  stdin: Readable
}): Promise<string> {
  if (input.argvPassword !== undefined) {
    throw new PasswordInputError(
      'Do not put the password on the command line, where shell history and the process list keep it. ' +
        'Set NEW_PASSWORD or type it when asked.',
    )
  }
  const password = input.envPassword || (await firstLine(input.stdin))
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordInputError(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`)
  }
  return password
}

/** Sets the password and signs the user out everywhere. Returns the user's name, or null when no such email. */
export async function setPassword(db: Database, email: string, password: string): Promise<string | null> {
  const [updated] = await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(schema.users.email, email.trim().toLowerCase()))
    .returning({ id: schema.users.id, name: schema.users.name })
  if (!updated) return null
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, updated.id))
  return updated.name
}

/** Creates the first admin on an empty install. Refuses when there is already an admin or the email is taken. */
export async function createAdmin(
  db: Database,
  input: { email: string; name: string; password: string },
): Promise<'created' | 'admin_exists' | 'email_taken'> {
  const email = input.email.trim().toLowerCase()
  const passwordHash = await hashPassword(input.password)
  return db.transaction(async (tx) => {
    const [admin] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, 'admin'))
    if (admin) return 'admin_exists'
    const [taken] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email))
    if (taken) return 'email_taken'
    await tx.insert(schema.users).values({
      id: `usr_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      email,
      name: input.name.trim(),
      role: 'admin',
      passwordHash,
    })
    return 'created'
  })
}

export function promptForPassword(): void {
  if (!process.env.NEW_PASSWORD && process.stdin.isTTY) process.stderr.write('New password: ')
}
