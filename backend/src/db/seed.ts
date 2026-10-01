import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { hashPassword } from '../auth/password'
import * as schema from './schema'
import {
  DEV_PASSWORD,
  seedBalances,
  seedCustomers,
  seedItems,
  seedMaterialItems,
  seedOrders,
  seedUsers,
} from './seed-data'

type Database = PostgresJsDatabase<typeof schema>

export async function seedIfEmpty(db: Database): Promise<void> {
  const existing = await db.select({ id: schema.users.id }).from(schema.users).limit(1)
  if (existing.length > 0) return
  const passwordHash = await hashPassword(DEV_PASSWORD)
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

export async function seedCustomerMaterials(db: Database): Promise<void> {
  await db.insert(schema.items).values(seedMaterialItems).onConflictDoNothing({ target: schema.items.id })
  await db
    .insert(schema.inventoryBalances)
    .values(seedBalances.filter((row) => row.customerId))
    .onConflictDoNothing({ target: schema.inventoryBalances.id })
}
