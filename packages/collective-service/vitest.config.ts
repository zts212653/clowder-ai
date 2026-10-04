import { defineConfig } from 'vitest/config';
import { vitestReporters } from '../../scripts/test-file-timing/vitest-file-timing-reporter.mjs';

export default defineConfig({
  test: {
    reporters: vitestReporters(),
    include: ['src/__tests__/**/*.test.ts'],
    pool: 'forks',
  },
});
