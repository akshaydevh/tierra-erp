export function normalizeQr(value: string | null): string | null {
  if (!value) return null
  if (value.startsWith('data:image')) return value
  if (value.length > 200) return `data:image/png;base64,${value}`
  return value
}

export function qrFromPayload(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const nested =
    record.qrcode && typeof record.qrcode === 'object'
      ? (record.qrcode as Record<string, unknown>)
      : null
  const candidates = [nested?.base64, record.base64, nested?.code, record.code, record.qrcode]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return normalizeQr(candidate)
  }
  return null
}

export function phoneDigits(value: string | null | undefined): string {
  if (!value) return ''
  const local = value.trim().replace(/@.*/, '')
  const user = local.split(':')[0] ?? ''
  return user.replace(/\D/g, '')
}

export function phoneFromPayload(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const nested =
    record.instance && typeof record.instance === 'object'
      ? (record.instance as Record<string, unknown>)
      : null
  const candidates = [
    record.wuid,
    record.ownerJid,
    record.owner,
    record.number,
    record.phone,
    nested?.wuid,
    nested?.ownerJid,
    nested?.owner,
    nested?.number,
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    const digits = phoneDigits(candidate)
    if (digits.length >= 8 && digits.length <= 15) return digits
  }
  return null
}

export function chatNumber(jid: string): string {
  return phoneDigits(jid)
}

function instanceRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  for (const key of ['instances', 'data']) {
    if (Array.isArray(record[key])) return record[key]
  }
  return [value]
}

export function ownerPhoneFromInstances(value: unknown): string | null {
  const rows = instanceRows(value)
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const nested =
      record.instance && typeof record.instance === 'object'
        ? (record.instance as Record<string, unknown>)
        : null
    const name = [record.name, record.instanceName, nested?.instanceName].find(
      (item) => typeof item === 'string',
    )
    if (typeof name === 'string' && name !== 'tierra') continue
    const phone = phoneFromPayload(record) ?? (nested ? phoneFromPayload(nested) : null)
    if (phone) return phone
  }
  return null
}
