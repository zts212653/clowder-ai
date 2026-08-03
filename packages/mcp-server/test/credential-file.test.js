/**
 * #1092: MCP credential file refresh tests.
 *
 * When CAT_CAFE_CREDENTIAL_FILE is set, getCallbackConfig() reads fresh
 * invocationId + callbackToken from the file, overriding stale process.env
 * values that go stale after ACP session resume.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('#1092 credential file refresh', () => {
  let originalEnv;
  let credDir;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'stale-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'stale-token';
    credDir = join(tmpdir(), `cat-cafe-cred-test-${Date.now()}-${Math.random()}`);
    mkdirSync(credDir, { recursive: true });
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    if (credDir) rmSync(credDir, { recursive: true, force: true });
  });

  test('getCallbackConfig prefers credential file over process.env', async () => {
    const credFile = join(credDir, 'test.json');
    writeFileSync(
      credFile,
      JSON.stringify({
        invocationId: 'fresh-invocation',
        callbackToken: 'fresh-token',
      }),
    );
    process.env.CAT_CAFE_CREDENTIAL_FILE = credFile;

    const { getCallbackConfig } = await import('../dist/tools/callback-tools.js');
    const config = getCallbackConfig();

    assert.ok(config, 'config should not be null');
    assert.equal(config.invocationId, 'fresh-invocation', 'should use file invocationId');
    assert.equal(config.callbackToken, 'fresh-token', 'should use file callbackToken');
  });

  test('getCallbackConfig falls back to process.env when credential file is missing', async () => {
    process.env.CAT_CAFE_CREDENTIAL_FILE = join(credDir, 'nonexistent.json');

    const { getCallbackConfig } = await import('../dist/tools/callback-tools.js');
    const config = getCallbackConfig();

    assert.ok(config, 'config should not be null');
    assert.equal(config.invocationId, 'stale-invocation', 'should fall back to env');
    assert.equal(config.callbackToken, 'stale-token', 'should fall back to env');
  });

  test('getCallbackConfig falls back to process.env when credential file has bad JSON', async () => {
    const credFile = join(credDir, 'bad.json');
    writeFileSync(credFile, 'not json {{{');
    process.env.CAT_CAFE_CREDENTIAL_FILE = credFile;

    const { getCallbackConfig } = await import('../dist/tools/callback-tools.js');
    const config = getCallbackConfig();

    assert.ok(config, 'config should not be null');
    assert.equal(config.invocationId, 'stale-invocation');
  });

  test('getCallbackConfig falls back when credential file has missing fields', async () => {
    const credFile = join(credDir, 'partial.json');
    writeFileSync(credFile, JSON.stringify({ invocationId: 'fresh-only' }));
    process.env.CAT_CAFE_CREDENTIAL_FILE = credFile;

    const { getCallbackConfig } = await import('../dist/tools/callback-tools.js');
    const config = getCallbackConfig();

    assert.ok(config, 'config should not be null');
    // File has invocationId but missing callbackToken → file returns null → env fallback
    assert.equal(config.invocationId, 'stale-invocation');
  });

  test('getCallbackConfig without CAT_CAFE_CREDENTIAL_FILE uses process.env (backward compat)', async () => {
    // No credential file set — original behavior
    delete process.env.CAT_CAFE_CREDENTIAL_FILE;

    const { getCallbackConfig } = await import('../dist/tools/callback-tools.js');
    const config = getCallbackConfig();

    assert.ok(config, 'config should not be null');
    assert.equal(config.invocationId, 'stale-invocation');
    assert.equal(config.callbackToken, 'stale-token');
  });

  test('callbackPost sends fresh credentials from credential file', async () => {
    const credFile = join(credDir, 'fresh.json');
    writeFileSync(
      credFile,
      JSON.stringify({
        invocationId: 'fresh-inv-123',
        callbackToken: 'fresh-tok-456',
      }),
    );
    process.env.CAT_CAFE_CREDENTIAL_FILE = credFile;
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0';

    let capturedHeaders;
    globalThis.fetch = async (_url, options) => {
      capturedHeaders = options.headers;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };

    const { callbackPost } = await import('../dist/tools/callback-tools.js');
    await callbackPost('/api/callbacks/test', { data: 'hello' });

    assert.equal(
      capturedHeaders['x-invocation-id'],
      'fresh-inv-123',
      'should use credential file invocationId in header',
    );
    assert.equal(
      capturedHeaders['x-callback-token'],
      'fresh-tok-456',
      'should use credential file callbackToken in header',
    );

    // Restore fetch
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  });

  test('set_read_mode derives its session file from credential-file invocation identity', async () => {
    const invocationId = `pooled-read-mode-${Date.now()}-${Math.random()}`;
    const credFile = join(credDir, 'read-mode.json');
    const modeFile = `/tmp/cat-cafe-anchor-mode-${invocationId}`;
    writeFileSync(credFile, JSON.stringify({ invocationId, callbackToken: 'fresh-token' }));
    process.env.CAT_CAFE_CREDENTIAL_FILE = credFile;
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    rmSync(modeFile, { force: true });

    try {
      const { handleSetReadMode } = await import('../dist/tools/callback-tools.js');
      const result = await handleSetReadMode({ mode: 'anchor' });

      assert.equal(result.isError, undefined, 'pooled managed sessions must retain read-mode control');
      assert.equal(existsSync(modeFile), true);
      assert.equal(readFileSync(modeFile, 'utf8'), 'anchor');
    } finally {
      rmSync(modeFile, { force: true });
    }
  });
});
