import type { TableCell } from 'pdfmake/interfaces'
import { amountInWords, formatInr, letterhead, renderPdf } from './kit'

const SAMPLE_LINES = [
  { item: 'Banana chips 80g', amount: 1891.34 },
  { item: 'Tapioca chips 200g', amount: 81855.32 },
  { item: 'Large amount check', amount: 10362927 },
]

function istTimestamp(now: Date): string {
  const text = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
  return `${text} IST`
}

export function renderTestPdf(now: Date): Promise<Buffer> {
  const total = SAMPLE_LINES[SAMPLE_LINES.length - 1].amount
  const rows: TableCell[][] = [
    [{ text: 'Item', bold: true }, { text: 'Amount', bold: true, alignment: 'right' }],
    ...SAMPLE_LINES.map((line): TableCell[] => [line.item, { text: formatInr(line.amount), alignment: 'right' }]),
  ]
  return renderPdf({
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 40],
    info: { title: 'Test document', author: 'Tierra Bot' },
    content: [
      letterhead(),
      { text: 'Test document', bold: true, fontSize: 16, margin: [0, 0, 0, 8] },
      { text: 'This page checks fonts, the ₹ sign and Indian number formatting.', margin: [0, 0, 0, 12] },
      {
        table: {
          headerRows: 1,
          widths: ['*', 'auto'],
          body: rows,
        },
        layout: 'lightHorizontalLines',
      },
      { text: amountInWords(total), italics: true, margin: [0, 12, 0, 0] },
      { text: `Rendered ${istTimestamp(now)}`, fontSize: 8, color: '#666666', margin: [0, 24, 0, 0] },
    ],
  })
}
