import { describe, expect, it } from 'vitest'
import { TIERRA_HEADER } from './brand'
import { whatsappText } from './format'

describe('whatsappText', () => {
  it('turns Markdown bold into WhatsApp bold', () => {
    expect(whatsappText('1. **Beyond Snack** - PO-BS-1048 for 100 pouches')).toBe('1. *Beyond Snack* - PO-BS-1048 for 100 pouches')
    expect(whatsappText('Total ***₹83,746.66***')).toBe('Total *₹83,746.66*')
  })

  it('keeps WhatsApp markup and the bot header as they are', () => {
    const text = `${TIERRA_HEADER}\n\nApprove sales order *TSO/26-27/0001*. Reply _send back_ or ~ignore~.`
    expect(whatsappText(text)).toBe(text)
  })

  it('drops asterisks that do not make a bold pair', () => {
    expect(whatsappText('Total *₹100 and * more')).toBe('Total ₹100 and more')
    expect(whatsappText('Free stock* is low')).toBe('Free stock is low')
    expect(whatsappText('* bold with spaces *')).toBe('- bold with spaces')
  })

  it('rewrites headings, bullets, strikethrough and links', () => {
    expect(whatsappText('## Open orders')).toBe('*Open orders*')
    expect(whatsappText('* one\n  + two')).toBe('- one\n  - two')
    expect(whatsappText('~~old~~ new')).toBe('~old~ new')
    expect(whatsappText('See [the PDF](https://example.com/a.pdf) or [it](/api/documents/1)')).toBe(
      'See the PDF (https://example.com/a.pdf) or it',
    )
  })

  it('leaves code blocks alone', () => {
    const text = '```\na ** b\n```'
    expect(whatsappText(text)).toBe(text)
  })
})
