import { describe, expect, it } from 'vitest'
import pdfParse from 'pdf-parse'
import { amountInWords, formatInr } from './kit'
import { renderTestPdf } from './test-doc'

describe('formatInr', () => {
  it('groups in lakh and crore with two decimals', () => {
    expect(formatInr(10362927)).toBe('₹1,03,62,927.00')
    expect(formatInr(1891.34)).toBe('₹1,891.34')
    expect(formatInr(100000)).toBe('₹1,00,000.00')
  })

  it('handles zero, negatives and rounding to paise', () => {
    expect(formatInr(0)).toBe('₹0.00')
    expect(formatInr(-1891.34)).toBe('-₹1,891.34')
    expect(formatInr(-0.001)).toBe('₹0.00')
    expect(formatInr(1.005)).toBe('₹1.01')
    expect(formatInr(99.999)).toBe('₹100.00')
  })
})

describe('amountInWords', () => {
  it('uses the Indian numbering system', () => {
    expect(amountInWords(10362927)).toBe(
      'Rupees One Crore Three Lakh Sixty Two Thousand Nine Hundred Twenty Seven Only',
    )
    expect(amountInWords(1500000000)).toBe('Rupees One Hundred Fifty Crore Only')
    expect(amountInWords(110)).toBe('Rupees One Hundred Ten Only')
  })

  it('adds paise', () => {
    const words = amountInWords(83746.66)
    expect(words).toContain('Eighty Three Thousand Seven Hundred Forty Six')
    expect(words).toContain('Sixty Six Paise')
    expect(words).toBe('Rupees Eighty Three Thousand Seven Hundred Forty Six and Sixty Six Paise Only')
  })

  it('handles zero and negatives', () => {
    expect(amountInWords(0)).toBe('Rupees Zero Only')
    expect(amountInWords(-12)).toBe('Minus Rupees Twelve Only')
  })
})

describe('renderTestPdf', () => {
  it('renders a one-page A4 PDF with Indian amounts', async () => {
    const pdf = await renderTestPdf(new Date('2026-10-08T06:30:00Z'))
    expect(Buffer.isBuffer(pdf)).toBe(true)
    expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF')
    expect(pdf.length).toBeGreaterThan(5 * 1024)
    const { text } = await pdfParse(pdf)
    expect(text).toContain('1,03,62,927.00')
    expect(text).toContain('Tierra Food India Private Limited')
    expect(text).toContain('Rupees One Crore Three Lakh')
    expect(text).toContain('12:00 IST')
  })
})
