import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { verifyPassword } from '../auth/password'
import { connect, runMigrations, startPostgres, type Connection } from '../test/postgres'
import { seedIfEmpty } from './seed'

const harness = await startPostgres()
if (harness.skipReason) console.warn(harness.skipReason)
const pg = harness.postgres

const now = new Date('2026-10-01T09:00:00.000Z')
const later = (ms: number) => new Date(now.getTime() + ms)

describe.skipIf(!pg)('DrizzleStore on Postgres 18', () => {
  let databases = 0
  let url: string
  let conn: Connection

  beforeAll(async () => {
    const template = await pg!.createDatabase('seeded')
    await runMigrations(template)
    const seeding = connect(template)
    await seedIfEmpty(seeding.db, 'secret-pass')
    await seeding.close()
  })

  beforeEach(async () => {
    databases += 1
    url = await pg!.createDatabase(`t${databases}`, 'seeded')
    conn = connect(url)
  })

  afterEach(async () => {
    await conn.close()
  })

  afterAll(async () => {
    await pg?.stop()
  })

  it('seeds users with the given password and a single admin', async () => {
    const alex = await conn.store.findUserByEmail('alex.thomas@tierra.test')
    expect(alex?.role).toBe('admin')
    expect(await verifyPassword('secret-pass', alex!.passwordHash)).toBe(true)
    const accounts = await conn.store.listAccountLinks()
    expect(accounts.find((account) => account.id === 'usr_joshy')?.role).toBe('manager')
  })

  it('allows only one admin', async () => {
    await expect(conn.sql`update users set role = 'admin' where id = 'usr_joshy'`).rejects.toThrow(
      /users_single_admin/,
    )
    expect(await conn.store.updateUserRole('usr_joshy', 'admin')).toBe('admin_taken')
    expect(await conn.store.updateUserRole('usr_alex', 'admin')).toBe('ok')
    expect(await conn.store.updateUserRole('usr_nobody', 'office')).toBe('not_found')
    expect(await conn.store.updateUserRole('usr_alex', 'manager')).toBe('ok')
    expect(await conn.store.updateUserRole('usr_joshy', 'admin')).toBe('ok')
    const roles = (await conn.store.listAccountLinks()).map((account) => [account.id, account.role])
    expect(roles).toEqual(
      expect.arrayContaining([
        ['usr_alex', 'manager'],
        ['usr_joshy', 'admin'],
      ]),
    )
  })

  it('transfers the admin role in one step', async () => {
    expect(await conn.store.transferAdmin('usr_joshy')).toBe('ok')
    expect(await conn.store.transferAdmin('usr_nobody')).toBe('not_found')
    const roles = (await conn.store.listAccountLinks()).map((account) => [account.id, account.role])
    expect(roles).toEqual(
      expect.arrayContaining([
        ['usr_alex', 'manager'],
        ['usr_joshy', 'admin'],
        ['usr_anju', 'office'],
      ]),
    )
  })

  it('creates one live task per subject and kind', async () => {
    const input = {
      title: ' Buy raw banana ',
      category: 'procurement' as const,
      kind: 'procurement' as const,
      assigneeId: 'usr_joshy',
      assigneeRole: 'manager' as const,
      description: 'Short by 400 kg',
      dueAt: later(86_400_000),
      subjectType: 'pending_order',
      subjectId: 'pnd_1',
      createdVia: 'system' as const,
      createdBy: 'usr_alex',
    }
    const first = await conn.store.createTask(input)
    expect(first).toMatchObject({
      title: 'Buy raw banana',
      status: 'todo',
      kind: 'procurement',
      assigneeId: 'usr_joshy',
      assigneeName: 'Joshy',
      assigneeRole: 'manager',
      description: 'Short by 400 kg',
      dueAt: later(86_400_000).toISOString(),
      subjectType: 'pending_order',
      subjectId: 'pnd_1',
      notifiedAt: null,
      waMessageId: null,
      createdVia: 'system',
      createdBy: 'usr_alex',
      createdByName: 'Alex Thomas',
      completedAt: null,
    })
    const again = await conn.store.createTask({ ...input, title: 'Duplicate' })
    expect(again.id).toBe(first.id)
    const review = await conn.store.createTask({ ...input, kind: 'review' })
    expect(review.id).not.toBe(first.id)

    await conn.store.updateTaskStatus(first.id, 'cancelled')
    const replacement = await conn.store.createTask(input)
    expect(replacement.id).not.toBe(first.id)

    const loose = await conn.store.createTask({ title: 'Call', category: 'operations', assigneeId: null, createdBy: 'usr_anju' })
    const loose2 = await conn.store.createTask({ title: 'Call', category: 'operations', assigneeId: null, createdBy: 'usr_anju' })
    expect(loose.id).not.toBe(loose2.id)
    expect(loose).toMatchObject({ kind: 'todo', createdVia: 'dashboard', assigneeName: null, createdByName: 'Anju' })
    expect(await conn.store.listTasks()).toHaveLength(5)
  })

  it('stamps completion, reassigns and tracks notices', async () => {
    const task = await conn.store.createTask({
      title: 'Check cartons',
      category: 'operations',
      assigneeId: 'usr_anju',
      assigneeRole: 'office',
      createdBy: 'usr_alex',
    })
    expect(await conn.store.listOpenTasksForUser('usr_anju')).toEqual([task])

    await conn.store.markTaskNotified(task.id, 'wa-notice-1', now)
    const notified = await conn.store.findTaskByMessage('wa-notice-1')
    expect(notified).toMatchObject({ id: task.id, notifiedAt: now.toISOString(), waMessageId: 'wa-notice-1' })
    expect(await conn.store.findTaskByMessage('wa-unknown')).toBeNull()

    const sameHolder = await conn.store.updateTaskAssignment(task.id, { assigneeId: 'usr_anju', assigneeRole: null })
    expect(sameHolder).toMatchObject({ assigneeRole: null, waMessageId: 'wa-notice-1' })
    const moved = await conn.store.updateTaskAssignment(task.id, { assigneeId: 'usr_joshy', assigneeRole: 'manager' })
    expect(moved).toMatchObject({ assigneeId: 'usr_joshy', assigneeName: 'Joshy', notifiedAt: null, waMessageId: null })
    expect(await conn.store.listOpenTasksForUser('usr_anju')).toEqual([])

    await conn.store.claimMessage({
      evolutionMessageId: 'wa-notice-1',
      remoteJid: '919800000001@s.whatsapp.net',
      fromMe: true,
      hasPdf: false,
      body: 'New task',
      purpose: 'task_notice',
      subjectType: 'task',
      subjectId: task.id,
      status: 'sent',
    })
    expect((await conn.store.findTaskByMessage('wa-notice-1'))?.id).toBe(task.id)

    const done = await conn.store.updateTaskStatus(task.id, 'done')
    expect(done?.completedAt).not.toBeNull()
    expect((await conn.store.updateTaskStatus(task.id, 'done'))?.completedAt).toBe(done?.completedAt)
    expect(await conn.store.listOpenTasksForUser('usr_joshy')).toEqual([])
    expect((await conn.store.updateTaskStatus(task.id, 'doing'))?.completedAt).toBeNull()
    expect(await conn.store.getTask('tsk_missing')).toBeNull()
    expect(await conn.store.updateTaskStatus('tsk_missing', 'done')).toBeNull()
  })

  it('drops a second job with the same idempotency key', async () => {
    const first = await conn.store.enqueueJob({ kind: 'task.notify', payload: { taskId: 't1' }, idempotencyKey: 'k1' })
    expect(first).toMatchObject({ kind: 'task.notify', payload: { taskId: 't1' }, status: 'queued', attempts: 0, maxAttempts: 5 })
    expect(await conn.store.enqueueJob({ kind: 'task.notify', payload: { taskId: 't1' }, idempotencyKey: 'k1' })).toBeNull()
    expect(await conn.store.enqueueJob({ kind: 'x', payload: {} })).not.toBeNull()
    expect(await conn.store.enqueueJob({ kind: 'x', payload: {} })).not.toBeNull()
  })

  it('never hands the same job to two concurrent claimers', async () => {
    for (let index = 0; index < 20; index += 1) {
      await conn.store.enqueueJob({ kind: 'x', payload: { index }, runAfter: later(-60_000 + index) })
    }
    await conn.store.enqueueJob({ kind: 'x', payload: { index: 'future' }, runAfter: later(60_000) })
    const other = connect(url)
    try {
      const batches = await Promise.all([
        conn.store.claimJobs(7, 30_000, now),
        other.store.claimJobs(7, 30_000, now),
        conn.store.claimJobs(7, 30_000, now),
        other.store.claimJobs(7, 30_000, now),
      ])
      const ids = batches.flat().map((job) => job.id)
      expect(ids).toHaveLength(20)
      expect(new Set(ids).size).toBe(20)
      for (const job of batches.flat()) {
        expect(job).toMatchObject({ status: 'running', attempts: 1, lockedUntil: later(30_000).toISOString() })
      }
      expect(await conn.store.claimJobs(5, 30_000, now)).toEqual([])
    } finally {
      await other.close()
    }
  })

  it('claims the oldest ready jobs first', async () => {
    const late = await conn.store.enqueueJob({ kind: 'x', payload: {}, runAfter: later(-1_000) })
    const early = await conn.store.enqueueJob({ kind: 'x', payload: {}, runAfter: later(-5_000) })
    const claimed = await conn.store.claimJobs(1, 1_000, now)
    expect(claimed.map((job) => job.id)).toEqual([early!.id])
    expect((await conn.store.claimJobs(5, 1_000, now)).map((job) => job.id)).toEqual([late!.id])
  })

  it('requeues jobs whose lease expired', async () => {
    const job = await conn.store.enqueueJob({ kind: 'x', payload: {}, runAfter: now, maxAttempts: 2 })
    await conn.store.claimJobs(1, 10_000, now)
    expect(await conn.store.requeueExpiredJobs(later(5_000))).toBe(0)
    expect(await conn.store.requeueExpiredJobs(later(10_001))).toBe(1)
    expect(await conn.store.getJob(job!.id)).toMatchObject({ status: 'queued', lockedUntil: null, attempts: 1 })

    const [again] = await conn.store.claimJobs(1, 10_000, later(20_000))
    expect(again).toMatchObject({ id: job!.id, attempts: 2 })
    expect(await conn.store.requeueExpiredJobs(later(40_000))).toBe(0)
    expect(await conn.store.getJob(job!.id)).toMatchObject({ status: 'failed', lastError: 'Lease expired' })
  })

  it('retries a failed job at retryAt or fails it for good', async () => {
    const job = await conn.store.enqueueJob({ kind: 'x', payload: {}, runAfter: now })
    await conn.store.claimJobs(1, 10_000, now)
    await conn.store.failJob(job!.id, 'boom', later(5_000))
    expect(await conn.store.getJob(job!.id)).toMatchObject({
      status: 'queued',
      runAfter: later(5_000).toISOString(),
      lockedUntil: null,
      lastError: 'boom',
    })
    expect(await conn.store.claimJobs(1, 10_000, later(4_999))).toEqual([])
    expect(await conn.store.claimJobs(1, 10_000, later(5_000))).toHaveLength(1)
    await conn.store.failJob(job!.id, 'boom again', null)
    expect(await conn.store.getJob(job!.id)).toMatchObject({ status: 'failed', lastError: 'boom again', attempts: 2 })
    expect(await conn.store.claimJobs(1, 10_000, later(60_000))).toEqual([])

    const other = await conn.store.enqueueJob({ kind: 'x', payload: {}, runAfter: now })
    await conn.store.claimJobs(1, 10_000, now)
    await conn.store.completeJob(other!.id)
    expect(await conn.store.getJob(other!.id)).toMatchObject({ status: 'done', lockedUntil: null })
    expect(await conn.store.getJob('job_missing')).toBeNull()
  })

  it('stores registry fields, identities and chat context', async () => {
    expect(
      await conn.store.claimMessage({
        evolutionMessageId: 'in-1',
        remoteJid: '120363000000000000@g.us',
        fromMe: false,
        hasPdf: false,
        body: '👍',
        senderJid: '123456789@lid',
        quotedId: null,
        kind: 'reaction',
        status: 'received',
      }),
    ).toBe(true)
    expect(
      await conn.store.claimMessage({ evolutionMessageId: 'in-1', remoteJid: 'x', fromMe: false, hasPdf: false, body: null }),
    ).toBe(false)
    expect(await conn.store.findMessage('in-1')).toMatchObject({
      evolutionMessageId: 'in-1',
      remoteJid: '120363000000000000@g.us',
      fromMe: false,
      body: '👍',
      kind: 'reaction',
      purpose: null,
      subjectType: null,
      subjectId: null,
    })
    expect(await conn.store.findMessage('missing')).toBeNull()
    const [row] = await conn.sql`select sender_jid, status from whatsapp_messages where evolution_message_id = 'in-1'`
    expect(row).toEqual({ sender_jid: '123456789@lid', status: 'received' })

    const outbound = { remoteJid: 'a', fromMe: true, hasPdf: false, body: null, idempotencyKey: 'send:1' }
    expect(await conn.store.claimMessage({ evolutionMessageId: 'out-1', ...outbound })).toBe(true)
    await expect(conn.store.claimMessage({ evolutionMessageId: 'out-2', ...outbound })).rejects.toThrow()

    expect(await conn.store.phoneForLid('123456789@lid')).toBeNull()
    await conn.store.saveIdentity('123456789@lid', '919800000001')
    await conn.store.saveIdentity('123456789@lid', '919800000002')
    expect(await conn.store.phoneForLid('123456789@lid')).toBe('919800000002')

    expect(await conn.store.getChatContext('chat-1')).toBeNull()
    await conn.store.setChatContext('chat-1', 'order', 'ord_1')
    await conn.store.setChatContext('chat-1', 'pending_order', 'pnd_2')
    expect(await conn.store.getChatContext('chat-1')).toMatchObject({
      chatJid: 'chat-1',
      subjectType: 'pending_order',
      subjectId: 'pnd_2',
    })
  })
  it('keeps one stored PDF per WhatsApp message', async () => {
    const pdf = { filename: 'po.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF'), messageId: 'wa-pdf-1' }
    expect(await conn.store.hasDocumentForMessage('wa-pdf-1')).toBe(false)
    await conn.store.insertDocument(pdf)
    expect(await conn.store.hasDocumentForMessage('wa-pdf-1')).toBe(true)
    await expect(conn.store.insertDocument(pdf)).rejects.toThrow()
    await conn.sql`
      insert into order_documents (id, filename, mime_type, content)
      values ('doc_a', 'a.pdf', 'x', decode('00', 'hex')), ('doc_b', 'b.pdf', 'x', decode('00', 'hex'))`
  })

  it('lists the held orders waiting in a chat, newest first', async () => {
    const hold = async (poNumber: string, remoteJid: string) => {
      const documentId = await conn.store.insertDocument({
        filename: `${poNumber}.pdf`,
        mimeType: 'application/pdf',
        content: Buffer.from('%PDF'),
        messageId: `wa-${poNumber}`,
      })
      return conn.store.holdShortOrder({
        customerId: 'cus_beyond',
        poNumber,
        poDate: null,
        remoteJid,
        documentId,
        lines: [{ itemId: 'item_ban80', description: 'Banana chips 80g', quantity: 200, unit: 'pouch', unitPrice: null }],
        shortages: [{ itemId: 'item_ban80', quantity: 160, unit: 'pouch' }],
        assigneeId: 'usr_joshy',
      })
    }
    const first = await hold('PO-A', '919900000000@s.whatsapp.net')
    const second = await hold('PO-B', '919900000000@s.whatsapp.net')
    await hold('PO-C', '919812345678@s.whatsapp.net')
    const awaiting = await conn.store.listAwaitingConfirmations('919900000000@s.whatsapp.net')
    expect(awaiting.map((row) => [row.id, row.poNumber])).toEqual([
      [second.id, 'PO-B'],
      [first.id, 'PO-A'],
    ])
    expect(awaiting[0]?.lines).toEqual([
      { itemId: 'item_ban80', description: 'Banana chips 80g', quantity: 200, unit: 'pouch', unitPrice: null },
    ])
    await conn.store.declinePendingOrder(second.id)
    expect((await conn.store.listAwaitingConfirmations('919900000000@s.whatsapp.net')).map((row) => row.id)).toEqual([
      first.id,
    ])
    expect(await conn.store.listAwaitingConfirmations('nobody@s.whatsapp.net')).toEqual([])
  })

  it('cancels the open tasks about a subject and leaves finished ones', async () => {
    const about = { category: 'procurement' as const, createdBy: 'usr_alex', subjectType: 'pending_order', subjectId: 'pnd_9' }
    const buy = await conn.store.createTask({ ...about, title: 'Buy', kind: 'procurement', assigneeId: 'usr_joshy' })
    const review = await conn.store.createTask({ ...about, title: 'Review', kind: 'review', assigneeId: 'usr_joshy' })
    const other = await conn.store.createTask({ ...about, title: 'Other', subjectId: 'pnd_8', assigneeId: 'usr_joshy' })
    await conn.store.updateTaskStatus(review.id, 'done')
    expect(await conn.store.cancelTasksForSubject('pending_order', 'pnd_9')).toBe(1)
    expect((await conn.store.getTask(buy.id))?.status).toBe('cancelled')
    expect((await conn.store.getTask(review.id))?.status).toBe('done')
    expect((await conn.store.getTask(other.id))?.status).toBe('todo')
  })

  it('reserves a task notice once and frees it only while nothing was sent', async () => {
    const task = await conn.store.createTask({ title: 'Count', category: 'operations', assigneeId: 'usr_anju', createdBy: 'usr_alex' })
    await conn.store.createTask({ title: 'Nobody', category: 'operations', assigneeId: null, createdBy: 'usr_alex' })
    await conn.store.createTask({ title: 'Sign', category: 'operations', kind: 'approval', assigneeId: 'usr_anju', createdBy: 'usr_alex' })
    expect((await conn.store.listUnnotifiedOpenTasks()).map((row) => row.id)).toEqual([task.id])

    expect(await conn.store.reserveTaskNotice(task.id, 'usr_joshy')).toBe(false)
    expect(await conn.store.reserveTaskNotice(task.id, 'usr_anju')).toBe(true)
    expect(await conn.store.reserveTaskNotice(task.id, 'usr_anju')).toBe(false)
    expect(await conn.store.listUnnotifiedOpenTasks()).toEqual([])

    await conn.store.releaseTaskNotice(task.id)
    expect((await conn.store.getTask(task.id))?.notifiedAt).toBeNull()
    expect(await conn.store.reserveTaskNotice(task.id, 'usr_anju')).toBe(true)
    await conn.store.markTaskNotified(task.id, 'wa-notice-9', now)
    await conn.store.releaseTaskNotice(task.id)
    expect(await conn.store.getTask(task.id)).toMatchObject({ notifiedAt: now.toISOString(), waMessageId: 'wa-notice-9' })
  })

  it('frees notices reserved long ago that never recorded a message', async () => {
    const stuck = await conn.store.createTask({ title: 'Stuck', category: 'operations', assigneeId: 'usr_anju', createdBy: 'usr_alex' })
    const sent = await conn.store.createTask({ title: 'Sent', category: 'operations', assigneeId: 'usr_anju', createdBy: 'usr_alex' })
    expect(await conn.store.reserveTaskNotice(stuck.id, 'usr_anju')).toBe(true)
    expect(await conn.store.reserveTaskNotice(sent.id, 'usr_anju')).toBe(true)
    await conn.store.markTaskNotified(sent.id, 'wa-notice-10', now)

    expect(await conn.store.releaseStaleTaskNotices(new Date(Date.now() - 60_000))).toBe(0)
    expect(await conn.store.releaseStaleTaskNotices(new Date(Date.now() + 60_000))).toBe(1)
    expect((await conn.store.getTask(stuck.id))?.notifiedAt).toBeNull()
    expect((await conn.store.getTask(sent.id))?.waMessageId).toBe('wa-notice-10')
    expect((await conn.store.listUnnotifiedOpenTasks()).map((row) => row.id)).toContain(stuck.id)
  })

  it('stamps assignedAt when a task is created and when its holder changes', async () => {
    const task = await conn.store.createTask({ title: 'Count', category: 'operations', assigneeId: 'usr_anju', createdBy: 'usr_alex' })
    expect(task.assignedAt).toBe(task.createdAt)
    const same = await conn.store.updateTaskAssignment(task.id, { assigneeId: 'usr_anju', assigneeRole: 'office' })
    expect(same?.assignedAt).toBe(task.assignedAt)
    const moved = await conn.store.updateTaskAssignment(task.id, { assigneeId: 'usr_joshy', assigneeRole: null })
    expect(Date.parse(moved!.assignedAt)).toBeGreaterThan(Date.parse(task.assignedAt))
  })

  it('prunes finished jobs older than the cutoff', async () => {
    const done = await conn.store.enqueueJob({ kind: 'x', payload: {}, runAfter: now })
    const failed = await conn.store.enqueueJob({ kind: 'x', payload: {}, runAfter: now })
    const waiting = await conn.store.enqueueJob({ kind: 'x', payload: {}, runAfter: now })
    await conn.store.completeJob(done!.id)
    await conn.store.failJob(failed!.id, 'boom', null)
    expect(await conn.store.pruneJobs(later(-60_000))).toBe(0)
    await conn.sql`update jobs set updated_at = ${later(-8 * 86_400_000).toISOString()}::timestamptz`
    expect(await conn.store.pruneJobs(later(-7 * 86_400_000))).toBe(2)
    expect(await conn.store.getJob(waiting!.id)).not.toBeNull()
    expect(await conn.store.getJob(done!.id)).toBeNull()
  })
})

