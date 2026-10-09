import { describe, expect, it } from 'vitest'
import {
  hasDoubt,
  isApproveEmoji,
  isApproveReply,
  isStop,
  looksLikeQuestion,
  parseIntent,
  sendBackNote,
  unquotedApprove,
} from './approval-match'

describe('approval matching', () => {
  it('takes 👍 ✅ 👌 in any skin tone and nothing else', () => {
    for (const emoji of ['👍', '👍🏻', '👍🏿', '✅', '👌🏽', '👍️']) expect(isApproveEmoji(emoji)).toBe(true)
    for (const emoji of ['👀', '❤️', '🙏', '', '👎']) expect(isApproveEmoji(emoji)).toBe(false)
  })

  it('approves on the whole-text lexicon only, never with doubt or negation', () => {
    for (const text of ['approve', 'Approved.', 'ok', 'OK!', 'okay', 'yes', 'go ahead', 'send it', 'ok approved', 'yes, go ahead', '👍', 'approved 👍']) {
      expect(isApproveReply(text), text).toBe(true)
    }
    for (const text of [
      'is the price ok?',
      'not ok yet',
      "don't send",
      'ok but change the date',
      'hold',
      'wait',
      'later',
      'no',
      'ok?',
      'approve after Joshy checks',
      'send it back',
      'yes the price looks low',
    ]) {
      expect(isApproveReply(text), text).toBe(false)
    }
    expect(hasDoubt('ok, but wait for the carton')).toBe(true)
  })

  it('reads unquoted approve with or without a TSO number', () => {
    expect(unquotedApprove('approve')).toEqual({ docNo: null })
    expect(unquotedApprove('Approved.')).toEqual({ docNo: null })
    expect(unquotedApprove('approve TSO/26-27/0001')).toEqual({ docNo: 'TSO/26-27/0001' })
    expect(unquotedApprove('approve tso 3')).toEqual({ docNo: '3' })
    expect(unquotedApprove('approve the cartons')).toBeNull()
    expect(unquotedApprove('ok')).toBeNull()
  })

  it('reads send back notes, stop and questions', () => {
    expect(sendBackNote('send back: price on line 2 is wrong')).toBe('price on line 2 is wrong')
    expect(sendBackNote('Send it back - deliver by 5 Aug')).toBe('deliver by 5 Aug')
    expect(sendBackNote('send back')).toBe('')
    expect(sendBackNote('send pdf again')).toBeNull()
    expect(isStop('stop')).toBe(true)
    expect(isStop('Stop!')).toBe(true)
    expect(isStop('stop the line')).toBe(false)
    expect(looksLikeQuestion("what's the delivery date")).toBe(true)
    expect(looksLikeQuestion('why make line 2')).toBe(true)
    expect(looksLikeQuestion('send pdf again')).toBe(false)
  })

  it('treats an unreadable model answer as a question', () => {
    expect(parseIntent('{"intent":"approve","note":null}')).toEqual({ intent: 'approve', note: null })
    expect(parseIntent('Sure: {"intent": "send_back", "note": "fix the date"}')).toEqual({ intent: 'send_back', note: 'fix the date' })
    expect(parseIntent('{"intent":"yolo"}')).toEqual({ intent: 'question', note: null })
    expect(parseIntent('not json')).toEqual({ intent: 'question', note: null })
    expect(parseIntent(null)).toEqual({ intent: 'question', note: null })
  })
})
