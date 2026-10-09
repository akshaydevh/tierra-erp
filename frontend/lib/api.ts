import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import type { DocFile, DocumentFilesResponse, Meta } from './types'

const apiUrl = process.env.API_URL ?? 'http://localhost:3002'

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`Request failed (${status})`)
  }
}

export async function api<T>(path: string): Promise<T> {
  const jar = await cookies()
  const token = jar.get('tierra_session')?.value
  const response = await fetch(`${apiUrl}${path}`, {
    headers: token ? { cookie: `tierra_session=${token}` } : {},
    cache: 'no-store',
  })
  if (response.status === 401) redirect('/login')
  if (!response.ok) throw new ApiError(response.status)
  return response.json() as Promise<T>
}

/** For detail pages: an unknown record renders the 404 page instead of an error. */
export async function apiOr404<T>(path: string): Promise<T> {
  try {
    return await api<T>(path)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound()
    throw error
  }
}

export function getMeta(): Promise<Meta> {
  return api<Meta>('/api/meta')
}

/**
 * SAP attachment files for some documents, keyed "<SAP object type>:<doc entry>" (13 invoice, 14 credit note,
 * 17 sales order, 18 A/P invoice, 20 GRN, 22 purchase order). A document without files has no key. An API error
 * gives no files: they are an extra, and the page renders without them.
 */
export async function documentFiles(keys: string[]): Promise<Record<string, DocFile[]>> {
  const wanted = [...new Set(keys)].slice(0, 200)
  if (wanted.length === 0) return {}
  try {
    return (await api<DocumentFilesResponse>(`/api/document-files?docs=${encodeURIComponent(wanted.join(','))}`)).files
  } catch (error) {
    if (error instanceof ApiError) return {}
    throw error
  }
}
