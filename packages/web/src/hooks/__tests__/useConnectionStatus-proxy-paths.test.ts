// @vitest-environment node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(testDir, '../useConnectionStatus.ts'), 'utf8');

describe('useConnectionStatus reverse-proxy paths', () => {
  it('probes health endpoints through the same /api/ reverse-proxy boundary', () => {
    expect(src).toContain("probePublicEndpoint('/api/health')");
    expect(src).toContain("probePublicEndpoint('/api/ready')");
    expect(src).not.toContain("probePublicEndpoint('/health')");
    expect(src).not.toContain("probePublicEndpoint('/ready')");
  });
});
