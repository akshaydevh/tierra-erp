import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '../db/schema'
import { loadEnv } from '../env'
import { PasswordInputError, createAdmin, promptForPassword, readPassword } from './accounts'

async function main(): Promise<number> {
  const [email, name, argvPassword] = process.argv.slice(2)
  if (!email || !name) {
    console.error('Usage: npm run create-admin -- <email> <name>   (password from NEW_PASSWORD or stdin)')
    return 2
  }
  promptForPassword()
  const password = await readPassword({ argvPassword, envPassword: process.env.NEW_PASSWORD, stdin: process.stdin })
  const sql = postgres(loadEnv().databaseUrl, { max: 1 })
  try {
    const result = await createAdmin(drizzle(sql, { schema }), { email, name, password })
    if (result === 'admin_exists') {
      console.error('There is already an admin. Sign in as them and change roles from Settings.')
      return 1
    }
    if (result === 'email_taken') {
      console.error(`${email} already has an account`)
      return 1
    }
    console.log(`Created ${name} (${email}) as the admin`)
    return 0
  } finally {
    await sql.end()
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(error instanceof PasswordInputError ? 2 : 1)
  },
)
