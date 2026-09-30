/**
 * F247 Workspace Agent slice 1 tests: conversation key, Trigger API adapter
 * (202 / 401 / 403 / 404 / 409 / transport faults / token redaction /
 * Idempotency-Key binding), versioned binding migration, and the extended
 * outbound receipt validator.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isCloudBridgeOutboundReceiptV1 } from '@cat-cafe/shared';
import {
  normalizeCloudCatBinding,
  normalizeCloudCatBindings,
} from '../dist/domains/cats/services/cloud-bridge/cloud-cat-bindings-v1.js';
import {
  buildWorkspaceAgentConversationKey,
  isWorkspaceAgentConversationKey,
} from '../dist/domains/cats/services/cloud-bridge/workspace-agent/conversation-key.js';
import {
  WorkspaceAgentTriggerError,
  WorkspaceAgentTriggerHttpAdapter,
} from '../dist/domains/cats/services/cloud-bridge/workspace-agent/workspace-agent-trigger-adapter.js';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function baseReceipt(overrides = {}) {
  return {
    v: 1,
    sourceMessageId: 'src-1',
    sourceSender: { kind: 'cat', id: 'zcode' },
    dispatchInvocationId: 'inv-1',
    targetCatId: 'gpt-pro',
    status: 'sent',
    transport: 'host',
    hostMessageId: 'host-msg-1',
    idempotency: { keyKind: 'source_message_id', disposition: 'fresh' },
    ...overrides,
  };
}

test('conversation key: stable, deterministic, provider-namespaced', () => {
  const key = buildWorkspaceAgentConversationKey({ workspaceId: 'ws_1', threadId: 'thread_abc' });
  assert.equal(key, 'clowder:ws_1:thread_abc');
  assert.equal(buildWorkspaceAgentConversationKey({ workspaceId: 'ws_1', threadId: 'thread_abc' }), key);
  assert.notEqual(buildWorkspaceAgentConversationKey({ workspaceId: 'ws_2', threadId: 'thread_abc' }), key);
  assert.notEqual(buildWorkspaceAgentConversationKey({ workspaceId: 'ws_1', threadId: 'thread_def' }), key);
  assert.ok(isWorkspaceAgentConversationKey(key));
});

test('conversation key: rejects ambiguous / malformed segments', () => {
  assert.throws(() => buildWorkspaceAgentConversationKey({ workspaceId: 'a:b', threadId: 't' }));
  assert.throws(() => buildWorkspaceAgentConversationKey({ workspaceId: '', threadId: 't' }));
  assert.throws(() => buildWorkspaceAgentConversationKey({ workspaceId: 'w', threadId: 'x'.repeat(257) }));
  assert.throws(() => buildWorkspaceAgentConversationKey({ workspaceId: 'w', threadId: 't\n' }));
  assert.ok(!isWorkspaceAgentConversationKey('clowder:only-one-segment'));
  assert.ok(!isWorkspaceAgentConversationKey('random string'));
});

test('trigger adapter: 202 parses conversation_url and beta run id, sends Idempotency-Key + conversation_key', async () => {
  const calls = [];
  const adapter = new WorkspaceAgentTriggerHttpAdapter({
    triggerId: 'agtch_test_123',
    tokenProvider: () => 'secret-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(202, { conversation_url: 'https://chatgpt.com/c/abc-123', agent_trigger_run_id: 'apirun_9' });
    },
  });
  const receipt = await adapter.trigger({
    input: 'hello',
    conversationKey: buildWorkspaceAgentConversationKey({ workspaceId: 'ws', threadId: 't1' }),
    idempotencyKey: 'inv-42',
  });
  assert.equal(receipt.conversationUrl, 'https://chatgpt.com/c/abc-123');
  assert.equal(receipt.providerRunId, 'apirun_9');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/v1/workspace_agents/agtch_test_123/trigger'));
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'inv-42');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-token');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.conversation_key, 'clowder:ws:t1');
  assert.equal(body.input, 'hello');
});

test('trigger adapter: 202 without beta run id omits providerRunId', async () => {
  const adapter = new WorkspaceAgentTriggerHttpAdapter({
    triggerId: 'agtch_x',
    tokenProvider: () => 'tok',
    fetchImpl: async () => jsonResponse(202, { conversation_url: 'https://chatgpt.com/c/z' }),
  });
  const receipt = await adapter.trigger({
    input: 'x',
    conversationKey: 'clowder:w:t',
    idempotencyKey: 'k',
  });
  assert.equal(receipt.providerRunId, undefined);
});

for (const [status, code] of [
  [401, 'WORKSPACE_AGENT_UNAUTHORIZED'],
  [403, 'WORKSPACE_AGENT_FORBIDDEN'],
  [404, 'WORKSPACE_AGENT_TRIGGER_NOT_FOUND'],
  [409, 'WORKSPACE_AGENT_NOT_RUNNABLE'],
]) {
  test(`trigger adapter: ${status} maps to typed ${code}`, async () => {
    const adapter = new WorkspaceAgentTriggerHttpAdapter({
      triggerId: 'agtch_x',
      tokenProvider: () => 'tok',
      fetchImpl: async () => jsonResponse(status, { error: 'boom' }),
    });
    await assert.rejects(
      adapter.trigger({ input: 'x', conversationKey: 'clowder:w:t', idempotencyKey: 'k' }),
      (err) => err instanceof WorkspaceAgentTriggerError && err.code === code && err.status === status,
    );
  });
}

test('trigger adapter: non-202 success-family status and malformed 202 body fail closed', async () => {
  const adapter = new WorkspaceAgentTriggerHttpAdapter({
    triggerId: 'agtch_x',
    tokenProvider: () => 'tok',
    fetchImpl: async () => jsonResponse(500, {}),
  });
  await assert.rejects(
    adapter.trigger({ input: 'x', conversationKey: 'clowder:w:t', idempotencyKey: 'k' }),
    (err) => err.code === 'WORKSPACE_AGENT_TRANSPORT_ERROR' && err.status === 500,
  );

  const badBody = new WorkspaceAgentTriggerHttpAdapter({
    triggerId: 'agtch_x',
    tokenProvider: () => 'tok',
    fetchImpl: async () => jsonResponse(202, { conversation_url: 'https://evil.example/c/1' }),
  });
  await assert.rejects(
    badBody.trigger({ input: 'x', conversationKey: 'clowder:w:t', idempotencyKey: 'k' }),
    (err) => err.code === 'WORKSPACE_AGENT_TRANSPORT_ERROR',
  );
});

test('trigger adapter: transport fault never leaks the token in the error', async () => {
  const adapter = new WorkspaceAgentTriggerHttpAdapter({
    triggerId: 'agtch_x',
    tokenProvider: () => 'super-secret-token-value',
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch https://api.chatgpt.com/ with header Bearer super-secret-token-value');
    },
  });
  await assert.rejects(adapter.trigger({ input: 'x', conversationKey: 'clowder:w:t', idempotencyKey: 'k' }), (err) => {
    assert.equal(err.code, 'WORKSPACE_AGENT_TRANSPORT_ERROR');
    const serialized = JSON.stringify(err);
    assert.ok(!serialized.includes('super-secret-token-value'), 'token must never appear in serialized error');
    // Only the error NAME is surfaced — not the message that may echo internals.
    assert.ok(err.message.includes('TypeError'));
    return true;
  });
});

test('trigger adapter: missing token / trigger id / malformed conversation key are invalid-config', async () => {
  const noToken = new WorkspaceAgentTriggerHttpAdapter({
    triggerId: 'agtch_x',
    tokenProvider: () => null,
    fetchImpl: async () => jsonResponse(202, {}),
  });
  await assert.rejects(
    noToken.trigger({ input: 'x', conversationKey: 'clowder:w:t', idempotencyKey: 'k' }),
    (err) => err.code === 'WORKSPACE_AGENT_INVALID_CONFIG',
  );
  assert.throws(
    () => new WorkspaceAgentTriggerHttpAdapter({ triggerId: ' ', tokenProvider: () => 't' }),
    (err) => err.code === 'WORKSPACE_AGENT_INVALID_CONFIG',
  );
  const adapter = new WorkspaceAgentTriggerHttpAdapter({
    triggerId: 'agtch_x',
    tokenProvider: () => 't',
    fetchImpl: async () => jsonResponse(202, {}),
  });
  await assert.rejects(
    adapter.trigger({ input: 'x', conversationKey: 'no-colons-here', idempotencyKey: 'k' }),
    (err) => err.code === 'WORKSPACE_AGENT_INVALID_CONFIG',
  );
});

test('bindings migration: legacy URL string normalizes to personal-chrome-host v1', () => {
  const binding = normalizeCloudCatBinding('https://chatgpt.com/c/abc-123');
  assert.deepEqual(binding, {
    v: 1,
    provider: 'personal-chrome-host',
    conversationUrl: 'https://chatgpt.com/c/abc-123',
  });
  assert.equal(normalizeCloudCatBinding('https://evil.example/c/1'), null);
  assert.equal(normalizeCloudCatBinding(''), null);
  assert.equal(normalizeCloudCatBinding(42), null);
});

test('bindings migration: workspace-agent v1 passes through; unknown shapes fail closed', () => {
  const wa = { v: 1, provider: 'workspace-agent', workspaceId: 'ws', triggerId: 'agtch_x' };
  assert.deepEqual(normalizeCloudCatBinding(wa), wa);
  assert.equal(normalizeCloudCatBinding({ v: 2, provider: 'future' }), null);
  assert.equal(normalizeCloudCatBinding({ v: 1, provider: 'unknown-provider' }), null);
  assert.equal(normalizeCloudCatBinding({ v: 1, provider: 'workspace-agent', workspaceId: '', triggerId: 'x' }), null);
  assert.equal(
    normalizeCloudCatBinding({ v: 1, provider: 'workspace-agent', workspaceId: 'ws', triggerId: 'x', extra: 1 }),
    null,
  );
});

test('bindings migration: record normalization drops unusable entries only', () => {
  const normalized = normalizeCloudCatBindings({
    'gpt-pro': 'https://chatgpt.com/c/good',
    'claude-pro': { v: 1, provider: 'workspace-agent', workspaceId: 'ws', triggerId: 'agtch_c' },
    broken: 'not-a-url',
  });
  assert.deepEqual(Object.keys(normalized).sort(), ['claude-pro', 'gpt-pro']);
  assert.equal(normalized['gpt-pro'].provider, 'personal-chrome-host');
  assert.equal(normalized['claude-pro'].provider, 'workspace-agent');
  assert.deepEqual(normalizeCloudCatBindings(null), {});
});

test('receipt validator: workspace-agent transport with providerRunId passes; hostMessageId misuse rejected', () => {
  const waReceipt = baseReceipt({ transport: 'workspace-agent', hostMessageId: undefined, providerRunId: 'apirun_1' });
  delete waReceipt.hostMessageId;
  assert.ok(isCloudBridgeOutboundReceiptV1(waReceipt));

  const misuse = baseReceipt({ transport: 'workspace-agent', providerRunId: 'apirun_1' });
  assert.ok(!isCloudBridgeOutboundReceiptV1(misuse), 'workspace-agent receipt must not claim hostMessageId');

  const wrongTransport = baseReceipt({ providerRunId: 'apirun_1' });
  assert.ok(!isCloudBridgeOutboundReceiptV1(wrongTransport), 'providerRunId only belongs to workspace-agent transport');

  assert.ok(isCloudBridgeOutboundReceiptV1(baseReceipt()), 'legacy host receipt still validates');
});

test('bindings migration: JSON-stringified versioned entry (Redis storage form) decodes identically', () => {
  const entry = {
    v: 1,
    provider: 'workspace-agent',
    workspaceId: 'ws_r',
    triggerId: 'agtch_r',
    conversationUrl: 'https://chatgpt.com/c/r-1',
  };
  const decoded = normalizeCloudCatBinding(JSON.stringify(entry));
  assert.deepEqual(decoded, entry);
  assert.equal(normalizeCloudCatBinding(JSON.stringify({ v: 1, provider: 'bogus' })), null);
  assert.equal(normalizeCloudCatBinding('{"v":1,"provider":'), null, 'truncated JSON fails closed');
});

test('round-5 R2: snapshot resolver binds identity + token at resolution time', async () => {
  const { createWorkspaceAgentTriggerConfig, resolveWorkspaceAgentTransportSnapshot } = await import(
    '../dist/domains/cats/services/cloud-bridge/workspace-agent/workspace-agent-config.js'
  );
  const root = mkdtempSync(join(tmpdir(), 'f247-wa-snap-'));
  try {
    const config = createWorkspaceAgentTriggerConfig({
      projectRoot: root,
      env: {
        CAT_CAFE_WORKSPACE_AGENT_TRIGGER_ID: 'agtch_A',
        CAT_CAFE_WORKSPACE_AGENT_WORKSPACE_ID: 'ws_A',
        CAT_CAFE_WORKSPACE_AGENT_TOKEN: 'token-A',
      },
    });
    const snapshot = resolveWorkspaceAgentTransportSnapshot(config);
    assert.equal(snapshot.triggerId, 'agtch_A');
    assert.equal(snapshot.workspaceId, 'ws_A');
    // Mid-flight owner change must not alter the in-use snapshot's identity.
    config.save({ triggerId: 'agtch_B', workspaceId: 'ws_B', token: 'token-B' });
    assert.equal(snapshot.triggerId, 'agtch_A', 'snapshot identity is immutable');
    assert.equal(snapshot.workspaceId, 'ws_A');
    assert.equal(config.resolve()?.triggerId, 'agtch_B');
    // And after disable, a fresh resolution is null while the old snapshot still completes.
    config.disable();
    assert.equal(resolveWorkspaceAgentTransportSnapshot(config), null);
    assert.equal(snapshot.triggerId, 'agtch_A');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
