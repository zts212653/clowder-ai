import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { AntigravityAgentService } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js';
import { collect, createMockBridge } from './antigravity-agent-service-test-helpers.js';

function activeRecord(runtimeSessionId) {
  return {
    sessionId: 'sess-reg6',
    runtime: 'antigravity-desktop',
    runtimeSessionId,
    threadId: 'thread-reg6',
    catId: 'antigravity',
    surface: 'cat-cafe-dispatch',
    identityHistory: [{ catId: 'antigravity', model: 'gemini-3.1-pro', from: 1000, source: 'session_init' }],
    lifecycle: { state: 'active', startedAt: 1000, lastObservedAt: 2000 },
  };
}
function storeProbe(record) {
  return {
    upsert: mock.fn(async (m) => m),
    getBySessionId: mock.fn(async () => null),
    getByRuntimeSession: mock.fn(async () => record ?? null),
    getActiveByThreadCat: mock.fn(async () => null),
    listByLifecycleState: mock.fn(async () => []),
    listRecent: mock.fn(async () => []),
    updateLifecycle: mock.fn(async () => null),
  };
}

describe('F211-REG6: interruption-abort must not be sealed as a runtime crash', () => {
  test('an "Aborted" interruption mid-invoke does NOT seal runtime_error_reset (preserve cascade for REG5 reuse)', async () => {
    const bridge = createMockBridge({ cascadeId: 'cascade-reg6', pollError: 'Aborted' });
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      runtimeSessionStore: storeProbe(activeRecord('cascade-reg6')),
    });
    const msgs = await collect(service.invoke('hi', { threadId: 'thread-reg6' }));
    const err = msgs.find((m) => m.type === 'error');
    assert.ok(err, 'an aborted invoke should still surface an error message');
    // gpt52 review: assert the cascade is PRESERVED — no seal at all (not merely "a different seal
    // reason"), so a future change that seals abort with any reason can't silently pass. The whole
    // point of REG6 is that an interruption-abort leaves the cascade active for the next message (REG5).
    assert.equal(
      err.sessionLifecycle,
      undefined,
      'REG6: an interruption-abort must PRESERVE the cascade — emit NO sessionLifecycle seal (any seal fires cascade-replacement and loses REG5 continuity)',
    );
  });

  test('a genuine runtime error DOES still seal runtime_error_reset (crash classification preserved)', async () => {
    const bridge = createMockBridge({ cascadeId: 'cascade-reg6b', pollError: 'LS connection exploded' });
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      runtimeSessionStore: storeProbe(activeRecord('cascade-reg6b')),
    });
    const msgs = await collect(service.invoke('hi', { threadId: 'thread-reg6' }));
    const err = msgs.find((m) => m.type === 'error');
    assert.ok(err, 'a real error should surface');
    assert.equal(
      err.sessionLifecycle?.sealReason,
      'runtime_error_reset',
      'a genuine crash must still seal runtime_error_reset',
    );
  });
});
