import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// The compiled API is prepared explicitly in the Build lane, not required by light unit tests.
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['test/integration/first-run-entry-personal-lifecycle.test.tsx'] },
});
