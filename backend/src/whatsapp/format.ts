/**
 * WhatsApp has its own markup: *bold*, _italic_, ~strike~. Model replies often carry Markdown (**bold**, # headings,
 * [text](url)), which WhatsApp shows as stray asterisks and hashes. This rewrites a message into WhatsApp markup and
 * drops any asterisk that does not make a bold pair.
 */

const OPEN = '\u0000'
const CLOSE = '\u0001'

/** A WhatsApp bold pair on one line: *text*, with no space just inside the asterisks. */
const BOLD_PAIR = /\*([^\s*](?:[^*\n]*[^\s*])?)\*/g

function line(text: string): string {
  const converted = text
    .replace(/^(\s*)#{1,6}\s+(.+?)\s*#*\s*$/, '$1**$2**')
    .replace(/^(\s*)[*+]\s+/, '$1- ')
    .replace(/\*{2,3}([^*\n]+?)\*{2,3}/g, '*$1*')
    .replace(/~~([^~\n]+?)~~/g, '~$1~')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
  const kept = converted.replace(BOLD_PAIR, `${OPEN}$1${CLOSE}`)
  return kept
    .replace(/(\S) \* (\S)/g, '$1 $2')
    .replace(/\s+\*+\s*$/, '')
    .replace(/\*/g, '')
    .replaceAll(OPEN, '*')
    .replaceAll(CLOSE, '*')
}

export function whatsappText(text: string): string {
  let fenced = false
  return text
    .split('\n')
    .map((row) => {
      // Code blocks are shown as written.
      if (row.trimStart().startsWith('```')) {
        fenced = !fenced
        return row
      }
      return fenced ? row : line(row)
    })
    .join('\n')
}
