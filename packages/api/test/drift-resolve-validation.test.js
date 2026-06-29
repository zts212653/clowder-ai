// @ts-check

/**
 * Route-level validation tests for /api/drift/resolve (MCP type).
 *
 * Proves that the public route rejects malformed resolutions bodies
 * according to the resolver contract (VALID_MCP_DRIFT_DECISIONS).
 *
 * These tests exercise the Fastify route handler directly via inject(),
 * verifying that input validation happens at the HTTP boundary.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { unifiedDriftRoutes } = await import('../dist/routes/drift.js');

/** Auth headers that pass requireDriftWriteAccess (session + local + owner). */
const AUTH_HEADERS = {
  'x-test-session-user': 'you',
  host: 'localhost:3004',
  origin: 'http://localhost:3003',
};

/** Base body for MCP drift resolve. projectPath is intentionally invalid —
 * validation should reject before path validation for malformed resolutions. */
function resolveBody(resolutions) {
  return {
    type: 'mcp',
    action: 'sync',
    projectPath: '/tmp/nonexistent-project-for-validation-test',
    ...(resolutions !== undefined ? { resolutions } : {}),
  };
}

describe('/api/drift/resolve — resolutions validation', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) {
        request.sessionUserId = raw.trim();
      }
    });
    await app.register(unifiedDriftRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('accepts valid use-global resolution', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: resolveBody([{ mcpId: 'test-mcp', decision: 'use-global' }]),
    });
    // Should pass validation — may fail later on projectPath, but NOT on resolutions
    assert.notEqual(res.json().error, 'resolutions must be an array');
    assert.ok(!res.json().error?.includes('Invalid decision'));
  });

  it('accepts valid keep-project resolution', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: resolveBody([{ mcpId: 'test-mcp', decision: 'keep-project' }]),
    });
    assert.notEqual(res.json().error, 'resolutions must be an array');
    assert.ok(!res.json().error?.includes('Invalid decision'));
  });

  it('rejects non-array resolutions with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: resolveBody({ mcpId: 'test', decision: 'keep-project' }),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'resolutions must be an array');
  });

  it('rejects string resolutions with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: resolveBody('keep-project'),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'resolutions must be an array');
  });

  it('rejects invalid decision values with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: resolveBody([{ mcpId: 'test-mcp', decision: 'accept' }]),
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error.includes('Invalid decision "accept"'));
    assert.ok(res.json().error.includes('use-global'));
    assert.ok(res.json().error.includes('keep-project'));
  });

  it('rejects resolution with missing mcpId with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: resolveBody([{ decision: 'use-global' }]),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'Each resolution must have string mcpId and decision');
  });

  it('rejects over-limit resolutions array with 400', async () => {
    const oversized = Array.from({ length: 201 }, (_, i) => ({
      mcpId: `mcp-${i}`,
      decision: 'use-global',
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: resolveBody(oversized),
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error.includes('exceeds maximum'));
  });

  it('passes through when resolutions is absent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/drift/resolve',
      headers: AUTH_HEADERS,
      payload: resolveBody(undefined),
    });
    // Should NOT fail on resolutions validation — may fail on projectPath instead
    assert.notEqual(res.json().error, 'resolutions must be an array');
    assert.ok(!res.json().error?.includes('Invalid decision'));
  });
});
