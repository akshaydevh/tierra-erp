export const TYPESAFE_TIMEOUT_MS = 30_000

/** Rejects when `work` has not settled within `ms`, for clients that take no AbortSignal. */
export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} took longer than ${ms / 1000} s`)), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}
