'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { JOB_ACCESS_ROLES, ROLES, roleLabel, type AccountLink, type JobAccessRole, type JobRole, type Me, type Role } from '@/lib/types'

const MIN_PASSWORD_LENGTH = 8

/** A role picker value: a built-in role ('admin', 'manager', 'office') or `job:<id>` for an added one. */
type RoleChoice = Role | `job:${string}`

type PersonDraft = {
  name: string
  email: string
  password: string
  role: RoleChoice
  phoneNumber: string
}

const EMPTY_PERSON: PersonDraft = { name: '', email: '', password: '', role: 'office', phoneNumber: '' }

function choiceOf(account: AccountLink): RoleChoice {
  return account.jobRole ? `job:${account.jobRole.id}` : account.role
}

function jobIdOf(choice: RoleChoice): string | null {
  return choice.startsWith('job:') ? choice.slice(4) : null
}

/** Asks before a new admin takes over; the current admin becomes a manager. False when the admin declines. */
function confirmTransfer(name: string, admin: AccountLink | undefined): boolean {
  return !admin || window.confirm(`Make ${name} the admin? ${admin.name} becomes Manager.`)
}

function RoleOptions({ roles }: { roles: JobRole[] }) {
  return (
    <>
      {ROLES.map((role) => (
        <option key={role} value={role}>
          {roleLabel(role)}
        </option>
      ))}
      {roles.length ? (
        <optgroup label="Added roles">
          {roles.map((role) => (
            <option key={role.id} value={`job:${role.id}`}>
              {role.name} ({roleLabel(role.accessRole)} access)
            </option>
          ))}
        </optgroup>
      ) : null}
    </>
  )
}

async function readJson<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null
}

function rolePillClass(role: Role): string {
  if (role === 'admin') return 'pill ok'
  if (role === 'manager') return 'pill ink'
  return 'pill grey'
}

/** The add-person form: who they are, the password they sign in with, their job role, and their WhatsApp number. */
function PersonEditor({
  roles,
  admin,
  onCancel,
  onSaved,
}: {
  roles: JobRole[]
  admin: AccountLink | undefined
  onCancel: () => void
  onSaved: (accounts: AccountLink[], transferred: boolean) => void
}) {
  const [value, setValue] = useState<PersonDraft>(EMPTY_PERSON)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const ready = value.name.trim() && value.email.trim() && value.password.length >= MIN_PASSWORD_LENGTH

  async function save() {
    const jobRoleId = jobIdOf(value.role)
    const transfer = value.role === 'admin' && Boolean(admin)
    if (value.role === 'admin' && !confirmTransfer(value.name.trim(), admin)) return
    setPending(true)
    setError('')
    const response = await fetch('/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: value.name,
        email: value.email,
        password: value.password,
        ...(jobRoleId ? { jobRoleId } : { role: value.role }),
        ...(transfer ? { transfer: true } : {}),
        phoneNumber: value.phoneNumber,
      }),
    })
    setPending(false)
    const body = await readJson<{ error?: string; accounts?: AccountLink[] }>(response)
    if (!response.ok) {
      setError(body?.error ?? 'Could not add that person')
      return
    }
    onSaved(body?.accounts ?? [], transfer)
  }

  return (
    <article className="card p6" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 }}>
      <b>New person</b>
      <div className="formgrid">
        <div className="field">
          <label htmlFor="person-name">Name</label>
          <input id="person-name" value={value.name} onChange={(event) => setValue({ ...value, name: event.target.value })} placeholder="Anish" autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="person-email">Email (signs in with)</label>
          <input
            id="person-email"
            type="email"
            value={value.email}
            onChange={(event) => setValue({ ...value, email: event.target.value })}
            placeholder="anish@tierra.in"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="person-password">Password</label>
          <input
            id="person-password"
            type="password"
            value={value.password}
            onChange={(event) => setValue({ ...value, password: event.target.value })}
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
            autoComplete="new-password"
          />
        </div>
        <div className="field">
          <label htmlFor="person-role">Role</label>
          <select id="person-role" value={value.role} onChange={(event) => setValue({ ...value, role: event.target.value as RoleChoice })}>
            <RoleOptions roles={roles} />
          </select>
        </div>
        <div className="field">
          <label htmlFor="person-phone">WhatsApp number (optional)</label>
          <input
            id="person-phone"
            type="tel"
            inputMode="tel"
            value={value.phoneNumber}
            onChange={(event) => setValue({ ...value, phoneNumber: event.target.value })}
            placeholder="91 98470 12345"
            autoComplete="off"
          />
        </div>
      </div>
      <p className="stamp">
        Share the password with them. They can sign in straight away.
        {value.role === 'admin' && admin ? ` ${admin.name} becomes Manager: there is one admin.` : ''}
      </p>
      {error ? <p className="formerror" role="alert">{error}</p> : null}
      <div className="actions">
        <button type="button" className="btn-pri" disabled={pending || !ready} onClick={() => void save()}>
          Add person
        </button>
        <button type="button" className="btn-sec" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </article>
  )
}

/** Masters: the people who use Tierra and the job roles they hold. */
export function PeoplePanel({ me }: { me: Me }) {
  const router = useRouter()
  const canManage = me.role === 'admin'
  const [accounts, setAccounts] = useState<AccountLink[] | null>(null)
  const [roles, setRoles] = useState<JobRole[]>([])
  const [adding, setAdding] = useState(false)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [roleName, setRoleName] = useState('')
  const [roleAccess, setRoleAccess] = useState<JobAccessRole>('office')
  const [roleError, setRoleError] = useState('')
  const [rolePending, setRolePending] = useState(false)

  const loadAccounts = useCallback(async () => {
    const response = await fetch('/api/relations')
    if (!response.ok) return
    setAccounts((await readJson<{ accounts: AccountLink[] }>(response))?.accounts ?? [])
  }, [])

  const loadRoles = useCallback(async () => {
    const response = await fetch('/api/job-roles')
    if (!response.ok) return
    setRoles((await readJson<{ roles: JobRole[] }>(response))?.roles ?? [])
  }, [])

  useEffect(() => {
    void loadAccounts()
    void loadRoles()
  }, [loadAccounts, loadRoles])

  const admin = accounts?.find((account) => account.role === 'admin')

  /** Moves a person to a built-in role (via the Settings role route, which guards the single admin) or an added one. */
  async function assign(account: AccountLink, choice: RoleChoice) {
    if (choice === choiceOf(account)) return
    const jobRoleId = jobIdOf(choice)
    const transfer = choice === 'admin' && Boolean(admin)
    if (choice === 'admin' && !confirmTransfer(account.name, admin)) return
    setPendingId(account.id)
    setRowErrors((current) => ({ ...current, [account.id]: '' }))
    const response = await fetch(jobRoleId ? `/api/users/${account.id}/job-role` : `/api/users/${account.id}/role`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(jobRoleId ? { jobRoleId } : transfer ? { role: choice, transfer: true } : { role: choice }),
    })
    setPendingId(null)
    const body = await readJson<{ error?: string; accounts?: AccountLink[] }>(response)
    if (!response.ok) {
      setRowErrors((current) => ({ ...current, [account.id]: body?.error ?? 'Could not change that role' }))
      return
    }
    if (body?.accounts) setAccounts(body.accounts)
    if (account.id === me.id || transfer) router.refresh()
  }

  async function addRole() {
    setRolePending(true)
    setRoleError('')
    const response = await fetch('/api/job-roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: roleName, accessRole: roleAccess }),
    })
    setRolePending(false)
    const body = await readJson<{ error?: string; roles?: JobRole[] }>(response)
    if (!response.ok) {
      setRoleError(body?.error ?? 'Could not add that role')
      return
    }
    setRoles(body?.roles ?? [])
    setRoleName('')
    setRoleAccess('office')
  }

  return (
    <>
      <section className="sec">
        <div className="sechead">
          <div>
            <h3>People</h3>
            <p>
              Everyone who signs in to Tierra or messages Tierra Bot. Each person holds one role: Admin, Manager, Office,
              or a role added below. There is one admin; making someone admin turns the current admin into a manager.
            </p>
          </div>
          {canManage && !adding ? (
            <div className="secside">
              <button className="btn-pri" type="button" onClick={() => setAdding(true)}>
                Add person
              </button>
            </div>
          ) : null}
        </div>
        {adding ? (
          <PersonEditor
            roles={roles}
            admin={admin}
            onCancel={() => setAdding(false)}
            onSaved={(next, transferred) => {
              setAccounts(next)
              setAdding(false)
              if (transferred) router.refresh()
            }}
          />
        ) : null}
        <article className="card p6" style={{ maxWidth: 760 }}>
          {accounts === null ? <p className="stamp">Loading people</p> : null}
          <div className="rels">
            {(accounts ?? []).map((account) => (
              <div className="rel" key={account.id} style={{ gridTemplateColumns: canManage ? 'minmax(0, 1fr) minmax(140px, 220px)' : '1fr' }}>
                <div>
                  <div className="relname">
                    <b>{account.name}</b>
                    {account.jobRole ? (
                      <>
                        <span className="pill ink">{account.jobRole.name}</span>
                        <span className="pill grey">{roleLabel(account.role)} access</span>
                      </>
                    ) : (
                      <span className={rolePillClass(account.role)}>{roleLabel(account.role)}</span>
                    )}
                  </div>
                  <div className="stamp">
                    {[account.email, account.phoneNumber ? `+${account.phoneNumber}` : 'No WhatsApp number', account.id === me.id ? 'You' : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  {rowErrors[account.id] ? (
                    <p className="formerror" role="alert" style={{ marginTop: 6 }}>
                      {rowErrors[account.id]}
                    </p>
                  ) : null}
                </div>
                {canManage ? (
                  <div className="field">
                    <label className="sr" htmlFor={`role-${account.id}`}>
                      Role for {account.name}
                    </label>
                    <select
                      id={`role-${account.id}`}
                      value={choiceOf(account)}
                      disabled={pendingId === account.id}
                      onChange={(event) => void assign(account, event.target.value as RoleChoice)}
                    >
                      <RoleOptions roles={roles} />
                    </select>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {canManage ? null : (
            <p className="stamp" style={{ marginTop: 16 }}>
              An admin can add people and roles.
            </p>
          )}
        </article>
      </section>

      <section className="sec">
        <div className="sechead">
          <div>
            <h3>Roles</h3>
            <p>
              Admin, Manager and Office are built in. Add job roles such as Production head, Accountant or QC and stores;
              each gives its holders manager access (finance included) or office access.
            </p>
          </div>
        </div>
        <article className="card p6" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 }}>
          <div className="rels">
            {ROLES.map((role) => {
              const holders = (accounts ?? []).filter((account) => account.role === role && !account.jobRole)
              return (
                <div className="rel" key={role} style={{ gridTemplateColumns: '1fr' }}>
                  <div>
                    <div className="relname">
                      <b>{roleLabel(role)}</b>
                      <span className="pill grey">Built in</span>
                    </div>
                    <div className="stamp">{holders.length ? holders.map((account) => account.name).join(', ') : 'Nobody holds this role'}</div>
                  </div>
                </div>
              )
            })}
            {roles.map((role) => {
              const holders = (accounts ?? []).filter((account) => account.jobRole?.id === role.id)
              return (
                <div className="rel" key={role.id} style={{ gridTemplateColumns: '1fr' }}>
                  <div>
                    <div className="relname">
                      <b>{role.name}</b>
                      <span className={rolePillClass(role.accessRole)}>{roleLabel(role.accessRole)} access</span>
                    </div>
                    <div className="stamp">{holders.length ? holders.map((account) => account.name).join(', ') : 'Nobody holds this role'}</div>
                  </div>
                </div>
              )
            })}
          </div>
          {canManage ? (
            <form
              className="formgrid"
              onSubmit={(event) => {
                event.preventDefault()
                void addRole()
              }}
            >
              <div className="field">
                <label htmlFor="role-name">New role</label>
                <input id="role-name" value={roleName} onChange={(event) => setRoleName(event.target.value)} placeholder="Production head" autoComplete="off" />
              </div>
              <div className="field">
                <label htmlFor="role-access">Access</label>
                <select id="role-access" value={roleAccess} onChange={(event) => setRoleAccess(event.target.value as JobAccessRole)}>
                  {JOB_ACCESS_ROLES.map((access) => (
                    <option key={access} value={access}>
                      {roleLabel(access)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="actions">
                <button type="submit" className="btn-pri" disabled={rolePending || !roleName.trim()}>
                  Add role
                </button>
              </div>
            </form>
          ) : null}
          {roleError ? <p className="formerror" role="alert">{roleError}</p> : null}
        </article>
      </section>
    </>
  )
}
