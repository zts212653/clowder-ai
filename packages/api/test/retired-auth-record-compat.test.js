import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTH_TERMINAL_DISPOSITIONS } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { authRecordFromRedisHash } from '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationRecord.js';
import {
  normalizeToolExecutionPolicy,
  parseToolExecutionPolicy,
  toolExecutionPolicyDenial,
} from '../dist/domains/cats/services/agents/invocation/tool-execution-policy.js';

const retiredModes = ['collective_participation', 'collective_work'];
const fields = (overrides = {}) => ({
  invocationId: 'historical-invocation',
  callbackToken: 'fixture-token',
  userId: 'owner',
  ownerAuthProvenance: 'strict',
  catId: 'codex61-sol',
  threadId: 'historical-thread',
  createdAt: '1000',
  state: 'completed',
  endedAt: '2000',
  endReason: 'original_completed',
  terminalRef: 'turn:original',
  ...overrides,
});
const read = (value) => authRecordFromRedisHash(value, new Set());

for (const mode of retiredModes) {
  for (const state of AUTH_TERMINAL_DISPOSITIONS) {
    test(`retired ${mode} ${state} remains diagnostic and cannot authorize any tool`, () => {
      const raw = fields({ state, toolExecutionPolicy: JSON.stringify({ mode }) });
      const original = structuredClone(raw);
      const record = read(raw);
      assert.ok(record);
      assert.equal(record.state, state);
      assert.equal(record.endedAt, 2000);
      assert.equal(record.endReason, 'original_completed');
      assert.equal(record.terminalRef, 'turn:original');
      assert.equal(record.ownerAuthProvenance, 'unknown');
      assert.equal(record.retiredAuthorization.toolExecutionPolicy, raw.toolExecutionPolicy);
      assert.deepEqual(record.toolExecutionPolicy, { mode: 'read_only', replayDeniedToolNames: [] });
      assert.equal(
        toolExecutionPolicyDenial(record.toolExecutionPolicy, 'cat_cafe_get_thread_context')?.reason,
        'read_only_tool_policy',
      );
      assert.deepEqual(raw, original, 'diagnostic reads do not rewrite the historical hash');
    });
  }
  for (const state of ['active', undefined]) {
    test(`retired ${mode} with ${state ?? 'legacy absent'} state is never an active principal`, () => {
      assert.equal(read(fields({ state, toolExecutionPolicy: JSON.stringify({ mode }) })), null);
    });
  }
  test(`new execution policy admission still rejects retired ${mode}`, () => {
    assert.throws(() => normalizeToolExecutionPolicy({ mode }));
    assert.throws(() => parseToolExecutionPolicy(JSON.stringify({ mode })));
  });
}

for (const key of ['executionGrant', 'collectiveWorkBinding']) {
  test(`a retired ${key} cannot silently become an ordinary active principal without its old policy`, () => {
    const raw = fields({ state: 'active', [key]: JSON.stringify({ original: 'binding' }) });
    assert.equal(read(raw), null);
    const terminal = read({ ...raw, state: 'completed' });
    assert.ok(terminal);
    assert.deepEqual(terminal.retiredAuthorization.bindingFields, [key]);
    assert.equal(terminal[key], undefined, 'no retired grant/binding is reintroduced as authority');
    assert.equal(terminal.ownerAuthProvenance, 'unknown');
    assert.equal(terminal.toolExecutionPolicy.mode, 'read_only');
  });
}

for (const policy of [
  '',
  '{',
  'null',
  '[]',
  '{"mode":"future_unknown"}',
  '{"mode":"read_only","replayDeniedToolNames":[1]}',
  '{"mode":"plugin_native","actionMethods":[]}',
]) {
  test(`malformed or unknown policy stays rejected even on a terminal tombstone: ${policy}`, () => {
    assert.equal(read(fields({ toolExecutionPolicy: policy })), null);
  });
}

for (const envelope of [
  { recordSchemaVersion: '999', principalKind: 'ordinary' },
  { recordSchemaVersion: '1', principalKind: 'plugin_task', pluginTaskBinding: '{}' },
  { recordSchemaVersion: '1', principalKind: 'ordinary', publicInvocationBinding: '{}' },
  { callbackToken: '' },
  { state: 'terminal_typo' },
]) {
  test(`retired policy never bypasses invalid principal metadata: ${JSON.stringify(envelope)}`, () => {
    assert.equal(read(fields({ ...envelope, toolExecutionPolicy: '{"mode":"collective_participation"}' })), null);
  });
}

test('current active ordinary and plugin-native scopes keep their exact current contract', () => {
  for (const toolExecutionPolicy of [
    undefined,
    '{"mode":"read_only","replayDeniedToolNames":[]}',
    '{"mode":"callback_allowlist","allowedCallbackRoutes":[]}',
    '{"mode":"plugin_native","pluginInstanceId":"plugin","contributionId":"mcp","actionMethods":["read"]}',
  ]) {
    const raw = fields({ state: 'active' });
    if (toolExecutionPolicy !== undefined) raw.toolExecutionPolicy = toolExecutionPolicy;
    const record = read(raw);
    assert.ok(record);
    assert.equal(record.state, 'active');
    assert.equal(record.ownerAuthProvenance, 'strict');
    assert.equal(record.retiredAuthorization, undefined);
    assert.deepEqual(
      record.toolExecutionPolicy,
      toolExecutionPolicy ? parseToolExecutionPolicy(toolExecutionPolicy) : undefined,
    );
  }
});

for (const backendName of ['MemoryAuthInvocationBackend', 'RedisAuthInvocationBackend']) {
  test(`${backendName} refuses newly supplied retired authority before any persistence`, async () => {
    const Module = await import(`../dist/domains/cats/services/agents/invocation/${backendName}.js`);
    let touchedRedis = false;
    const backend =
      backendName === 'MemoryAuthInvocationBackend'
        ? new Module[backendName]()
        : new Module[backendName]({
            get: async () => {
              touchedRedis = true;
              throw new Error('unexpected Redis access');
            },
          });
    const input = { ...fields({ state: 'active' }), createdAt: 1000, clientMessageIds: new Set() };
    for (const extra of [
      { executionGrant: '{}' },
      { collectiveWorkBinding: '{}' },
      { toolExecutionPolicy: { mode: 'collective_participation' } },
      { toolExecutionPolicy: { mode: 'collective_work' } },
    ]) {
      await assert.rejects(() => backend.create({ ...input, ...extra }));
    }
    assert.equal(touchedRedis, false);
    if (backendName === 'MemoryAuthInvocationBackend')
      assert.equal(await backend.peekRecord('historical-invocation'), null);
  });
}

for (const field of ['executionGrant', 'collectiveWorkBinding']) {
  test(`retired ${field} never masks an unknown or corrupt current policy`, () => {
    for (const raw of ['', '{"mode":"future_unknown"}', '{"mode":"read_only","replayDeniedToolNames":[1]}']) {
      for (const state of ['completed', 'active']) {
        assert.equal(read(fields({ state, [field]: '{}', toolExecutionPolicy: raw })), null);
      }
    }
  });
}

for (const backendName of ['MemoryAuthInvocationBackend', 'RedisAuthInvocationBackend']) {
  test(`${backendName} rejects terminal-only diagnostics before creating an active principal`, async () => {
    const Module = await import(`../dist/domains/cats/services/agents/invocation/${backendName}.js`);
    let touchedRedis = false;
    const backend =
      backendName === 'MemoryAuthInvocationBackend'
        ? new Module[backendName]()
        : new Module[backendName](
            new Proxy(
              {},
              {
                get() {
                  return () => {
                    touchedRedis = true;
                    throw new Error('unexpected persistence');
                  };
                },
              },
            ),
          );
    const input = {
      ...fields(),
      createdAt: 1000,
      clientMessageIds: new Set(),
      retiredAuthorization: { bindingFields: [] },
    };
    await assert.rejects(() => backend.create(input), /Unsupported invocation principal/);
    assert.equal(touchedRedis, false);
    if (backendName === 'MemoryAuthInvocationBackend') assert.equal(await backend.peekRecord(input.invocationId), null);
  });
}
