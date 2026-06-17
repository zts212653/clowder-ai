import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only vitest-runner tests. Most shared tests use node:test (import from 'node:test')
    // and run separately via `node --test`. Vitest tests import from 'vitest'.
    include: ['test/pet-skin-projection.test.js'],
  },
});
