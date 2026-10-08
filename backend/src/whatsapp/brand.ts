export const TIERRA_HEADER = '> 🧞‍♂️ Tierra Bot:'

export function isBotEcho(text: string | null | undefined): boolean {
  return Boolean(text?.trim().startsWith(TIERRA_HEADER))
}
