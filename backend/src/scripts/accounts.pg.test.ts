import { afterAll, describe, expect, it } from 'vitest'
import { verifyPassword } from '../auth/password'
import { seedIfEmpty } from '../db/seed'
import { connect, runMigrations, startPostgres } from '../test/postgres'
import { createAdmin, setPassword } from './accounts'

const harness = await startPostgres()
if (harness.skipReason) console.warn(harness.skipReason)
const pg = harness.postgres

describe.skipIf(!pg)('account scripts on Postgres 18', () => {
  afterAll(async () => {
    await pg?.stop()
  })

  it('creates the first admin on an empty database and only then', async () => {
    const url = await pg!.createDatabase('empty')
    await runMigrations(url)
    const conn = connect(url)
    try {
      expect(await createAdmin(conn.db, { email: ' Owner@Tierra.in ', name: 'Owner', password: 'first-pass-1' })).toBe(
        'created',
      )
      const owner = await conn.store.findUserByEmail('owner@tierra.in')
      expect(owner).toMatchObject({ name: 'Owner', role: 'admin' })
      expect(await verifyPassword('first-pass-1', owner!.passwordHash)).toBe(true)
      expect(await createAdmin(conn.db, { email: 'second@tierra.in', name: 'Second', password: 'second-pass' })).toBe(
        'admin_exists',
      )
    } finally {
      await conn.close()
    }
  })

  it('sets a password and signs the user out', async () => {
    const url = await pg!.createDatabase('seeded')
    await runMigrations(url)
    const conn = connect(url)
    try {
      await seedIfEmpty(conn.db, 'old-password')
      await conn.store.createSession({ userId: 'usr_anju', tokenHash: 'hash-1', expiresAt: new Date(Date.now() + 60_000) })
      expect(await setPassword(conn.db, 'ANJU@tierra.test', 'new-password')).toBe('Anju')
      const anju = await conn.store.findUserByEmail('anju@tierra.test')
      expect(await verifyPassword('new-password', anju!.passwordHash)).toBe(true)
      expect(await conn.store.findUserByTokenHash('hash-1', new Date())).toBeNull()
      expect(await setPassword(conn.db, 'nobody@tierra.test', 'new-password')).toBeNull()
      expect(await createAdmin(conn.db, { email: 'x@tierra.in', name: 'X', password: 'x-password' })).toBe('admin_exists')
    } finally {
      await conn.close()
    }
  })
})
