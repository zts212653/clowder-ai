import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    pool: 'forks',
    // Native ACL validation launches hidden PowerShell on every read/write;
    // end-to-end pairing/replay cases perform many durable transactions.
    testTimeout: process.platform === 'win32' ? 60_000 : 5_000,
  },
});
