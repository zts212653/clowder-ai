/**
 * F260 R4: cat_cafe_propose_entity MCP tool transport tests.
 *
 * Pins the clientRequestId contract between MCP handler and the
 * POST /api/callbacks/propose-entity callback route:
 * - Caller-supplied key forwarded verbatim
 * - Omitted key auto-generates a UUID (transport retry safety)
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('cat_cafe_propose_entity MCP tool — clientRequestId transport', () => {
  let originalEnv;
  let originalFetch;
  let outboxDir;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-token';
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';
    outboxDir = join(tmpdir(), `cat-cafe-mcp-entity-test-${Date.now()}-${Math.random()}`);
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

  const validInput = {
    entityId: 'concept:未婚喵',
    entityType: 'concept',
    canonicalName: '未婚喵',
    aliases: ['未婚喵', '未婚猫'],
    stance: 'endorsed',
    visibilityScope: 'workspace',
    provenance: [{ source: 'cat-proposed', anchor: 'thread_abc' }],
    rationale: 'Recurring term in discussions',
  };

  test('auto-generates clientRequestId when the caller omits it', async () => {
    const { handleProposeEntity } = await import('../dist/tools/callback-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ proposalId: 'ep-1', status: 'pending' }) };
    };

    await handleProposeEntity({ ...validInput });

    const body = JSON.parse(capturedOptions.body);
    assert.equal(typeof body.clientRequestId, 'string');
    assert.ok(body.clientRequestId.length > 0, 'auto-generated idempotency key must be non-empty');
  });

  test('forwards a caller-supplied clientRequestId verbatim', async () => {
    const { handleProposeEntity } = await import('../dist/tools/callback-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ proposalId: 'ep-2', status: 'pending' }) };
    };

    await handleProposeEntity({ ...validInput, clientRequestId: 'stable-r4-retry-key' });

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.clientRequestId, 'stable-r4-retry-key');
  });

  test('body includes all required entity fields alongside clientRequestId', async () => {
    const { handleProposeEntity } = await import('../dist/tools/callback-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return { ok: true, json: async () => ({ proposalId: 'ep-3', status: 'pending' }) };
    };

    await handleProposeEntity({ ...validInput, clientRequestId: 'explicit-key' });

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.entityId, 'concept:未婚喵');
    assert.equal(body.entityType, 'concept');
    assert.equal(body.canonicalName, '未婚喵');
    assert.deepEqual(body.aliases, ['未婚喵', '未婚猫']);
    assert.equal(body.stance, 'endorsed');
    assert.equal(body.visibilityScope, 'workspace');
    assert.equal(body.rationale, 'Recurring term in discussions');
    assert.equal(body.clientRequestId, 'explicit-key');
  });
});
