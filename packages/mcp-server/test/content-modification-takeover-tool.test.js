import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { z } from 'zod';

describe('F309 message takeover MCP tool', () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'takeover-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'takeover-token';
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  test('registers the authenticated source-only takeover and rejects caller-owned intent fields', async () => {
    const [{ CANONICAL_TOOL_REGISTRY }, tools] = await Promise.all([
      import('../dist/canonical-server-tools.js'),
      import('../dist/tools/content-modification-tools.js'),
    ]);
    const definition = CANONICAL_TOOL_REGISTRY.find(
      (candidate) => candidate.name === 'cat_cafe_take_over_content_modification',
    );
    assert.ok(definition);
    assert.equal(definition.operation.action, 'update');

    const schema = z.object(tools.takeOverContentModificationInputSchema).strict();
    const input = {
      sourceMessageId: '0001790961050741-000176-9296eac8',
      operationId: '4eedc6aa-a688-4c3e-a69a-f42560e98189',
    };
    assert.equal(schema.safeParse(input).success, true);
    const selected = { ...input, attachmentId: 'original-four' };
    assert.deepEqual(schema.parse(selected), selected);
    assert.equal(schema.safeParse({ ...input, attachmentIds: ['original-four'] }).success, false);
    assert.equal(
      schema.safeParse({ ...input, targetCatId: 'codex-astra', body: 'caller copy', userId: 'operator' }).success,
      false,
    );

    let capturedUrl;
    let capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return { ok: true, json: async () => ({ record: { requestId: 'request-1' } }) };
    };
    const result = await tools.handleTakeOverContentModification(input);
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.match(capturedUrl, /\/api\/callbacks\/content-modification\/take-over$/);
    assert.deepEqual(JSON.parse(capturedOptions.body), input);
    assert.equal(capturedOptions.headers['x-invocation-id'], 'takeover-invocation');
    assert.equal(capturedOptions.headers['x-callback-token'], 'takeover-token');
    await tools.handleTakeOverContentModification(selected);
    assert.deepEqual(JSON.parse(capturedOptions.body), selected);
  });
});
