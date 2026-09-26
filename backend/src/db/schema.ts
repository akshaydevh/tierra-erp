import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  customType,
  date,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
  toDriver(value: Buffer) {
    return value
  },
  fromDriver(value: unknown) {
    if (Buffer.isBuffer(value)) return value
    if (value instanceof Uint8Array) return Buffer.from(value)
    if (typeof value === 'string') return Buffer.from(value.replace(/^\\x/, ''), 'hex')
    throw new Error('Unexpected bytea value')
  },
})

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('users_role_check', sql`${table.role} in ('admin', 'office')`)],
)

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const customers = pgTable('customers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  code: text('code').notNull().unique(),
})

export const items = pgTable('items', {
  id: text('id').primaryKey(),
  sku: text('sku').notNull().unique(),
  name: text('name').notNull(),
  unit: text('unit').notNull(),
})

export const inventoryBalances = pgTable('inventory_balances', {
  itemId: text('item_id')
    .primaryKey()
    .references(() => items.id),
  onHand: integer('on_hand').notNull(),
})

export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    poNumber: text('po_number').notNull(),
    poDate: date('po_date'),
    status: text('status').notNull(),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('orders_status_check', sql`${table.status} in ('open', 'closed')`),
    check('orders_source_check', sql`${table.source} in ('seed', 'whatsapp')`),
  ],
)

export const orderLines = pgTable('order_lines', {
  id: text('id').primaryKey(),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  itemId: text('item_id')
    .notNull()
    .references(() => items.id),
  description: text('description').notNull(),
  quantity: integer('quantity').notNull(),
  unit: text('unit').notNull(),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }),
})

export const orderDocuments = pgTable('order_documents', {
  id: text('id').primaryKey(),
  orderId: text('order_id').references(() => orders.id, { onDelete: 'set null' }),
  messageId: text('message_id'),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  content: bytea('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const whatsappConnection = pgTable(
  'whatsapp_connection',
  {
    id: text('id').primaryKey(),
    instanceName: text('instance_name').notNull(),
    status: text('status').notNull(),
    qrBase64: text('qr_base64'),
    phoneNumber: text('phone_number'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'whatsapp_connection_status_check',
      sql`${table.status} in ('disconnected', 'qr_pending', 'connected')`,
    ),
  ],
)

export const whatsappMessages = pgTable('whatsapp_messages', {
  id: text('id').primaryKey(),
  evolutionMessageId: text('evolution_message_id').notNull().unique(),
  remoteJid: text('remote_jid').notNull(),
  fromMe: boolean('from_me').notNull(),
  hasPdf: boolean('has_pdf').notNull(),
  body: text('body'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const availabilitySql = sql`
  select i.id as item_id,
         b.on_hand::int as on_hand,
         coalesce(sum(l.quantity) filter (where o.status = 'open'), 0)::int as reserved
  from items i
  join inventory_balances b on b.item_id = i.id
  left join order_lines l on l.item_id = i.id
  left join orders o on o.id = l.order_id
  group by i.id, b.on_hand
`
