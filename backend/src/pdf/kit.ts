import path from 'node:path'
import PdfPrinter from 'pdfmake'
import type { Content, TDocumentDefinitions, TFontDictionary } from 'pdfmake/interfaces'

export const COMPANY = {
  name: 'Tierra Food India Private Limited',
  address: ['KINFRA Food Processing Park, Elamannoor P O', 'Adoor, Kerala 691524'],
  gstin: '32AADCT3129P2Z5',
  email: 'contact@tierra.in',
}

function fontDictionary(): TFontDictionary {
  const dir = path.join(process.cwd(), 'assets', 'fonts')
  return {
    NotoSans: {
      normal: path.join(dir, 'NotoSans-Regular.ttf'),
      bold: path.join(dir, 'NotoSans-Bold.ttf'),
      italics: path.join(dir, 'NotoSans-Italic.ttf'),
      bolditalics: path.join(dir, 'NotoSans-BoldItalic.ttf'),
    },
  }
}

let printer: PdfPrinter | null = null

export function renderPdf(docDefinition: TDocumentDefinitions): Promise<Buffer> {
  printer ??= new PdfPrinter(fontDictionary())
  const doc = printer.createPdfKitDocument({
    ...docDefinition,
    defaultStyle: { font: 'NotoSans', fontSize: 10, ...docDefinition.defaultStyle },
  })
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    doc.end()
  })
}

function toPaise(n: number): number {
  return Math.round(Number((Math.abs(n) * 100).toPrecision(15)))
}

const inrDigits = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function formatInr(n: number): string {
  const paise = toPaise(n)
  const sign = n < 0 && paise > 0 ? '-' : ''
  return `${sign}₹${inrDigits.format(paise / 100)}`
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
]
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function belowHundred(n: number): string[] {
  if (n < 20) return n ? [ONES[n]] : []
  return [TENS[Math.floor(n / 10)], ...(n % 10 ? [ONES[n % 10]] : [])]
}

function indianWords(n: number): string[] {
  if (n >= 10_000_000) {
    return [...indianWords(Math.floor(n / 10_000_000)), 'Crore', ...indianWords(n % 10_000_000)]
  }
  const words: string[] = []
  const lakh = Math.floor(n / 100_000)
  const thousand = Math.floor((n % 100_000) / 1000)
  const hundred = Math.floor((n % 1000) / 100)
  if (lakh) words.push(...belowHundred(lakh), 'Lakh')
  if (thousand) words.push(...belowHundred(thousand), 'Thousand')
  if (hundred) words.push(ONES[hundred], 'Hundred')
  words.push(...belowHundred(n % 100))
  return words
}

export function amountInWords(n: number): string {
  const total = toPaise(n)
  const rupees = Math.floor(total / 100)
  const paise = total % 100
  const sign = n < 0 && total > 0 ? 'Minus ' : ''
  const rupeeWords = rupees ? indianWords(rupees).join(' ') : 'Zero'
  const paiseWords = paise ? ` and ${belowHundred(paise).join(' ')} Paise` : ''
  return `${sign}Rupees ${rupeeWords}${paiseWords} Only`
}

export function letterhead(): Content {
  return {
    stack: [
      { text: COMPANY.name, bold: true, fontSize: 14 },
      { text: COMPANY.address.join(', '), fontSize: 9 },
      { text: `GSTIN ${COMPANY.gstin}  ·  ${COMPANY.email}`, fontSize: 9 },
      { canvas: [{ type: 'line', x1: 0, y1: 6, x2: 515, y2: 6, lineWidth: 0.75 }], margin: [0, 0, 0, 12] },
    ],
  }
}
