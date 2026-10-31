// Concurrent invocations share session opening and refuse overlapping turns.
//
// Two simultaneous first calls share a single `openSession`. Once the open
// resolves, the call that entered the turn runs and the other is refused with
// `session_busy` — no queueing, no waiting. If the shared open fails, both
// calls see that failure and nothing is cached.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { AsyncInbox, collect, collectIterator, createFakeProvider, waitFor } from './fake-provider.js';

const HOST_SESSION_ID = 'host-session-1';
const TURN_REF = { invocationId: 'inv-1', nativeTurnId: 'turn-1' };

function bridgeFor(provider) {
  return new AgentSessionBridgeService({
    catId: 'cat-1',
    provider,
    resolveHostSession: () => ({ sessionId: HOST_SESSION_ID }),
    resolveMcpServers: () => [],
  });
}

function turnEvents(ctx) {
  return [
    { scope: 'turn', sessionId: ctx.sessionId, turn: ctx.turn, seq: 1, type: 'output', text: 'ok', textMode: 'append' },
    { scope: 'turn', sessionId: ctx.sessionId, turn: ctx.turn, seq: 2, type: 'done', outcome: 'completed' },
  ];
}

test('[23] two simultaneous first calls share one open, then exactly one runs', async () => {
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const { provider, calls } = createFakeProvider({
    continuityEvidence: 'none',
    openSessionGate: gate,
    events: turnEvents,
  });
  const service = bridgeFor(provider);

  const firstRun = collect(service.invoke('first', { invocationId: 'inv-1' }));
  const secondRun = collect(service.invoke('second', { invocationId: 'inv-2' }));
  await waitFor(() => calls.openSession.length >= 1, 'openSession');
  releaseGate();

  const results = await Promise.all([firstRun, secondRun]);

  assert.equal(calls.openSession.length, 1, 'the first open must be shared, not repeated');
  assert.equal(calls.startTurn.length, 1, 'only one call may enter a turn');

  const busyResults = results.filter((messages) => messages.some((m) => m.errorCode === 'session_busy'));
  assert.equal(busyResults.length, 1, 'exactly one call is refused as busy');
  assert.deepEqual(
    busyResults[0].map((m) => m.type),
    ['error', 'done'],
  );
  assert.equal(busyResults[0][0].errorCode, 'session_busy');
  assert.equal(busyResults[0][1].errorCode, 'session_busy', 'the done repeats the error code');

  const winner = results.find((messages) => !messages.some((m) => m.errorCode === 'session_busy'));
  assert.deepEqual(
    winner.map((m) => m.type),
    ['text', 'done'],
  );
});

test('[23] a shared open failure fails both calls and is retried on the next call', async () => {
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  let opens = 0;
  const { provider, calls } = createFakeProvider({
    continuityEvidence: 'none',
    openSessionGate: gate,
    openSessionResult: () => {
      opens += 1;
      if (opens === 1) return { ok: false, code: 'failed', reason: 'cold start failed' };
      return { ok: true, binding: { state: 'bound', nativeSessionId: 'native-1' } };
    },
    events: turnEvents,
  });
  const service = bridgeFor(provider);

  const firstRun = collect(service.invoke('first', { invocationId: 'inv-1' }));
  const secondRun = collect(service.invoke('second', { invocationId: 'inv-2' }));
  await waitFor(() => calls.openSession.length >= 1, 'openSession');
  releaseGate();

  const [first, second] = await Promise.all([firstRun, secondRun]);

  assert.equal(calls.openSession.length, 1, 'both calls await the same open');
  assert.deepEqual(
    first.map((m) => m.type),
    ['error', 'done'],
  );
  assert.deepEqual(
    second.map((m) => m.type),
    ['error', 'done'],
  );
  assert.equal(first[0].errorCode, 'failed');
  assert.equal(first[1].errorCode, 'failed');
  assert.equal(second[0].errorCode, 'failed');
  assert.equal(second[1].errorCode, 'failed');
  assert.equal(calls.startTurn.length, 0);

  const third = await collect(service.invoke('third', { invocationId: 'inv-3' }));

  assert.equal(calls.openSession.length, 2, 'the shared failure must not be cached');
  assert.equal(calls.startTurn.length, 1);
  assert.deepEqual(
    third.map((m) => m.type),
    ['text', 'done'],
  );
});

test('[16] a call while a turn is in flight is refused with session_busy', async () => {
  const inbox = new AsyncInbox();
  const { provider, calls } = createFakeProvider({ continuityEvidence: 'none', events: inbox });
  const service = bridgeFor(provider);

  const stream = service.invoke('first', { invocationId: 'inv-1' });
  const iterator = stream[Symbol.asyncIterator]();
  const firstMessage = iterator.next();
  await waitFor(() => calls.startTurn.length === 1, 'startTurn');

  inbox.push({
    scope: 'turn',
    sessionId: HOST_SESSION_ID,
    turn: TURN_REF,
    seq: 1,
    type: 'output',
    text: 'working',
    textMode: 'append',
  });
  const first = await firstMessage;
  assert.equal(first.value.type, 'text');

  const second = await collect(service.invoke('second', { invocationId: 'inv-2' }));

  assert.deepEqual(
    second.map((m) => m.type),
    ['error', 'done'],
  );
  assert.equal(second[0].errorCode, 'session_busy');
  assert.equal(second[1].errorCode, 'session_busy');
  assert.equal(calls.startTurn.length, 1, 'the busy call must not start a second turn');

  inbox.push({ scope: 'turn', sessionId: HOST_SESSION_ID, turn: TURN_REF, seq: 2, type: 'done', outcome: 'completed' });
  inbox.close();
  const rest = await collectIterator(iterator);
  assert.deepEqual(
    rest.map((m) => m.type),
    ['done'],
  );
});
