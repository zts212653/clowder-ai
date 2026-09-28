import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('cat_cafe_read_profile MCP tool', () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-token';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  test('GETs current authenticated profile with headers-only identity', async () => {
    const { handleReadProfile } = await import('../dist/tools/callback-tools.js');
    let capturedUrl;
    let capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({
          uri: 'cat-cafe-profile://relationship/current',
          relationshipKey: 'maine-coon',
          content: 'PRIMER',
        }),
      };
    };

    const result = await handleReadProfile({});
    assert.equal(result.isError, undefined);
    assert.match(capturedUrl, /\/api\/callbacks\/profile$/);
    assert.equal(capturedOptions.headers['x-invocation-id'], 'test-invocation');
    assert.equal(capturedOptions.headers['x-callback-token'], 'test-token');
    assert.doesNotMatch(capturedUrl, /userId|catId|relationshipKey/);
  });

  test('schema exposes transport identity selector and optional layer, never target identity', async () => {
    const { readProfileInputSchema } = await import('../dist/tools/callback-tools.js');
    const keys = Object.keys(readProfileInputSchema).sort();
    assert.deepEqual(keys, ['agentKeyCatId', 'layer']);
  });

  test('registration description carries routing boundaries and URI trigger', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const tool = callbackTools.find((candidate) => candidate.name === 'cat_cafe_read_profile');
    assert.ok(tool);
    assert.match(tool.description, /cat-cafe-profile:\/\//);
    assert.match(tool.description, /Use when:/);
    assert.match(tool.description, /NOT for:/);
    assert.match(tool.description, /Output:/);
    assert.match(tool.description, /GOTCHA:/);
  });

  // ──── Phase E: corpus layer read ────

  test('schema exposes optional layer parameter (Phase E: AC-E2)', async () => {
    const { readProfileInputSchema } = await import('../dist/tools/callback-tools.js');
    assert.ok('layer' in readProfileInputSchema, 'Phase E must expose layer');
    assert.equal(readProfileInputSchema.layer.safeParse(undefined).success, true, 'layer is optional');
    assert.equal(readProfileInputSchema.layer.safeParse('primer').success, true);
    assert.equal(readProfileInputSchema.layer.safeParse('corpus').success, true);
    assert.equal(readProfileInputSchema.layer.safeParse('capsule').success, false, 'capsule rejected');
  });

  test('passes layer as query parameter when supplied', async () => {
    const { handleReadProfile } = await import('../dist/tools/callback-tools.js');
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ layer: 'corpus', content: 'CORPUS', revision: 'sha256:abc' }),
      };
    };

    await handleReadProfile({ layer: 'corpus' });
    assert.match(capturedUrl, /[?&]layer=corpus/, 'layer must be passed as query param');
  });

  test('omits layer query param when not supplied (primer default)', async () => {
    const { handleReadProfile } = await import('../dist/tools/callback-tools.js');
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ uri: 'cat-cafe-profile://relationship/current', content: 'P' }),
      };
    };

    await handleReadProfile({});
    assert.doesNotMatch(capturedUrl, /layer=/, 'no layer param when not supplied');
  });

  test('description mentions corpus layer', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const tool = callbackTools.find((candidate) => candidate.name === 'cat_cafe_read_profile');
    assert.ok(tool);
    assert.match(tool.description, /corpus/i, 'description must mention corpus');
  });
});
