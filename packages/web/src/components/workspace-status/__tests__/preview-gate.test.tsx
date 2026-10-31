import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/app/dev/f322-status-preview/StatusPreview', () => ({ StatusPreview: () => null }));

import StatusPreviewPage from '@/app/dev/f322-status-preview/page';

afterEach(() => vi.unstubAllEnvs());
it('the author preview route returns 404 before constructing its fixture in production', () => {
  vi.stubEnv('NODE_ENV', 'production');
  expect(() => StatusPreviewPage()).toThrow();
});
