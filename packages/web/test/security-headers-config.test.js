/**
 * F156 Phase D-2 P1-2: Anti-clickjacking headers on Next.js frontend
 *
 * Verifies next.config.js exports headers() that set:
 * - X-Frame-Options: DENY
 * - Content-Security-Policy: frame-ancestors 'none'
 *
 * These protect the actual Hub UI pages (port 3003), not just API (port 3004).
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);

describe('F156 D-2: Next.js anti-clickjacking headers', () => {
  it('next.config.js exports headers() with X-Frame-Options and CSP', async () => {
    const config = require('../next.config.js');

    assert.ok(typeof config.headers === 'function', 'next.config.js must export headers()');

    const headers = await config.headers();
    assert.ok(Array.isArray(headers), 'headers() must return an array');

    const catchAll = headers.find((h) => h.source === '/:path*');
    assert.ok(catchAll, 'must have a catch-all source /:path*');

    const xfo = catchAll.headers.find((h) => h.key === 'X-Frame-Options');
    assert.ok(xfo, 'must include X-Frame-Options header');
    assert.equal(xfo.value, 'DENY');

    const csp = catchAll.headers.find((h) => h.key === 'Content-Security-Policy');
    assert.ok(csp, 'must include Content-Security-Policy header');
    assert.ok(
      csp.value.includes("frame-ancestors 'none'"),
      `CSP must include frame-ancestors 'none', got: ${csp.value}`,
    );
  });
});
