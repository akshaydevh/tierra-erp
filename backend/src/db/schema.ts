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
  primaryKey,
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

export const orderDocuments = pgTable(
  'order_documents',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id'),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    content: bytea('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind').notNull().default('other'),
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    uniqueIndex('order_documents_message').on(table.messageId).where(sql`${table.messageId} is not null`),
    check('order_documents_kind_check', sql`${table.kind} in ('customer_po', 'other', 'so_pdf', 'so_annex', 'report')`),
    index('order_documents_subject').on(table.subjectType, table.subjectId),
  ],
)

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
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
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
    /** A desk turn whose reply is in (or that failed): the desk stops waiting on it. */
    answeredAt: timestamp('answered_at', { withTimezone: true }),
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

/** One customer as Tierra sees it: its PANs and/or SAP card codes (party_group_members). */
export const partyGroups = pgTable('party_groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  alias: text('alias'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const partyGroupMembers = pgTable(
  'party_group_members',
  {
    partyGroupId: text('party_group_id')
      .notNull()
      .references(() => partyGroups.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    value: text('value').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.value] }),
    check('party_group_members_kind_check', sql`${table.kind} in ('pan', 'card_code')`),
    index('party_group_members_group').on(table.partyGroupId),
  ],
)

/** A WhatsApp group the bot is in, and the party group it speaks for (null: not mapped yet). */
export const waGroups = pgTable('wa_groups', {
  jid: text('jid').primaryKey(),
  subject: text('subject'),
  partyGroupId: text('party_group_id').references(() => partyGroups.id, { onDelete: 'set null' }),
  sendSo: boolean('send_so').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Numbers kept as numeric come back from postgres-js as strings; mode 'number' turns them into numbers. */
const decimal = (name: string, precision: number, scale: number) => numeric(name, { precision, scale, mode: 'number' })

/** A customer's delivery site (the code printed on its POs) and the SAP card that ships there. */
export const customerSites = pgTable(
  'customer_sites',
  {
    partyGroupId: text('party_group_id')
      .notNull()
      .references(() => partyGroups.id, { onDelete: 'cascade' }),
    siteCode: text('site_code').notNull(),
    cardCode: text('card_code').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.partyGroupId, table.siteCode] })],
)

/** A customer's article number / EAN for a Tierra item, with the unit it orders in and pieces per unit. */
export const customerItemRefs = pgTable(
  'customer_item_refs',
  {
    id: text('id').primaryKey(),
    partyGroupId: text('party_group_id')
      .notNull()
      .references(() => partyGroups.id, { onDelete: 'cascade' }),
    articleNo: text('article_no'),
    ean: text('ean'),
    itemCode: text('item_code').notNull(),
    buyerUom: text('buyer_uom'),
    pcsPerUom: decimal('pcs_per_uom', 12, 3),
    lastPrice: decimal('last_price', 14, 4),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('customer_item_refs_key_check', sql`${table.articleNo} is not null or ${table.ean} is not null`),
    uniqueIndex('customer_item_refs_article').on(table.partyGroupId, table.articleNo).where(sql`${table.articleNo} is not null`),
    uniqueIndex('customer_item_refs_ean').on(table.partyGroupId, table.ean).where(sql`${table.ean} is not null`),
  ],
)

/** Who owns a material when SAP's receipts cannot tell (customer-supplied or Tierra's own). */
export const itemOwnerOverrides = pgTable(
  'item_owner_overrides',
  {
    itemCode: text('item_code').primaryKey(),
    owner: text('owner').notNull(),
    ownerCardCode: text('owner_card_code'),
    note: text('note'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('item_owner_overrides_owner_check', sql`${table.owner} in ('tierra', 'customer')`)],
)

/** The short name people use for a SAP card ("Mom", "Wipro"). */
export const partyAliases = pgTable('party_aliases', {
  cardCode: text('card_code').primaryKey(),
  alias: text('alias').notNull(),
})

/** A customer purchase order as received (PDF on WhatsApp or the desk) and read. One row per revision. */
export const customerPos = pgTable(
  'customer_pos',
  {
    id: text('id').primaryKey(),
    partyGroupId: text('party_group_id').references(() => partyGroups.id, { onDelete: 'set null' }),
    poNo: text('po_no'),
    revision: integer('revision').notNull().default(1),
    status: text('status').notNull().default('received'),
    cardCode: text('card_code'),
    siteCode: text('site_code'),
    shipToGstin: text('ship_to_gstin'),
    shipToAddress: text('ship_to_address'),
    buyerName: text('buyer_name'),
    vendorCode: text('vendor_code'),
    poDate: date('po_date', { mode: 'string' }),
    deliveryDate: date('delivery_date', { mode: 'string' }),
    basicTotal: decimal('basic_total', 14, 2),
    taxTotal: decimal('tax_total', 14, 2),
    total: decimal('total', 14, 2),
    notes: jsonb('notes').$type<string[]>().notNull().default([]),
    deliveryTerm: text('delivery_term'),
    paymentTerms: text('payment_terms'),
    reader: text('reader'),
    resolution: jsonb('resolution').$type<Record<string, unknown>>(),
    reviewReason: text('review_reason'),
    repeatOf: jsonb('repeat_of').$type<Array<Record<string, unknown>>>().notNull().default([]),
    documentId: text('document_id').references(() => orderDocuments.id, { onDelete: 'set null' }),
    sourceChat: text('source_chat'),
    sourceMessageId: text('source_message_id'),
    sourceSender: text('source_sender'),
    raisedBy: text('raised_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'customer_pos_status_check',
      sql`${table.status} in ('received', 'needs_review', 'awaiting_proceed', 'short', 'checked', 'cancelled')`,
    ),
    uniqueIndex('customer_pos_live')
      .on(table.partyGroupId, table.poNo, table.revision)
      .where(sql`${table.status} <> 'cancelled'`),
    uniqueIndex('customer_pos_message').on(table.sourceMessageId).where(sql`${table.sourceMessageId} is not null`),
    index('customer_pos_po_no').on(table.poNo),
  ],
)

export const customerPoLines = pgTable(
  'customer_po_lines',
  {
    customerPoId: text('customer_po_id')
      .notNull()
      .references(() => customerPos.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    articleNo: text('article_no'),
    ean: text('ean'),
    description: text('description').notNull(),
    hsn: text('hsn'),
    qty: decimal('qty', 14, 3).notNull(),
    uom: text('uom'),
    eaQty: decimal('ea_qty', 14, 3),
    mrp: decimal('mrp', 14, 2),
    baseCost: decimal('base_cost', 14, 4),
    gstPct: decimal('gst_pct', 6, 2),
    taxAmount: decimal('tax_amount', 14, 2),
    lineTotal: decimal('line_total', 14, 2),
    deliveryDate: date('delivery_date', { mode: 'string' }),
    itemCode: text('item_code'),
    itemName: text('item_name'),
    matchMethod: text('match_method'),
    matchConfirmed: boolean('match_confirmed').notNull().default(false),
    pcs: decimal('pcs', 14, 3),
    pcsSource: text('pcs_source'),
    pcsPerUom: decimal('pcs_per_uom', 12, 3),
    unitPrice: decimal('unit_price', 14, 4),
    note: text('note'),
    cessAmount: decimal('cess_amount', 14, 2),
  },
  (table) => [
    primaryKey({ columns: [table.customerPoId, table.lineNo] }),
    check(
      'customer_po_lines_match_check',
      sql`${table.matchMethod} is null or ${table.matchMethod} in ('article', 'ean', 'history', 'name', 'manual')`,
    ),
    check(
      'customer_po_lines_pcs_source_check',
      sql`${table.pcsSource} is null or ${table.pcsSource} in ('ea', 'ref', 'npu', 'pcs')`,
    ),
  ],
)

/** One stock and BOM check: against a received PO, or a dry run ("can we make 10,000 FGABC500?"). */
export const inventoryChecks = pgTable(
  'inventory_checks',
  {
    id: text('id').primaryKey(),
    customerPoId: text('customer_po_id').references(() => customerPos.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    verdict: text('verdict').notNull(),
    dataAsOf: date('data_as_of', { mode: 'string' }),
    warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
    requested: jsonb('requested').$type<Array<Record<string, unknown>>>().notNull().default([]),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('inventory_checks_kind_check', sql`${table.kind} in ('po', 'dry_run')`),
    check('inventory_checks_verdict_check', sql`${table.verdict} in ('pass', 'pass_with_incoming', 'fail')`),
    index('inventory_checks_po').on(table.customerPoId, table.createdAt),
  ],
)

export const inventoryCheckLines = pgTable(
  'inventory_check_lines',
  {
    checkId: text('check_id')
      .notNull()
      .references(() => inventoryChecks.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    kind: text('kind').notNull(),
    itemCode: text('item_code').notNull(),
    itemName: text('item_name'),
    role: text('role'),
    uom: text('uom'),
    need: decimal('need', 16, 4).notNull(),
    onHand: decimal('on_hand', 16, 4).notNull().default(0),
    committed: decimal('committed', 16, 4).notNull().default(0),
    reserved: decimal('reserved', 16, 4).notNull().default(0),
    adjustments: decimal('adjustments', 16, 4).notNull().default(0),
    free: decimal('free', 16, 4).notNull().default(0),
    onOrder: decimal('on_order', 16, 4).notNull().default(0),
    shortNow: decimal('short_now', 16, 4).notNull().default(0),
    shortAfterIncoming: decimal('short_after_incoming', 16, 4).notNull().default(0),
    fromStock: decimal('from_stock', 16, 4),
    toMake: decimal('to_make', 16, 4),
    owner: text('owner'),
    ownerCardCode: text('owner_card_code'),
    ownerName: text('owner_name'),
    checked: boolean('checked').notNull().default(true),
    estimated: boolean('estimated').notNull().default(false),
    status: text('status').notNull(),
    incoming: jsonb('incoming').$type<string[]>().notNull().default([]),
    forItems: jsonb('for_items').$type<string[]>().notNull().default([]),
    note: text('note'),
  },
  (table) => [
    primaryKey({ columns: [table.checkId, table.lineNo] }),
    check('inventory_check_lines_kind_check', sql`${table.kind} in ('fg', 'component')`),
    check('inventory_check_lines_status_check', sql`${table.status} in ('ok', 'short_now', 'short')`),
    check(
      'inventory_check_lines_owner_check',
      sql`${table.owner} is null or ${table.owner} in ('tierra', 'customer', 'customer_unknown')`,
    ),
  ],
)

// ------------------------------------------------------------------------------------------------ P4: sales orders

/** Document number series per financial year: TSO 26-27 -> next 1, 2, ... Taken in the sales order's transaction. */
export const docCounters = pgTable(
  'doc_counters',
  {
    series: text('series').notNull(),
    fy: text('fy').notNull(),
    next: integer('next').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.series, table.fy] })],
)

/** A Tierra sales order (TSO/26-27/0001), at most one live per customer PO. */
export const salesOrders = pgTable(
  'sales_orders',
  {
    id: text('id').primaryKey(),
    docNo: text('doc_no').notNull().unique(),
    series: text('series').notNull().default('TSO'),
    fy: text('fy').notNull(),
    seq: integer('seq').notNull(),
    customerPoId: text('customer_po_id').references(() => customerPos.id, { onDelete: 'set null' }),
    partyGroupId: text('party_group_id').references(() => partyGroups.id, { onDelete: 'set null' }),
    cardCode: text('card_code').notNull(),
    checkId: text('check_id').references(() => inventoryChecks.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('pending_approval'),
    version: integer('version').notNull().default(1),
    docDate: date('doc_date', { mode: 'string' }).notNull(),
    deliveryDate: date('delivery_date', { mode: 'string' }),
    customerPoNo: text('customer_po_no'),
    poDate: date('po_date', { mode: 'string' }),
    vendorCode: text('vendor_code'),
    siteCode: text('site_code'),
    shipToGstin: text('ship_to_gstin'),
    placeOfSupply: text('place_of_supply'),
    stateCode: text('state_code'),
    taxKind: text('tax_kind').notNull().default('cgst_sgst'),
    basicTotal: decimal('basic_total', 14, 2).notNull(),
    cgst: decimal('cgst', 14, 2).notNull().default(0),
    sgst: decimal('sgst', 14, 2).notNull().default(0),
    igst: decimal('igst', 14, 2).notNull().default(0),
    cess: decimal('cess', 14, 2).notNull().default(0),
    taxTotal: decimal('tax_total', 14, 2).notNull(),
    total: decimal('total', 14, 2).notNull(),
    deliveryTerm: text('delivery_term'),
    paymentTerms: text('payment_terms'),
    notes: jsonb('notes').$type<string[]>().notNull().default([]),
    approvedBy: text('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** The SAP sales order the office keyed for it; from then on SAP holds the stock. */
    sapDocEntry: integer('sap_doc_entry'),
    sapDocNo: text('sap_doc_no'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'sales_orders_status_check',
      sql`${table.status} in ('draft', 'pending_approval', 'approved', 'approved_unsent', 'sent', 'in_sap', 'rejected', 'cancelled')`,
    ),
    check('sales_orders_tax_kind_check', sql`${table.taxKind} in ('cgst_sgst', 'igst')`),
    uniqueIndex('sales_orders_live_po')
      .on(table.customerPoId)
      .where(sql`${table.customerPoId} is not null and ${table.status} not in ('cancelled', 'rejected')`),
    index('sales_orders_status').on(table.status),
    uniqueIndex('sales_orders_sap_doc_entry').on(table.sapDocEntry).where(sql`${table.sapDocEntry} is not null`),
  ],
)

export const salesOrderLines = pgTable(
  'sales_order_lines',
  {
    salesOrderId: text('sales_order_id')
      .notNull()
      .references(() => salesOrders.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    itemCode: text('item_code').notNull(),
    itemName: text('item_name'),
    description: text('description'),
    articleNo: text('article_no'),
    ean: text('ean'),
    hsn: text('hsn'),
    poHsn: text('po_hsn'),
    uom: text('uom'),
    qty: decimal('qty', 14, 3).notNull(),
    pcs: decimal('pcs', 14, 3).notNull(),
    pcsPerUom: decimal('pcs_per_uom', 12, 3),
    cartons: decimal('cartons', 14, 3),
    mrp: decimal('mrp', 14, 2),
    unitPrice: decimal('unit_price', 14, 4).notNull(),
    amount: decimal('amount', 14, 2).notNull(),
    gstPct: decimal('gst_pct', 6, 2).notNull(),
    taxAmount: decimal('tax_amount', 14, 2).notNull(),
    cessAmount: decimal('cess_amount', 14, 2).notNull().default(0),
    reservedPcs: decimal('reserved_pcs', 14, 3).notNull().default(0),
    toMake: decimal('to_make', 14, 3).notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.salesOrderId, table.lineNo] }), index('sales_order_lines_item').on(table.itemCode)],
)

/** One approval request per PDF version of a subject. */
export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    version: integer('version').notNull(),
    approverRole: text('approver_role').notNull().default('admin'),
    status: text('status').notNull().default('pending'),
    channel: text('channel'),
    via: text('via'),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    note: text('note'),
    selfRaised: boolean('self_raised').notNull().default(false),
    raisedBy: text('raised_by').references(() => users.id, { onDelete: 'set null' }),
    waMessageIds: jsonb('wa_message_ids').$type<string[]>().notNull().default([]),
    taskId: text('task_id'),
    soPdfId: text('so_pdf_id').references(() => orderDocuments.id, { onDelete: 'set null' }),
    annexId: text('annex_id').references(() => orderDocuments.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'approvals_status_check',
      sql`${table.status} in ('pending', 'approved', 'sent_back', 'rejected', 'superseded')`,
    ),
    check('approvals_channel_check', sql`${table.channel} is null or ${table.channel} in ('whatsapp', 'desk')`),
    check(
      'approvals_via_check',
      sql`${table.via} is null or ${table.via} in ('reaction', 'reply', 'text', 'llm', 'desk')`,
    ),
    check('approvals_approver_role_check', sql`${table.approverRole} in ('admin', 'manager', 'office')`),
    uniqueIndex('approvals_subject_version').on(table.subjectType, table.subjectId, table.version),
    index('approvals_status').on(table.status),
  ],
)

export const procurementRequests = pgTable(
  'procurement_requests',
  {
    id: text('id').primaryKey(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    customerPoId: text('customer_po_id').references(() => customerPos.id, { onDelete: 'set null' }),
    salesOrderId: text('sales_order_id').references(() => salesOrders.id, { onDelete: 'set null' }),
    itemCode: text('item_code').notNull(),
    itemName: text('item_name'),
    qty: decimal('qty', 16, 4).notNull(),
    uom: text('uom'),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('open'),
    taskId: text('task_id'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('procurement_requests_reason_check', sql`${table.reason} in ('production', 'expedite', 'shortage')`),
    check('procurement_requests_status_check', sql`${table.status} in ('open', 'done', 'cancelled')`),
    uniqueIndex('procurement_requests_subject_item_reason').on(table.subjectId, table.itemCode, table.reason),
  ],
)

export const stockAdjustments = pgTable(
  'stock_adjustments',
  {
    id: text('id').primaryKey(),
    itemCode: text('item_code').notNull(),
    qty: decimal('qty', 16, 4).notNull(),
    uom: text('uom'),
    reason: text('reason').notNull().default('receipt_unposted'),
    note: text('note'),
    taskId: text('task_id'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdVia: text('created_via').notNull().default('dashboard'),
    status: text('status').notNull().default('active'),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedNote: text('closed_note'),
  },
  (table) => [
    check('stock_adjustments_status_check', sql`${table.status} in ('active', 'absorbed', 'cancelled')`),
    check('stock_adjustments_created_via_check', sql`${table.createdVia} in ('dashboard', 'whatsapp', 'desk', 'system')`),
    index('stock_adjustments_item').on(table.itemCode, table.status),
  ],
)

// ------------------------------------------------------------------------------------------------ P6: finance, daily report

/** The word the daily report prints for a payment to a GL account; prefer_payee prints the memo's payee instead. */
export const glLabels = pgTable('gl_labels', {
  glCode: text('gl_code').primaryKey(),
  label: text('label').notNull(),
  preferPayee: boolean('prefer_payee').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** A bank journal line counted on another day than its SAP posting date (balances follow it). */
export const bankLineReattributions = pgTable(
  'bank_line_reattributions',
  {
    transId: integer('trans_id').notNull(),
    lineId: integer('line_id').notNull(),
    reportDate: date('report_date', { mode: 'string' }).notNull(),
    note: text('note'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.transId, table.lineId] })],
)

/** What SAP does not have for a day's report: manpower, gate estimates, flag overrides, remarks. */
export const dailyReportInputs = pgTable('daily_report_inputs', {
  reportDate: date('report_date', { mode: 'string' }).primaryKey(),
  productionRun: boolean('production_run'),
  packingRun: boolean('packing_run'),
  cartoningRun: boolean('cartoning_run'),
  manpower: jsonb('manpower').$type<Record<string, number>>(),
  bananaKgEstimate: decimal('banana_kg_estimate', 12, 2),
  cassavaKgEstimate: decimal('cassava_kg_estimate', 12, 2),
  inwardRemarks: jsonb('inward_remarks').$type<Record<string, string>>().notNull().default({}),
  notes: text('notes'),
  enteredBy: text('entered_by').references(() => users.id, { onDelete: 'set null' }),
  enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Every generated daily report, versioned per day, with the payload it printed and its PDF. */
export const dailyReports = pgTable(
  'daily_reports',
  {
    id: text('id').primaryKey(),
    reportDate: date('report_date', { mode: 'string' }).notNull(),
    version: integer('version').notNull(),
    basis: text('basis').notNull(),
    dataAsOf: date('data_as_of', { mode: 'string' }),
    payload: jsonb('payload').$type<unknown>().notNull(),
    documentId: text('document_id').references(() => orderDocuments.id, { onDelete: 'set null' }),
    generatedBy: text('generated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('daily_reports_basis_check', sql`${table.basis} in ('created_window', 'doc_date', 'ewb_date')`),
    uniqueIndex('daily_reports_date_version').on(table.reportDate, table.version),
  ],
)

/** Small admin settings, e.g. daily_report.outwards_basis. */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
