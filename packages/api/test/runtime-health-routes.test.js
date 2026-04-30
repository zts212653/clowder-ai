import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(testDir, '../src/index.ts'), 'utf8');

describe('runtime health routes', () => {
  it('keeps root probes while exposing /api/* aliases for same-origin reverse proxies', () => {
    assert.match(src, /app\.get\('\/health',\s*healthHandler\)/);
    assert.match(src, /app\.get\('\/api\/health',\s*healthHandler\)/);
    assert.match(src, /app\.get\('\/ready',\s*readyHandler\)/);
    assert.match(src, /app\.get\('\/api\/ready',\s*readyHandler\)/);
  });
});
