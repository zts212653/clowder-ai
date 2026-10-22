// Release all sessions owned by the bridge exactly once.
//
// The bridge owns the sessions it opened: each open is released exactly once
// with the caller's reason, the records are then dropped, a second call is a
// no-op, and a later call opens the session again from scratch. A failing
// release is a warning: the record is still dropped and never retried.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { collect, createFakeProvider, createLogSpy } from './fake-provider.js';

const HOST_SESSIONS = { a: 'host-a', b: 'host-b' };

function bridgeFor(provider, overrides = {}) {
  return new AgentSessionBridgeService({
    catId: 'cat-1',
    provider,
    resolveHostSession: (options) => ({
      sessionId: options?.sessionId === 'a' ? HOST_SESSIONS.a : HOST_SESSIONS.b,
    }),
    resolveMcpServers: () => [],
    ...overrides,
  });
}

test('[17] releaseAll releases every opened session exactly once and forgets it', async () => {
  const { provider, calls } = createFakeProvider({ continuityEvidence: 'none' });
  const service = bridgeFor(provider);

  await collect(service.invoke('first', { invocationId: 'inv-1', sessionId: 'a' }));
  await collect(service.invoke('second', { invocationId: 'inv-2', sessionId: 'b' }));
  assert.equal(calls.openSession.length, 2);
  assert.equal(calls.release.length, 0, 'a finished turn must not release its session');

  await service.releaseAll('shutdown');

  assert.deepEqual(calls.release.map((call) => call.sessionId).sort(), [HOST_SESSIONS.a, HOST_SESSIONS.b].sort());
  assert.deepEqual(
    calls.release.map((call) => call.reason),
    ['shutdown', 'shutdown'],
  );

  await service.releaseAll('again');

  assert.equal(calls.release.length, 2, 'a second releaseAll must not repeat');

  await collect(service.invoke('third', { invocationId: 'inv-3', sessionId: 'a' }));

  assert.equal(calls.openSession.length, 3, 'a later call must open the released session again');

  await service.releaseAll('final');

  assert.equal(calls.release.length, 3);
  assert.equal(calls.release[2].sessionId, HOST_SESSIONS.a);
  assert.equal(calls.release[2].reason, 'final');
});

test('[17][24] a failing release is logged, the record is dropped, and a later call opens again', async () => {
  const log = createLogSpy();
  const { provider, calls } = createFakeProvider({
    continuityEvidence: 'none',
    releaseResult: new Error('release exploded'),
  });
  const service = bridgeFor(provider, { log });

  await collect(service.invoke('p', { invocationId: 'inv-1', sessionId: 'a' }));
  assert.equal(calls.openSession.length, 1);

  await assert.doesNotReject(() => service.releaseAll('shutdown'));

  assert.equal(calls.release.length, 1);
  assert.ok(log.calls.warn.length >= 1, 'the failure must be reported through log.warn');

  await assert.doesNotReject(() => service.releaseAll('again'));

  assert.equal(calls.release.length, 1, 'a failed release is recorded away, never retried');

  await collect(service.invoke('p', { invocationId: 'inv-2', sessionId: 'a' }));

  assert.equal(calls.openSession.length, 2, 'the host session opens again after releaseAll');
  assert.equal(calls.release.length, 1, 'the new open is released only by the next releaseAll');
});

test('[24] a session that never opened is never released', async () => {
  const { provider, calls } = createFakeProvider({
    continuityEvidence: 'none',
    openSessionResult: { ok: false, code: 'failed', reason: 'no runtime' },
  });
  const service = bridgeFor(provider);

  await collect(service.invoke('p', { invocationId: 'inv-1', sessionId: 'a' }));

  await service.releaseAll('shutdown');

  assert.equal(calls.openSession.length, 1);
  assert.equal(calls.release.length, 0, 'releaseAll only covers sessions that actually opened');
});
