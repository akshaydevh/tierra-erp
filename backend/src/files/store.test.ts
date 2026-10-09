import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FsFileStore, S3FileStore, assertKey, createFileStore, fileStoreWarning } from './store'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tierra-files-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const KEY = 'sap/ab/cd/abcd0000000000000000000000000000000000000000000000000000000000ff.pdf'

describe('fs file store', () => {
  it('stores, finds and reads a file under its content-addressed key', async () => {
    const store = new FsFileStore(tempDir())
    expect(await store.has(KEY)).toBe(false)
    expect(await store.get(KEY)).toBeNull()
    await store.put(KEY, Buffer.from('%PDF-1.4 test'))
    expect(await store.has(KEY)).toBe(true)
    expect((await store.get(KEY))?.toString()).toBe('%PDF-1.4 test')
    expect(store.presignedUrl).toBeUndefined()
  })

  it('refuses keys that could leave the store', async () => {
    const store = new FsFileStore(tempDir())
    for (const key of ['../secret', '/etc/passwd', 'sap/../../x', 'sap//x', 'sap/./x', '', 'a\\b', 'sap/ab/ü.pdf']) {
      expect(() => assertKey(key), key).toThrow()
      await expect(store.get(key), key).rejects.toThrow()
      await expect(store.put(key, Buffer.from('x')), key).rejects.toThrow()
    }
  })
})

describe('FILE_STORE', () => {
  it('reads fs:<dir>, defaults to ./data/files and needs the bucket settings for s3', () => {
    const dir = tempDir()
    expect(createFileStore(`fs:${dir}`, {})).toMatchObject({ kind: 'fs', root: dir })
    expect(createFileStore('', {})).toMatchObject({ kind: 'fs', root: join(process.cwd(), 'data', 'files') })
    expect(() => createFileStore('s3', { bucket: 'b' })).toThrow('FILE_STORE=s3 but S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY are not set.')
    expect(() => createFileStore('s3', { endpoint: 'https://s3.example.test', bucket: 'b', accessKeyId: 'k', secretAccessKey: ' ' })).toThrow(
      'FILE_STORE=s3 but S3_SECRET_ACCESS_KEY is not set.',
    )
    expect(createFileStore('s3', { endpoint: 'https://s3.example.test', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }).kind).toBe('s3')
    expect(() => createFileStore('ftp://x', {})).toThrow(/fs:<dir> or s3/)
  })

  it('warns a production server on a local directory, and nobody else', () => {
    expect(fileStoreWarning({ kind: 'fs' }, true)).toContain('FILE_STORE is fs: attachments will be missing after each deploy; set FILE_STORE=s3 and S3_*')
    expect(fileStoreWarning({ kind: 'fs' }, false)).toBeNull()
    expect(fileStoreWarning({ kind: 's3' }, true)).toBeNull()
  })

  it('presigns a 10-minute path-style GET on an S3-compatible endpoint, offline', async () => {
    const store = new S3FileStore({
      endpoint: 'https://bucket.example.test',
      bucket: 'tierra-files',
      region: 'auto',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'not-a-real-secret',
    })
    const url = new URL(await store.presignedUrl(KEY, { fileName: 'AR Invoice [Approved]_1.pdf', mime: 'application/pdf' }))
    expect(url.origin).toBe('https://bucket.example.test')
    expect(url.pathname).toBe(`/tierra-files/${KEY}`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600')
    expect(url.searchParams.get('response-content-type')).toBe('application/pdf')
    expect(url.searchParams.get('response-content-disposition')).toContain('AR%20Invoice%20%5BApproved%5D_1.pdf')
  })
})

describe('S3 URL style', () => {
  it('uses path style by default and virtual-host when asked (Railway buckets)', async () => {
    const { usesPathStyle } = await import('./store')
    expect([usesPathStyle(undefined), usesPathStyle(''), usesPathStyle('path')]).toEqual([true, true, true])
    expect([usesPathStyle('virtual-host'), usesPathStyle('Virtual')]).toEqual([false, false])
    expect(() => usesPathStyle('host')).toThrow(/S3_URL_STYLE must be path or virtual-host/)
  })
})
