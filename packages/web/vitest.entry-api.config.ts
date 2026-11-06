import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// The compiled API is prepared explicitly in the Build lane, not required by light unit tests.
// The unit projects would bring back the whole unit suite, so this config keeps only the shared options.
const { projects: _unitProjects, ...shared } = base.test ?? {};

export default defineConfig({
  ...base,
  test: { ...shared, include: ['test/integration/first-run-entry-personal-lifecycle.test.tsx'] },
});
