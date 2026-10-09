import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The Postgres suites run in parallel containers; a long workflow test (PO -> TSO with its PDFs) can pass 15 s
    // under that load while taking ~2 s alone, and a suite's beforeAll (container, migrations, fixture) 10 s.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
