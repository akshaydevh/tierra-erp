'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { JOB_ACCESS_ROLES, roleLabel, type AccountLink, type JobAccessRole, type JobRole, type Me, type Role } from '@/lib/types'

const MIN_PASSWORD_LENGTH = 8

type PersonDraft = {
  name: string
  email: string
  password: string
  jobRoleId: string
  accessRole: JobAccessRole
  phoneNumber: string
}

const EMPTY_PERSON: PersonDraft = { name: '', email: '', password: '', jobRoleId: '', accessRole: 'office', phoneNumber: '' }

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
  onCancel,
  onSaved,
}: {
  roles: JobRole[]
  onCancel: () => void
  onSaved: (accounts: AccountLink[]) => void
}) {
  const [value, setValue] = useState<PersonDraft>(EMPTY_PERSON)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const jobRole = roles.find((role) => role.id === value.jobRoleId)
  const ready = value.name.trim() && value.email.trim() && value.password.length >= MIN_PASSWORD_LENGTH

  async function save() {
    setPending(true)
    setError('')
    const response = await fetch('/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: value.name,
        email: value.email,
        password: value.password,
        jobRoleId: value.jobRoleId || null,
        accessRole: value.accessRole,
        phoneNumber: value.phoneNumber,
      }),
    })
    setPending(false)
    const body = await readJson<{ error?: string; accounts?: AccountLink[] }>(response)
    if (!response.ok) {
      setError(body?.error ?? 'Could not add that person')
      return
    }
    onSaved(body?.accounts ?? [])
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
          <select id="person-role" value={value.jobRoleId} onChange={(event) => setValue({ ...value, jobRoleId: event.target.value })}>
            <option value="">No role</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="person-access">Access</label>
          {jobRole ? (
            <select id="person-access" value={jobRole.accessRole} disabled>
              <option value={jobRole.accessRole}>{roleLabel(jobRole.accessRole)} (from role)</option>
            </select>
          ) : (
            <select
              id="person-access"
              value={value.accessRole}
              onChange={(event) => setValue({ ...value, accessRole: event.target.value as JobAccessRole })}
            >
              {JOB_ACCESS_ROLES.map((access) => (
                <option key={access} value={access}>
                  {roleLabel(access)}
                </option>
              ))}
            </select>
          )}
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
      <p className="stamp">Share the password with them. They can sign in straight away.</p>
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

  async function assign(account: AccountLink, jobRoleId: string) {
    if (jobRoleId === (account.jobRole?.id ?? '')) return
    setPendingId(account.id)
    setRowErrors((current) => ({ ...current, [account.id]: '' }))
    const response = await fetch(`/api/users/${account.id}/job-role`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobRoleId: jobRoleId || null }),
    })
    setPendingId(null)
    const body = await readJson<{ error?: string; accounts?: AccountLink[] }>(response)
    if (!response.ok) {
      setRowErrors((current) => ({ ...current, [account.id]: body?.error ?? 'Could not change that role' }))
      return
    }
    if (body?.accounts) setAccounts(body.accounts)
    if (account.id === me.id) router.refresh()
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
              Everyone who signs in to Tierra or messages Tierra Bot. Their role sets what they can see and do: a role with
              manager access sees finance, office access does not. The admin is set from Settings.
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
            onCancel={() => setAdding(false)}
            onSaved={(next) => {
              setAccounts(next)
              setAdding(false)
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
                    {account.jobRole ? <span className="pill ink">{account.jobRole.name}</span> : null}
                    <span className={rolePillClass(account.role)}>{roleLabel(account.role)} access</span>
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
                    <label className="sr" htmlFor={`jobrole-${account.id}`}>
                      Role for {account.name}
                    </label>
                    <select
                      id={`jobrole-${account.id}`}
                      value={account.jobRole?.id ?? ''}
                      disabled={pendingId === account.id}
                      onChange={(event) => void assign(account, event.target.value)}
                    >
                      <option value="">No role</option>
                      {roles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
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
              Job roles at Tierra, such as Production head, Accountant or QC and stores. Each gives its holders manager or
              office access. Giving someone a role sets their access to match, except the admin, who stays admin.
            </p>
          </div>
        </div>
        <article className="card p6" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 }}>
          {roles.length === 0 ? <p className="stamp">No roles yet.</p> : null}
          <div className="rels">
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
