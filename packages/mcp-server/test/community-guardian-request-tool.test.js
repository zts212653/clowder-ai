import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('cat_cafe_community_request_guardian MCP tool', () => {
  let originalEnv;
  let originalFetch;
  let tempDir;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
    tempDir = join(tmpdir(), `cat-cafe-guardian-request-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });

    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';
    process.env.CAT_CAFE_CALLBACK_OUTBOX_DIR = join(tempDir, 'outbox');
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
    delete process.env.CAT_CAFE_AGENT_KEY_FILE;
    delete process.env.CAT_CAFE_AGENT_KEY_FILES;
    delete process.env.CAT_CAFE_CREDENTIAL_FILE;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  test('uses the refreshed credential file and keeps credentials out of the body', async () => {
    const credentialPath = join(tempDir, 'credential.json');
    writeFileSync(credentialPath, JSON.stringify({ invocationId: 'inv-author', callbackToken: 'tok-author' }), {
      mode: 0o600,
    });
    process.env.CAT_CAFE_CREDENTIAL_FILE = credentialPath;

    let capturedUrl;
    let capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({
          guardianAssignment: { guardianCatId: 'gemini', requestedBy: 'opus', signedOff: false },
          signoffToken: 'signoff-token',
        }),
      };
    };

    const { handleCommunityRequestGuardian } = await import('../dist/tools/callback-tools.js');
    const result = await handleCommunityRequestGuardian({
      caseId: 'case-42',
      author: 'opus',
      reviewer: 'codex',
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.endsWith('/api/community-issues/case-42/request-guardian'));
    assert.equal(capturedOptions.headers['x-invocation-id'], 'inv-author');
    assert.equal(capturedOptions.headers['x-callback-token'], 'tok-author');
    const body = JSON.parse(capturedOptions.body);
    assert.deepEqual(body, { author: 'opus', reviewer: 'codex' });
    assert.equal(body.invocationId, undefined);
    assert.equal(body.callbackToken, undefined);
    assert.equal(body.catId, undefined);
  });

  test('supports the persistent agent-key carrier', async () => {
    process.env.CAT_CAFE_AGENT_KEY_SECRET = 'agent-key-secret';

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({
          guardianAssignment: { guardianCatId: 'gemini', requestedBy: 'opus', signedOff: false },
          signoffToken: 'signoff-token',
        }),
      };
    };

    const { handleCommunityRequestGuardian } = await import('../dist/tools/callback-tools.js');
    await handleCommunityRequestGuardian({
      caseId: 'case-43',
      author: 'opus',
      reviewer: 'codex',
    });

    assert.equal(capturedOptions.headers['x-agent-key-secret'], 'agent-key-secret');
    assert.deepEqual(JSON.parse(capturedOptions.body), { author: 'opus', reviewer: 'codex' });
  });

  test('is registered with a schema and handler', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const tool = callbackTools.find((entry) => entry.name === 'cat_cafe_community_request_guardian');
    assert.ok(tool, 'cat_cafe_community_request_guardian must be registered');
    assert.ok(tool.inputSchema);
    assert.equal(typeof tool.handler, 'function');
  });
});
