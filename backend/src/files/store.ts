import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

/**
 * Where file bytes live: SAP attachments (keys sap/ab/cd/<sha256>.<ext>, written by `run.py attachments`) and, later,
 * generated PDFs. Keys are content-addressed and written once.
 * - fs: a local directory (development, tests); the backend streams the bytes itself.
 * - s3: any S3-compatible bucket (a Railway bucket, R2, MinIO) with path-style addressing; a reader gets a
 *   10-minute presigned URL instead of the bytes passing through the backend.
 */
export interface FileStore {
  readonly kind: 'fs' | 's3'
  put(key: string, body: Buffer, mime: string): Promise<void>
  /** The bytes, or null when nothing is stored under the key. */
  get(key: string): Promise<Buffer | null>
  has(key: string): Promise<boolean>
  /** A time-limited GET URL (s3 only). */
  presignedUrl?(key: string, options?: { expiresInSeconds?: number; fileName?: string; mime?: string }): Promise<string>
}

export const PRESIGN_SECONDS = 10 * 60

/** Keys are ours (sap/ab/cd/<sha>.pdf, gen/so/<id>-v1.pdf): plain segments only, never "..", never absolute. */
const KEY = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/

export function assertKey(key: string): void {
  if (!KEY.test(key) || key.split('/').some((part) => part === '..' || part === '.') || key.length > 512) {
    throw new Error(`Not a file-store key: ${JSON.stringify(key)}`)
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT'
}

export class FsFileStore implements FileStore {
  readonly kind = 'fs' as const
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  private path(key: string): string {
    assertKey(key)
    const full = resolve(this.root, key)
    if (!full.startsWith(this.root + sep)) throw new Error(`Not a file-store key: ${JSON.stringify(key)}`)
    return full
  }

  async put(key: string, body: Buffer): Promise<void> {
    const full = this.path(key)
    await mkdir(dirname(full), { recursive: true })
    const part = `${full}.part`
    await writeFile(part, body)
    await rename(part, full)
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key))
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      return (await stat(this.path(key))).isFile()
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
  }
}

export type S3Env = {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** path (bucket in the URL path; MinIO) or virtual-host (bucket in the host name; Railway buckets). */
  urlStyle?: string
}

export function usesPathStyle(urlStyle: string | undefined): boolean {
  const style = (urlStyle ?? '').trim().toLowerCase()
  if (!style || style === 'path') return true
  if (style === 'virtual-host' || style === 'virtual') return false
  throw new Error(`S3_URL_STYLE must be path or virtual-host, not ${JSON.stringify(urlStyle)}`)
}

/** RFC 6266 attachment name for the presigned response: ASCII fallback plus the UTF-8 name. */
function dispositionFor(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

export class S3FileStore implements FileStore {
  readonly kind = 's3' as const
  private readonly client: S3Client

  constructor(private readonly env: S3Env) {
    this.client = new S3Client({
      endpoint: env.endpoint || undefined,
      region: env.region || 'auto',
      forcePathStyle: usesPathStyle(env.urlStyle),
      credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
    })
  }

  async put(key: string, body: Buffer, mime: string): Promise<void> {
    assertKey(key)
    await this.client.send(new PutObjectCommand({ Bucket: this.env.bucket, Key: key, Body: body, ContentType: mime }))
  }

  async get(key: string): Promise<Buffer | null> {
    assertKey(key)
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.env.bucket, Key: key }))
      if (!response.Body) return null
      return Buffer.from(await response.Body.transformToByteArray())
    } catch (error) {
      if (notFound(error)) return null
      throw error
    }
  }

  async has(key: string): Promise<boolean> {
    assertKey(key)
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.env.bucket, Key: key }))
      return true
    } catch (error) {
      if (notFound(error)) return false
      throw error
    }
  }

  async presignedUrl(key: string, options: { expiresInSeconds?: number; fileName?: string; mime?: string } = {}): Promise<string> {
    assertKey(key)
    const command = new GetObjectCommand({
      Bucket: this.env.bucket,
      Key: key,
      ResponseContentDisposition: options.fileName ? dispositionFor(options.fileName) : undefined,
      ResponseContentType: options.mime,
    })
    return getSignedUrl(this.client, command, { expiresIn: options.expiresInSeconds ?? PRESIGN_SECONDS })
  }
}

function notFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const named = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return named.name === 'NoSuchKey' || named.name === 'NotFound' || named.$metadata?.httpStatusCode === 404
}

export const DEFAULT_FILE_STORE = 'fs:./data/files'

const S3_VARIABLES = {
  endpoint: 'S3_ENDPOINT',
  bucket: 'S3_BUCKET',
  accessKeyId: 'S3_ACCESS_KEY_ID',
  secretAccessKey: 'S3_SECRET_ACCESS_KEY',
} as const

/**
 * FILE_STORE: `fs:<dir>` (default fs:./data/files, relative to the backend's working directory) or `s3`, which reads
 * S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY (all required), S3_REGION (default auto) and
 * S3_URL_STYLE (path, the default, or virtual-host for a Railway bucket).
 * A missing variable stops the server at boot with its name.
 */
export function createFileStore(spec: string, s3: Partial<S3Env>): FileStore {
  const value = spec.trim() || DEFAULT_FILE_STORE
  if (value === 's3') {
    const missing = (Object.keys(S3_VARIABLES) as Array<keyof typeof S3_VARIABLES>).filter((name) => !s3[name]?.trim())
    if (missing.length) {
      const names = missing.map((name) => S3_VARIABLES[name])
      throw new Error(`FILE_STORE=s3 but ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not set. Set ${names.length === 1 ? 'it' : 'them'} (S3_REGION is optional, default auto), or use FILE_STORE=fs:<dir>.`)
    }
    return new S3FileStore({
      endpoint: s3.endpoint!,
      bucket: s3.bucket!,
      region: s3.region || 'auto',
      accessKeyId: s3.accessKeyId!,
      secretAccessKey: s3.secretAccessKey!,
      urlStyle: s3.urlStyle,
    })
  }
  if (value.startsWith('fs:') && value.length > 3) return new FsFileStore(value.slice(3))
  throw new Error(`FILE_STORE must be fs:<dir> or s3, not ${JSON.stringify(value)}`)
}

/**
 * The boot warning for a production server on a local-directory store: a deploy replaces the container's disk, so
 * the attachments uploaded there are gone after each one. Null when there is nothing to say.
 */
export function fileStoreWarning(store: Pick<FileStore, 'kind'>, production: boolean): string | null {
  if (!production || store.kind !== 'fs') return null
  return 'WARNING: FILE_STORE is fs: attachments will be missing after each deploy; set FILE_STORE=s3 and S3_* (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY).'
}
