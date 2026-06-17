/**
 * F231 Phase C Task4: cat_cafe_propose_profile_update MCP tool tests.
 *
 * Mirrors callback-tools.test.js setup (globalThis.fetch mock + closed-loopback
 * env defense-in-depth). The handler is a thin transport adapter over
 * POST /api/callbacks/propose-profile-update — these tests pin the request
 * contract (body fields, headers-only creds, idempotency key, optional-field
 * forwarding) and the stale_ignored surfacing, NOT the server-side state machine
 * (that lives in the api package tests).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('cat_cafe_propose_profile_update MCP tool', () => {
  let originalEnv;
  let originalFetch;
  let outboxDir;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // shared-rules §19 (LL-054): closed loopback — if a test forgets to override
    // fetch, ECONNREFUSED keeps requests off the runtime callback endpoint.
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-token';
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';
    outboxDir = join(tmpdir(), `cat-cafe-mcp-ppu-test-${Date.now()}-${Math.random()}`);
    mkdirSync(outboxDir, { recursive: true });
    process.env.CAT_CAFE_CALLBACK_OUTBOX_DIR = outboxDir;

    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
    if (outboxDir && existsSync(outboxDir)) {
      rmSync(outboxDir, { recursive: true, force: true });
    }
  });

  test('posts required fields to /api/callbacks/propose-profile-update', async () => {
    const { handleProposeProfileUpdate } = await import('../dist/tools/callback-tools.js');

    let capturedUrl, capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return { ok: true, json: async () => ({ proposalId: 'p1', status: 'pending', messageId: 'm1' }) };
    };

    const result = await handleProposeProfileUpdate({
      afterContent: 'co-creator偏好先给结论再展开。',
      rationale: '更新沟通偏好',
      signalKind: 'cvo-instructed',
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callbacks/propose-profile-update'));
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.afterContent, 'co-creator偏好先给结论再展开。');
    assert.equal(body.rationale, '更新沟通偏好');
    assert.equal(body.signalKind, 'cvo-instructed');
  });

  test('sends creds via headers only, never dual-written to body (F174 AC-F2)', async () => {
    const { handleProposeProfileUpdate } = await import('../dist/tools/callback-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ proposalId: 'p1', status: 'pending' }) };
    };

    await handleProposeProfileUpdate({
      afterContent: 'x',
      rationale: 'y',
      signalKind: 'cat-declared',
    });

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.invocationId, undefined, 'creds must NOT be dual-written to body');
    assert.equal(body.callbackToken, undefined, 'creds must NOT be dual-written to body');
    assert.equal(capturedOptions.headers['x-invocation-id'], 'test-invocation');
    assert.equal(capturedOptions.headers['x-callback-token'], 'test-token');
  });

  test('auto-generates clientRequestId when the caller omits it', async () => {
    const { handleProposeProfileUpdate } = await import('../dist/tools/callback-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ proposalId: 'p1', status: 'pending' }) };
    };

    await handleProposeProfileUpdate({ afterContent: 'x', rationale: 'y', signalKind: 'cat-declared' });

    const body = JSON.parse(capturedOptions.body);
    assert.equal(typeof body.clientRequestId, 'string');
    assert.ok(body.clientRequestId.length > 0, 'auto-generated idempotency key must be non-empty');
  });

  test('forwards a caller-supplied clientRequestId verbatim', async () => {
    const { handleProposeProfileUpdate } = await import('../dist/tools/callback-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ proposalId: 'p1', status: 'pending' }) };
    };

    await handleProposeProfileUpdate({
      afterContent: 'x',
      rationale: 'y',
      signalKind: 'cat-declared',
      clientRequestId: 'req-abc-123',
    });

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.clientRequestId, 'req-abc-123');
  });

  test('forwards sourceMessageId when supplied', async () => {
    const { handleProposeProfileUpdate } = await import('../dist/tools/callback-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ proposalId: 'p1', status: 'pending' }) };
    };

    await handleProposeProfileUpdate({
      afterContent: 'x',
      rationale: 'y',
      signalKind: 'cat-declared',
      sourceMessageId: 'msg-42',
    });

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.sourceMessageId, 'msg-42');
  });

  test('omits sourceMessageId from body when not supplied', async () => {
    const { handleProposeProfileUpdate } = await import('../dist/tools/callback-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ proposalId: 'p1', status: 'pending' }) };
    };

    await handleProposeProfileUpdate({ afterContent: 'x', rationale: 'y', signalKind: 'cat-declared' });

    const body = JSON.parse(capturedOptions.body);
    assert.ok(!('sourceMessageId' in body), 'sourceMessageId must be absent, not null/undefined');
  });

  test('surfaces stale_ignored as an error result', async () => {
    const { handleProposeProfileUpdate } = await import('../dist/tools/callback-tools.js');

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'stale_ignored' }) });

    const result = await handleProposeProfileUpdate({
      afterContent: 'x',
      rationale: 'y',
      signalKind: 'cat-declared',
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /stale_ignored|NOT created/i);
  });

  test('does not flag a normal pending proposal as error', async () => {
    const { handleProposeProfileUpdate } = await import('../dist/tools/callback-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ proposalId: 'p1', status: 'pending', messageId: 'm1' }),
    });

    const result = await handleProposeProfileUpdate({
      afterContent: 'x',
      rationale: 'y',
      signalKind: 'cat-declared',
    });

    assert.equal(result.isError, undefined);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.proposalId, 'p1');
    assert.equal(data.status, 'pending');
  });

  test('tool is registered in callbackTools with schema + handler', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const tool = callbackTools.find((t) => t.name === 'cat_cafe_propose_profile_update');
    assert.ok(tool, 'cat_cafe_propose_profile_update must be registered in callbackTools');
    assert.ok(tool.inputSchema, 'tool must expose an inputSchema');
    assert.equal(typeof tool.handler, 'function', 'tool must wire a handler');
    // INV-6 guard: AC-C1 schema must not expose a capsule target (per-cat primer only).
    assert.ok(!('targetLayer' in tool.inputSchema), 'AC-C1 must not expose targetLayer (capsule is C2)');
  });
});
