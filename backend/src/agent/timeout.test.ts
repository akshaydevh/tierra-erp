import { afterEach, describe, expect, it, vi } from 'vitest'
import { withTimeout } from './timeout'

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes a result through', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1_000, 'The judge')).resolves.toBe('ok')
  })

  it('gives up on a call that never answers', async () => {
    vi.useFakeTimers()
    const hanging = withTimeout(new Promise<string>(() => {}), 30_000, 'The judge')
    const outcome = expect(hanging).rejects.toThrow('The judge took longer than 30 s')
    await vi.advanceTimersByTimeAsync(30_000)
    await outcome
  })
})
