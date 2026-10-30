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
    assert.equal(new URL(capturedUrl).pathname, '/api/callbacks/profile');
    assert.match(new URL(capturedUrl).searchParams.get('requestId'), /^[a-f0-9-]{36}$/);
    assert.equal(capturedOptions.headers['x-invocation-id'], 'test-invocation');
    assert.equal(capturedOptions.headers['x-callback-token'], 'test-token');
    assert.doesNotMatch(capturedUrl, /userId|catId|relationshipKey/);
  });

  test('schema exposes transport identity selector and optional layer, never target identity', async () => {
    const { readProfileInputSchema } = await import('../dist/tools/callback-tools.js');
    const keys = Object.keys(readProfileInputSchema).sort();
    assert.deepEqual(keys, ['agentKeyCatId', 'expectedRevision', 'layer', 'requestId']);
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
    assert.match(tool.description, /this connection.s authenticated identity/i);
    assert.match(tool.description, /bound to that invocation/i);
    assert.match(tool.description, /separately installed App.*not a substitute/i);
    assert.match(tool.description, /missing profile on another connection.*absence here/i);
  });

  // ──── Phase E: corpus layer read ────

  test('schema exposes optional layer parameter (Phase E: AC-E2)', async () => {
    const { readProfileInputSchema } = await import('../dist/tools/callback-tools.js');
    assert.ok('layer' in readProfileInputSchema, 'Phase E must expose layer');
    assert.equal(readProfileInputSchema.layer.safeParse(undefined).success, true, 'layer is optional');
    assert.equal(readProfileInputSchema.layer.safeParse('primer').success, true);
    assert.equal(readProfileInputSchema.layer.safeParse('corpus').success, true);
    assert.equal(readProfileInputSchema.layer.safeParse('capsule').success, true, 'current capsule is owner-readable');
  });

  test('F321 forwards the expected revision without exposing a target identity', async () => {
    const { handleReadProfile, readProfileInputSchema } = await import('../dist/tools/callback-tools.js');
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ content: 'CURRENT' }) };
    };
    const expectedRevision = `sha256:${'a'.repeat(64)}`;
    await handleReadProfile({ expectedRevision });
    assert.equal(new URL(capturedUrl).searchParams.get('expectedRevision'), expectedRevision);
    assert.equal(readProfileInputSchema.expectedRevision.safeParse('unsafe').success, false);
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

  test('preserves the exact read ID across explicit retries', async () => {
    const { handleReadProfile } = await import('../dist/tools/callback-tools.js');
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(new URL(url));
      return { ok: true, json: async () => ({ usageRecorded: true }) };
    };
    await handleReadProfile({ requestId: 'same-read', layer: 'corpus' });
    await handleReadProfile({ requestId: 'same-read', layer: 'corpus' });
    assert.deepEqual(
      urls.map((url) => url.searchParams.get('requestId')),
      ['same-read', 'same-read'],
    );
  });

  test('a receipt already bound to an older profile starts a new read instead of retrying the rejected ID', async () => {
    const { handleReadProfile } = await import('../dist/tools/callback-tools.js');
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(new URL(url).searchParams.get('requestId'));
      return seen.length === 1
        ? { ok: true, json: async () => ({ content: 'VERSION A', readRequestId: 'bound-to-a' }) }
        : {
            ok: false,
            status: 409,
            text: async () => JSON.stringify({ error: 'profile_read_request_changed', readRequestId: 'bound-to-a' }),
          };
    };
    assert.equal((await handleReadProfile({ requestId: 'bound-to-a' })).isError, undefined);
    const changed = await handleReadProfile({ requestId: 'bound-to-a' });
    assert.equal(changed.isError, true);
    const advice = changed.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    assert.match(advice, /new requestId/);
    assert.doesNotMatch(advice, /Retry this read with requestId: bound-to-a/);
    assert.deepEqual(seen, ['bound-to-a', 'bound-to-a']);
  });

  test('recovery advice distinguishes stale revisions, transient or unknown failure, and permanent rejection', async () => {
    const { handleReadProfile } = await import('../dist/tools/callback-tools.js');
    for (const [status, error, expected] of [
      [409, 'profile_revision_changed', /without expectedRevision/],
      [503, 'profile_read_recording_unavailable', /requestId: preserve-me/],
      [400, 'invalid_profile_query', null],
      [401, 'callback_auth_failed', null],
      [429, 'rate_limited', /requestId: preserve-me/],
    ]) {
      globalThis.fetch = async () => ({
        ok: false,
        status,
        text: async () => JSON.stringify({ error, ...(status === 401 ? { reason: 'token_mismatch' } : {}) }),
      });
      const result = await handleReadProfile({ requestId: 'preserve-me' });
      assert.equal(result.isError, true);
      const extra = result.content
        .slice(1)
        .map((item) => item.text)
        .join('\n');
      if (expected) assert.match(extra, expected);
      else assert.equal(extra, '', 'a known client rejection must not invite an unchanged retry');
    }
    globalThis.fetch = async () => {
      throw new Error('response lost');
    };
    const unknown = await handleReadProfile({ requestId: 'preserve-me' });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content.at(-1).text, /requestId: preserve-me/);
  });

  test('description mentions corpus layer', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const tool = callbackTools.find((candidate) => candidate.name === 'cat_cafe_read_profile');
    assert.ok(tool);
    assert.match(tool.description, /corpus/i, 'description must mention corpus');
  });
});
