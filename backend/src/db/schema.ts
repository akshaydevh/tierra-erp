import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
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
  (table) => [
    check('users_role_check', sql`${table.role} in ('admin', 'manager', 'office')`),
    uniqueIndex('users_single_admin').on(table.role).where(sql`${table.role} = 'admin'`),
  ],
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

export const units = pgTable('units', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
})

export const items = pgTable(
  'items',
  {
    id: text('id').primaryKey(),
    sku: text('sku').notNull().unique(),
    name: text('name').notNull(),
    unit: text('unit').notNull(),
    kind: text('kind').notNull(),
  },
  (table) => [
    check(
      'items_kind_check',
      sql`${table.kind} in ('finished_good', 'laminate', 'seasoning', 'carton', 'raw_material')`,
    ),
  ],
)

export const inventoryBalances = pgTable(
  'inventory_balances',
  {
    id: text('id').primaryKey(),
    customerId: text('customer_id').references(() => customers.id),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    onHand: integer('on_hand').notNull(),
  },
  (table) => [
    uniqueIndex('inventory_balances_plant_item')
      .on(table.itemId)
      .where(sql`${table.customerId} is null`),
    uniqueIndex('inventory_balances_customer_item')
      .on(table.customerId, table.itemId)
      .where(sql`${table.customerId} is not null`),
  ],
)

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
    check('orders_source_check', sql`${table.source} in ('seed', 'whatsapp', 'desk')`),
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

export const productionEntries = pgTable('production_entries', {
  id: text('id').primaryKey(),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  finishedGoodsKg: numeric('finished_goods_kg', { precision: 14, scale: 3 }).notNull(),
  kgBananaPerKgChips: numeric('kg_banana_per_kg_chips', { precision: 8, scale: 3 }).notNull(),
  bananaKg: numeric('banana_kg', { precision: 14, scale: 3 }).notNull(),
  sourceMonths: text('source_months').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const pendingOrders = pgTable(
  'pending_orders',
  {
    id: text('id').primaryKey(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    poNumber: text('po_number').notNull(),
    poDate: date('po_date'),
    remoteJid: text('remote_jid').notNull(),
    documentId: text('document_id'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'pending_orders_status_check',
      sql`${table.status} in ('awaiting_admin', 'confirmed', 'declined')`,
    ),
  ],
)

export const pendingOrderLines = pgTable('pending_order_lines', {
  id: text('id').primaryKey(),
  pendingOrderId: text('pending_order_id')
    .notNull()
    .references(() => pendingOrders.id, { onDelete: 'cascade' }),
  itemId: text('item_id')
    .notNull()
    .references(() => items.id),
  description: text('description').notNull(),
  quantity: integer('quantity').notNull(),
  unit: text('unit').notNull(),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }),
})

export const procurementOrders = pgTable('procurement_orders', {
  id: text('id').primaryKey(),
  orderId: text('order_id').references(() => orders.id, { onDelete: 'cascade' }),
  productionEntryId: text('production_entry_id').references(() => productionEntries.id, {
    onDelete: 'cascade',
  }),
  pendingOrderId: text('pending_order_id').references(() => pendingOrders.id, { onDelete: 'cascade' }),
  itemId: text('item_id')
    .notNull()
    .references(() => items.id),
  quantityKg: numeric('quantity_kg', { precision: 14, scale: 3 }).notNull(),
  unit: text('unit').notNull(),
  assigneeId: text('assignee_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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

export const accountRelations = pgTable('account_relations', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  phoneNumber: text('phone_number').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    category: text('category').notNull(),
    status: text('status').notNull().default('todo'),
    assigneeId: text('assignee_id').references(() => users.id),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind').notNull().default('todo'),
    assigneeRole: text('assignee_role'),
    description: text('description'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    waMessageId: text('wa_message_id'),
    createdVia: text('created_via').notNull().default('dashboard'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'tasks_category_check',
      sql`${table.category} in ('administration', 'operations', 'quality', 'procurement', 'production', 'dispatch', 'finance')`,
    ),
    check('tasks_status_check', sql`${table.status} in ('todo', 'doing', 'done', 'cancelled')`),
    check(
      'tasks_kind_check',
      sql`${table.kind} in ('todo', 'procurement', 'approval', 'data_entry', 'customer_followup', 'review')`,
    ),
    check(
      'tasks_assignee_role_check',
      sql`${table.assigneeRole} is null or ${table.assigneeRole} in ('admin', 'manager', 'office')`,
    ),
    check('tasks_created_via_check', sql`${table.createdVia} in ('dashboard', 'whatsapp', 'desk', 'system')`),
    uniqueIndex('tasks_subject_kind')
      .on(table.subjectType, table.subjectId, table.kind)
      .where(sql`${table.subjectType} is not null and ${table.status} <> 'cancelled'`),
    index('tasks_wa_message').on(table.waMessageId),
  ],
)

export const whatsappMessages = pgTable(
  'whatsapp_messages',
  {
    id: text('id').primaryKey(),
    evolutionMessageId: text('evolution_message_id').notNull().unique(),
    remoteJid: text('remote_jid').notNull(),
    fromMe: boolean('from_me').notNull(),
    hasPdf: boolean('has_pdf').notNull(),
    body: text('body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    senderJid: text('sender_jid'),
    quotedId: text('quoted_id'),
    kind: text('kind').notNull().default('text'),
    purpose: text('purpose'),
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    status: text('status'),
    idempotencyKey: text('idempotency_key').unique(),
  },
  (table) => [
    check('whatsapp_messages_kind_check', sql`${table.kind} in ('text', 'document', 'image', 'reaction', 'other')`),
    check(
      'whatsapp_messages_status_check',
      sql`${table.status} is null or ${table.status} in ('received', 'sending', 'sent', 'uncertain', 'failed')`,
    ),
    index('whatsapp_messages_subject').on(table.subjectType, table.subjectId),
  ],
)

export const waIdentities = pgTable('wa_identities', {
  lid: text('lid').primaryKey(),
  phone: text('phone').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('queued'),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    idempotencyKey: text('idempotency_key').unique(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('jobs_status_check', sql`${table.status} in ('queued', 'running', 'done', 'failed', 'cancelled')`),
    index('jobs_ready').on(table.status, table.runAfter),
  ],
)

export const chatContext = pgTable('chat_context', {
  chatJid: text('chat_jid').primaryKey(),
  subjectType: text('subject_type').notNull(),
  subjectId: text('subject_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const availabilitySql = sql`
  select i.id as item_id,
         b.on_hand::int as on_hand,
         coalesce(sum(l.quantity) filter (where o.status = 'open'), 0)::int as reserved
  from items i
  join inventory_balances b on b.item_id = i.id and b.customer_id is null
  left join order_lines l on l.item_id = i.id
  left join orders o on o.id = l.order_id
  where i.kind = 'finished_good'
  group by i.id, b.on_hand
`
