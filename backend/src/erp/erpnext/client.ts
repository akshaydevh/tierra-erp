/**
 * The ERPNext REST API, as the service user (token auth). The only way Tierra writes ERP data: never SQL into
 * ERPNext's database, which would skip its validation and its stock and general ledger postings.
 */

export type ErpnextConfig = {
  url: string
  /** The site name; the ERPNext nginx picks the site by the Host header. */
  site: string
  apiKey: string
  apiSecret: string
  company: string
}

export class ErpnextError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly excType: string | null,
  ) {
    super(message)
  }
}

type Doc = Record<string, unknown> & { name: string }

/** ERPNext's own message for a refused request (_server_messages is a JSON list of JSON objects), in plain words. */
export function erpnextMessage(body: unknown, fallback: string): string {
  const b = (body ?? {}) as { _server_messages?: string; exception?: string; message?: unknown }
  const messages: string[] = []
  if (b._server_messages) {
    try {
      for (const raw of JSON.parse(b._server_messages) as string[]) {
        try {
          messages.push(String((JSON.parse(raw) as { message?: unknown }).message ?? raw))
        } catch {
          messages.push(String(raw))
        }
      }
    } catch {
      // not the usual shape; fall through
    }
  }
  if (!messages.length && b.exception) messages.push(b.exception)
  const text = (messages.join(' ') || fallback).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  return text.length > 400 ? `${text.slice(0, 397)}...` : text
}

export class ErpnextClient {
  constructor(
    readonly config: ErpnextConfig,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchFn(`${this.config.url.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        Host: this.config.site,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `token ${this.config.apiKey}:${this.config.apiSecret}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!response.ok) {
      const exc = (json as { exc_type?: string } | null)?.exc_type ?? null
      throw new ErpnextError(response.status, erpnextMessage(json, `ERPNext answered ${response.status}`), exc)
    }
    return json as T
  }

  async list<T = Doc>(doctype: string, filters: unknown[], fields: string[], limit = 100): Promise<T[]> {
    const q = new URLSearchParams({
      filters: JSON.stringify(filters),
      fields: JSON.stringify(fields),
      limit_page_length: String(limit),
    })
    const out = await this.request<{ data: T[] }>('GET', `/api/resource/${encodeURIComponent(doctype)}?${q}`)
    return out.data
  }

  /** Inserts a document; docstatus 1 in the document inserts and submits it in one call. */
  async insert(doc: Record<string, unknown> & { doctype: string }): Promise<Doc> {
    const out = await this.request<{ data: Doc }>('POST', `/api/resource/${encodeURIComponent(doc.doctype)}`, doc)
    return out.data
  }

  async get(doctype: string, name: string): Promise<Doc> {
    const out = await this.request<{ data: Doc }>(
      'GET',
      `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
    )
    return out.data
  }
}
