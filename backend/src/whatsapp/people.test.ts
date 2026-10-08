import { describe, expect, it } from 'vitest'
import type { AccountLink } from '../db/types'
import { parseWebhook } from './parse'
import { normalizePhone, phonesExact, phonesMatch, resolvePeople } from './people'

describe('phonesExact', () => {
  it('matches the same digits however they are written', () => {
    expect(phonesExact('+91 98123 45678', '919812345678@s.whatsapp.net')).toBe(true)
    expect(phonesExact('919812345678', '919812345678:3@s.whatsapp.net')).toBe(true)
  })

  it('does not match a number without its country code', () => {
    expect(phonesExact('919812345678', '9812345678')).toBe(false)
    expect(phonesMatch('919812345678', '9812345678')).toBe(true)
  })

  it('needs at least eight digits', () => {
    expect(phonesExact('1234567', '1234567')).toBe(false)
    expect(phonesExact(null, null)).toBe(false)
    expect(phonesExact('', '')).toBe(false)
  })
})

describe('normalizePhone', () => {
  it('adds the default country code to a 10-digit mobile number', () => {
    expect(normalizePhone('98470 12345')).toBe('919847012345')
    expect(normalizePhone('098470 12345')).toBe('919847012345')
    expect(normalizePhone('98470 12345', '1')).toBe('19847012345')
  })

  it('keeps a number that already has its country code', () => {
    expect(normalizePhone('+91 98470 12345')).toBe('919847012345')
    expect(normalizePhone('+44 7700 900123')).toBe('447700900123')
  })

  it('refuses a number it cannot complete', () => {
    expect(normalizePhone('12345678')).toBeNull()
    expect(normalizePhone('4734 222 333')).toBeNull()
    expect(normalizePhone('0473 4222333')).toBeNull()
    expect(normalizePhone('1234567890123456')).toBeNull()
    expect(normalizePhone('')).toBeNull()
  })
})

describe('resolvePeople', () => {
  const accounts: AccountLink[] = [
    { id: 'usr_alex', name: 'Alex Thomas', email: 'alex@tierra.in', role: 'admin', phoneNumber: '919800000009' },
    { id: 'usr_joshy', name: 'Joshy', email: 'joshy@tierra.in', role: 'manager', phoneNumber: '919812345678' },
  ]

  it('gives each person their user id', () => {
    const event = parseWebhook({
      event: 'messages.upsert',
      instance: 'tierra',
      data: {
        key: { id: 'M1', remoteJid: '919812345678@s.whatsapp.net', fromMe: false },
        message: {
          extendedTextMessage: { text: 'ask Alex', contextInfo: { mentionedJid: ['919800000009@s.whatsapp.net'] } },
        },
      },
    })
    if (event.type !== 'message') throw new Error('expected a message')
    const people = resolvePeople(event.message, 'personal', accounts, '919800000001')
    expect(people.speaker).toEqual({ userId: 'usr_joshy', name: 'Joshy', role: 'manager', phoneNumber: '919812345678' })
    expect(people.mentioned.map((person) => person.userId)).toEqual(['usr_alex'])
  })

  it('does not take a number without its country code for a linked account', () => {
    const event = parseWebhook({
      event: 'messages.upsert',
      instance: 'tierra',
      data: {
        key: { id: 'M2', remoteJid: '9812345678@s.whatsapp.net', fromMe: false },
        message: { conversation: 'ask 9800000009 and 449800000009' },
      },
    })
    if (event.type !== 'message') throw new Error('expected a message')
    const people = resolvePeople(event.message, 'personal', accounts, '919800000001')
    expect(people.speaker).toBeNull()
    expect(people.mentioned).toEqual([])
  })
})
