import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { readPassword } from './accounts'

const stdin = (text: string) => Readable.from([text])

describe('readPassword', () => {
  it('refuses a password on the command line', async () => {
    await expect(
      readPassword({ argvPassword: 'hunter2hunter2', envPassword: undefined, stdin: stdin('') }),
    ).rejects.toThrow('Do not put the password on the command line')
  })

  it('takes NEW_PASSWORD, or else the first line of stdin', async () => {
    expect(await readPassword({ argvPassword: undefined, envPassword: 'from-the-env', stdin: stdin('ignored\n') })).toBe(
      'from-the-env',
    )
    expect(await readPassword({ argvPassword: undefined, envPassword: undefined, stdin: stdin('typed-in-1\nmore\n') })).toBe(
      'typed-in-1',
    )
  })

  it('refuses a short or missing password', async () => {
    await expect(readPassword({ argvPassword: undefined, envPassword: undefined, stdin: stdin('') })).rejects.toThrow(
      'at least 8 characters',
    )
    await expect(readPassword({ argvPassword: undefined, envPassword: 'short', stdin: stdin('') })).rejects.toThrow(
      'at least 8 characters',
    )
  })
})
