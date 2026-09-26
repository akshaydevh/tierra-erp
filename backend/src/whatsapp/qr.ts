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

export function phoneFromPayload(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const candidates = [record.wuid, record.number, record.owner, record.phone]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    const digits = candidate.replace(/@.*/, '').replace(/\D/g, '')
    if (digits.length >= 8) return digits
  }
  return null
}

export function chatNumber(jid: string): string {
  return jid.replace(/@.*/, '').replace(/\D/g, '')
}
