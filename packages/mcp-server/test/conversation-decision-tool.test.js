import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

const envKeys = ['CAT_CAFE_API_URL', 'CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN', 'CAT_CAFE_CREDENTIAL_FILE'];

describe('conversation decision management tool', () => {
  let previousEnv;
  let previousFetch;

  beforeEach(() => {
    previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    previousFetch = globalThis.fetch;
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'requester-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'requester-token';
    delete process.env.CAT_CAFE_CREDENTIAL_FILE;
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    globalThis.fetch = previousFetch;
  });

  test('forwards the exact revision-bound requester transition', async () => {
    const { handleManageConversationDecision } = await import('../dist/tools/runtime-interaction-tools.js');
    let captured;
    globalThis.fetch = async (url, options) => {
      captured = { url: String(url), body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ status: 'ok', interaction: { status: 'answered' } }) };
    };
    const input = {
      interactionId: 'conversation-1',
      expectedRevision: 2,
      operationId: 'settle-1',
      action: { kind: 'settle_from_message', responseMessageId: 'owner-message-1' },
    };
    const result = await handleManageConversationDecision(input);

    assert.equal(result.isError, undefined);
    assert.match(captured.url, /\/api\/callbacks\/runtime-interactions\/conversation\/manage$/);
    assert.deepEqual(captured.body, input);
  });

  test('is registered only in the full runtime profile with write semantics', async () => {
    const { CANONICAL_TOOL_REGISTRY } = await import('../dist/server-toolsets.js');
    const tool = CANONICAL_TOOL_REGISTRY.find((entry) => entry.name === 'cat_cafe_manage_conversation_decision');
    assert.ok(tool);
    assert.deepEqual(tool.policy.runtimeProfiles, ['full']);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(tool.policy.standaloneReason.disposition, 'accepted-boundary');
  });
});
