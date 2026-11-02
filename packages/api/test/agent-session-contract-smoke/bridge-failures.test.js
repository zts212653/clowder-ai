// Bridge refusals report explicit errors and complete the turn.
//
// A missing invocation id is checked before the session is
// opened. A `startTurn` refusal becomes error + done, with the provider's
// code, and neither cancels nor releases anything. An openSession failure
// is not cached, so the next call retries the open.
//
// An `openSession` refusal reports its code and reason, and
// A thrown error becomes `session_contract_failed`.
// Every bridge-produced error is followed by a done with the same code.
// An empty invocationId counts as missing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { collect, createFakeProvider } from './fake-provider.js';

const HOST_SESSION_ID = 'host-session-1';

function bridgeFor(provider) {
  return new AgentSessionBridgeService({
    catId: 'cat-1',
    provider,
    resolveHostSession: () => ({ sessionId: HOST_SESSION_ID }),
    resolveMcpServers: () => [],
  });
}

test('[9][22] a missing options.invocationId refuses before opening a session', async () => {
  const { provider, calls } = createFakeProvider({ continuityEvidence: 'none' });
  const service = bridgeFor(provider);

  const messages = await collect(service.invoke('p', {}));

  assert.deepEqual(
    messages.map((m) => m.type),
    ['error', 'done'],
  );
  assert.equal(messages[0].errorCode, 'invocation_id_missing');
  assert.equal(messages[1].errorCode, 'invocation_id_missing', 'the done repeats the error code');
  assert.equal(calls.openSession.length, 0, 'the id check comes before openSession');
  assert.equal(calls.startTurn.length, 0, 'the bridge must not invent an invocation id');
});

test('[27] an empty invocationId counts as missing', async () => {
  const { provider, calls } = createFakeProvider({ continuityEvidence: 'none' });
  const service = bridgeFor(provider);

  const messages = await collect(service.invoke('p', { invocationId: '' }));

  assert.deepEqual(
    messages.map((m) => m.type),
    ['error', 'done'],
  );
  assert.equal(messages[0].errorCode, 'invocation_id_missing');
  assert.equal(messages[1].errorCode, 'invocation_id_missing');
  assert.equal(calls.openSession.length, 0, 'an empty id must not open a session either');
});

test('[6][22] a startTurn refusal becomes error + done with the provider code, and nothing else', async () => {
  const { provider, calls } = createFakeProvider({
    continuityEvidence: 'none',
    startTurnResult: { ok: false, code: 'busy', reason: 'turn already running' },
  });
  const service = bridgeFor(provider);

  const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.deepEqual(
    messages.map((m) => m.type),
    ['error', 'done'],
  );
  assert.equal(messages[0].errorCode, 'busy');
  assert.equal(messages[0].error, 'turn already running');
  assert.equal(messages[1].errorCode, 'busy');
  assert.equal(calls.cancelTurn.length, 0, 'a refused turn has nothing to cancel');
  assert.equal(calls.release.length, 0, 'a refused turn must not release the session');
});

test('[6] a startTurn refusal without a reason uses the code as the error text', async () => {
  const { provider } = createFakeProvider({
    continuityEvidence: 'none',
    startTurnResult: { ok: false, code: 'session_unavailable' },
  });
  const service = bridgeFor(provider);

  const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.equal(messages[0].error, 'session_unavailable');
  assert.equal(messages.at(-1).errorCode, 'session_unavailable');
});

test('[21][22] a refused openSession reports its code and reason on error and done', async () => {
  const { provider, calls } = createFakeProvider({
    continuityEvidence: 'none',
    openSessionResult: { ok: false, code: 'resume_unavailable', reason: 'native session gone' },
  });
  const service = bridgeFor(provider);

  const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.equal(calls.openSession.length, 1);
  assert.equal(calls.startTurn.length, 0);
  assert.deepEqual(
    messages.map((m) => m.type),
    ['error', 'done'],
  );
  assert.equal(messages[0].errorCode, 'resume_unavailable');
  assert.equal(messages[0].error, 'native session gone');
  assert.equal(messages[1].errorCode, 'resume_unavailable');
});

test('[21] a refused openSession without a reason uses the code as the error text', async () => {
  const { provider } = createFakeProvider({
    continuityEvidence: 'none',
    openSessionResult: { ok: false, code: 'failed' },
  });
  const service = bridgeFor(provider);

  const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.equal(messages[0].errorCode, 'failed');
  assert.equal(messages[0].error, 'failed');
  assert.equal(messages.at(-1).errorCode, 'failed');
});

test('[21][22] a thrown openSession becomes session_contract_failed', async () => {
  const { provider, calls } = createFakeProvider({
    continuityEvidence: 'none',
    openSessionResult: new Error('socket vanished'),
  });
  const service = bridgeFor(provider);

  const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.equal(calls.startTurn.length, 0);
  assert.deepEqual(
    messages.map((m) => m.type),
    ['error', 'done'],
  );
  assert.equal(messages[0].errorCode, 'session_contract_failed');
  assert.equal(messages[0].error, 'socket vanished');
  assert.equal(messages[1].errorCode, 'session_contract_failed');
});

test('[16] a failed openSession is not cached, so the next call opens again', async () => {
  let opens = 0;
  const { provider, calls } = createFakeProvider({
    continuityEvidence: 'none',
    openSessionResult: () => {
      opens += 1;
      if (opens === 1) return { ok: false, code: 'failed', reason: 'transient' };
      return { ok: true, binding: { state: 'bound', nativeSessionId: 'native-1' } };
    },
  });
  const service = bridgeFor(provider);

  const first = await collect(service.invoke('p', { invocationId: 'inv-1' }));
  const second = await collect(service.invoke('p', { invocationId: 'inv-2' }));

  assert.deepEqual(
    first.map((m) => m.type),
    ['error', 'done'],
  );
  assert.equal(calls.openSession.length, 2);
  assert.equal(calls.startTurn.length, 1, 'the retried call reaches the provider');
  assert.deepEqual(
    second.map((m) => m.type),
    ['done'],
  );
});
