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

  test('schema exposes only transport identity selector, never target identity', async () => {
    const { readProfileInputSchema } = await import('../dist/tools/callback-tools.js');
    assert.deepEqual(Object.keys(readProfileInputSchema), ['agentKeyCatId']);
  });

  test('registration description carries routing boundaries and URI trigger', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const tool = callbackTools.find((candidate) => candidate.name === 'cat_cafe_read_profile');
    assert.ok(tool);
    assert.match(tool.description, /cat-cafe-profile:\/\/relationship\/current/);
    assert.match(tool.description, /Use when:/);
    assert.match(tool.description, /NOT for:/);
    assert.match(tool.description, /Output:/);
    assert.match(tool.description, /GOTCHA:/);
  });
});
