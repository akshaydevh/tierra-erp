import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { hashPassword } from '../auth/password'
import * as schema from './schema'
import {
  seedBalances,
  seedCustomers,
  seedItems,
  seedMaterialItems,
  seedOrders,
  seedUnits,
  seedUsers,
} from './seed-data'

type Database = PostgresJsDatabase<typeof schema>

export { DEV_PASSWORD } from './seed-data'

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
    await tx.insert(schema.customers).values(seedCustomers)
    await tx.insert(schema.items).values([...seedItems, ...seedMaterialItems])
    await tx.insert(schema.inventoryBalances).values(seedBalances)
    for (const order of seedOrders) {
      await tx.insert(schema.orders).values({
        id: order.id,
        customerId: order.customerId,
        poNumber: order.poNumber,
        poDate: order.poDate,
        status: order.status,
        source: order.source,
        createdAt: new Date(order.createdAt),
      })
      await tx.insert(schema.orderLines).values(
        order.lines.map((line) => ({
          id: line.id,
          orderId: order.id,
          itemId: line.itemId,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
        })),
      )
    }
    await tx.insert(schema.whatsappConnection).values({
      id: 'default',
      instanceName: 'tierra',
      status: 'disconnected',
    })
  })
}

export async function seedUnitsOfMeasure(db: Database): Promise<void> {
  await db.insert(schema.units).values(seedUnits).onConflictDoNothing({ target: schema.units.code })
}

export function missingBalances<T extends { customerId: string | null; itemId: string }>(
  wanted: T[],
  existing: Array<{ customerId: string | null; itemId: string }>,
): T[] {
  const owned = new Set(existing.map((row) => `${row.customerId ?? ''}:${row.itemId}`))
  return wanted.filter((row) => !owned.has(`${row.customerId ?? ''}:${row.itemId}`))
}

export async function seedCustomerMaterials(db: Database): Promise<void> {
  await db.insert(schema.customers).values(seedCustomers).onConflictDoNothing({ target: schema.customers.id })
  await db
    .insert(schema.items)
    .values([...seedItems, ...seedMaterialItems])
    .onConflictDoNothing({ target: schema.items.id })
  const existing = await db
    .select({
      customerId: schema.inventoryBalances.customerId,
      itemId: schema.inventoryBalances.itemId,
    })
    .from(schema.inventoryBalances)
  const missing = missingBalances(seedBalances, existing)
  if (missing.length === 0) return
  await db.insert(schema.inventoryBalances).values(missing).onConflictDoNothing({ target: schema.inventoryBalances.id })
}
