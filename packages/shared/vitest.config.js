import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only vitest-runner tests. Most shared tests use node:test (import from 'node:test')
    // and run separately via `node --test`. Vitest tests import from 'vitest'.
    include: [
      'test/pet-skin-projection.test.js',
      'src/__tests__/capability-tips.test.ts',
      'src/__tests__/dispatch-proposal-types.test.ts',
      'src/__tests__/load-dossier-profiles.test.ts',
      'src/__tests__/parse-dossier-profiles.test.ts',
    ],
  },
});
