import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('external runtime session MCP tools', () => {
  let originalEnv;
  let originalFetch;
  let tempDir;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
    tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-mcp-external-runtime-'));
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3004';
    process.env.CAT_CAFE_USER_ID = 'user-1';
    process.env.CAT_CAFE_CAT_ID = 'antig-opus';
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
    delete process.env.CAT_CAFE_AGENT_KEY_FILE;
    delete process.env.CAT_CAFE_AGENT_KEY_FILES;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('register tool posts the callback route with the selected agent-key header', async () => {
    const keyFile = join(tempDir, 'antig-opus.key');
    writeFileSync(keyFile, 'secret-antig-opus\n', 'utf-8');
    process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({ 'antig-opus': keyFile });
    let capturedUrl;
    let capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'created', sessionId: 'session-1' }),
        text: async () => JSON.stringify({ status: 'created', sessionId: 'session-1' }),
      };
    };

    const { handleRegisterExternalRuntimeSession } = await import('../dist/tools/external-runtime-session-tools.js');
    const result = await handleRegisterExternalRuntimeSession({
      runtime: 'antigravity-desktop',
      runtimeSessionId: 'cascade-1',
      runtimeConversationId: 'conversation-1',
      catId: 'antig-opus',
      model: 'claude-opus-4-6',
      startedAt: 1000,
      agentKeyCatId: 'antig-opus',
    });

    assert.equal(result.isError, undefined);
    assert.equal(capturedUrl, 'http://127.0.0.1:3004/api/callbacks/external-runtime-sessions/register');
    assert.equal(capturedOptions.headers['x-agent-key-secret'], 'secret-antig-opus');
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.runtimeSessionId, 'cascade-1');
    assert.equal(body.catId, 'antig-opus');
    assert.equal(body.agentKeyCatId, undefined, 'sidecar selector must not be sent to the API body');
  });

  test('register tool uses agent-key auth even when invocation credentials are present', async () => {
    const keyFile = join(tempDir, 'antig-opus.key');
    writeFileSync(keyFile, 'secret-antig-opus\n', 'utf-8');
    process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({ 'antig-opus': keyFile });
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-active';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'tok-active';
    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'created', sessionId: 'session-1' }),
        text: async () => JSON.stringify({ status: 'created', sessionId: 'session-1' }),
      };
    };

    const { handleRegisterExternalRuntimeSession } = await import('../dist/tools/external-runtime-session-tools.js');
    const result = await handleRegisterExternalRuntimeSession({
      runtime: 'antigravity-desktop',
      runtimeSessionId: 'cascade-1',
      runtimeConversationId: 'conversation-1',
      catId: 'antig-opus',
      model: 'claude-opus-4-6',
      startedAt: 1000,
      agentKeyCatId: 'antig-opus',
    });

    assert.equal(result.isError, undefined);
    assert.equal(capturedOptions.headers['x-agent-key-secret'], 'secret-antig-opus');
    assert.equal(capturedOptions.headers['x-invocation-id'], undefined);
    assert.equal(capturedOptions.headers['x-callback-token'], undefined);
  });

  test('register tool fails closed when shared agent-key files need agentKeyCatId', async () => {
    process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({ 'antig-opus': join(tempDir, 'missing.key') });
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const { handleRegisterExternalRuntimeSession } = await import('../dist/tools/external-runtime-session-tools.js');
    const result = await handleRegisterExternalRuntimeSession({
      runtime: 'antigravity-desktop',
      runtimeSessionId: 'cascade-1',
      catId: 'antig-opus',
      model: 'claude-opus-4-6',
      startedAt: 1000,
    });

    assert.equal(result.isError, true);
    assert.equal(fetchCalled, false);
    assert.match(result.content[0].text, /agentKeyCatId/);
  });

  test('list/read tools use user identity headers and no callback credentials', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), headers: options.headers });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessions: [
            {
              sessionId: 'session-1',
              threadId: 'external-runtime:antigravity-desktop:user-1',
              runtimeSessionId: 'cascade-1',
              runtimeConversationId: 'conversation-1',
              catId: 'antig-opus',
              model: 'claude-opus-4-6',
              lastObservedAt: 2000,
              binding: { mode: 'orphan_anchor' },
            },
          ],
        }),
        text: async () => '{}',
      };
    };

    const { handleListExternalRuntimeSessions, handleReadExternalRuntimeSession } = await import(
      '../dist/tools/external-runtime-session-tools.js'
    );
    const listResult = await handleListExternalRuntimeSessions({
      runtime: 'antigravity-desktop',
      catId: 'antig-opus',
      limit: 10,
    });
    const readResult = await handleReadExternalRuntimeSession({ sessionId: 'session-1' });

    assert.equal(listResult.isError, undefined);
    assert.equal(readResult.isError, undefined);
    assert.ok(calls[0].url.includes('/api/external-runtime-sessions?'));
    assert.ok(calls[0].url.includes('runtime=antigravity-desktop'));
    assert.ok(calls[0].url.includes('catId=antig-opus'));
    assert.equal(calls[0].headers['x-cat-cafe-user'], 'user-1');
    assert.equal(calls[0].headers['x-cat-id'], 'antig-opus');
    assert.equal(calls[0].headers['x-invocation-id'], undefined);
    assert.equal(calls[1].url, 'http://127.0.0.1:3004/api/external-runtime-sessions/session-1');
  });
});
