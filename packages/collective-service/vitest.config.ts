import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    pool: 'forks',
    // Native Windows ACL checks launch PowerShell; multi-commit cases exceed
    // Vitest's 5s default even when each operation succeeds.
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
  },
});
