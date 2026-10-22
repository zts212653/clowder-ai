// Compaction events await the observer without producing turn messages.
//
// It is a constructor option, it is awaited once per `compaction_observed`
// event, it produces no AgentMessage, and a throwing observer is a warning —
// not a failed turn. Repetitions are not deduped here; that is Host work.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { AsyncInbox, collect, collectIterator, createFakeProvider, createLogSpy, waitFor } from './fake-provider.js';

const HOST_SESSION_ID = 'host-session-1';

function bridgeFor(provider, overrides = {}) {
  return new AgentSessionBridgeService({
    catId: 'cat-1',
    provider,
    resolveHostSession: () => ({ sessionId: HOST_SESSION_ID }),
    resolveMcpServers: () => [],
    ...overrides,
  });
}

function compactionEvent(sessionId, seq, observation) {
  return { scope: 'session', sessionId, seq, type: 'compaction_observed', observation };
}

function turnEvent(ctx, seq, fields) {
  return { scope: 'turn', sessionId: ctx.sessionId, turn: ctx.turn, seq, ...fields };
}

test('[2] every compaction_observed event reaches the observer once, with the host session id', async () => {
  const observed = [];
  const first = { eventId: 'compaction-1', runtimeSessionId: 'native-1', evidenceRef: 'evidence-1' };
  const second = { eventId: 'compaction-2', runtimeSessionId: 'native-1', evidenceRef: 'evidence-2' };
  const { provider } = createFakeProvider({
    continuityEvidence: 'none',
    events: (ctx) => [
      compactionEvent(ctx.sessionId, 1, first),
      compactionEvent(ctx.sessionId, 2, second),
      turnEvent(ctx, 3, { type: 'output', text: 'after compaction', textMode: 'append' }),
      turnEvent(ctx, 4, { type: 'done', outcome: 'completed' }),
    ],
  });
  const service = bridgeFor(provider, {
    onCompactionObserved: (observation, ctx) => {
      observed.push({ observation, ctx });
    },
  });

  const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.equal(observed.length, 2);
  assert.equal(observed[0].observation, first, 'the observation must be passed through untouched');
  assert.equal(observed[1].observation, second);
  assert.deepEqual(observed[0].ctx, { sessionId: HOST_SESSION_ID });
  assert.deepEqual(
    messages.map((m) => m.type),
    ['text', 'done'],
    'the callback produces no message',
  );
});

test('[2] the bridge awaits the observer before it continues the turn', async () => {
  const inbox = new AsyncInbox();
  const observed = [];
  let releaseObserver;
  const observerGate = new Promise((resolve) => {
    releaseObserver = resolve;
  });

  const { provider, calls } = createFakeProvider({ continuityEvidence: 'none', events: inbox });
  const service = bridgeFor(provider, {
    onCompactionObserved: async (observation, ctx) => {
      observed.push({ observation, ctx });
      await observerGate;
    },
  });

  const stream = service.invoke('p', { invocationId: 'inv-1' });
  const iterator = stream[Symbol.asyncIterator]();
  const firstMessage = iterator.next();
  await waitFor(() => calls.startTurn.length === 1, 'startTurn');

  inbox.push(compactionEvent(HOST_SESSION_ID, 1, { eventId: 'c1', runtimeSessionId: 'native-1', evidenceRef: 'e1' }));
  inbox.push({
    scope: 'turn',
    sessionId: HOST_SESSION_ID,
    turn: { invocationId: 'inv-1', nativeTurnId: 'turn-1' },
    seq: 2,
    type: 'output',
    text: 'after',
    textMode: 'append',
  });

  await waitFor(() => observed.length === 1, 'compaction observation');

  // Holding the observer's gate is what makes this a safe negative check: the
  // text is already buffered, so it can only stay undelivered if it is awaited.
  let delivered = false;
  firstMessage.then(() => {
    delivered = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(delivered, false, 'the turn must not advance while the observer is pending');

  releaseObserver();
  const first = await firstMessage;
  assert.equal(first.value.type, 'text');
  assert.equal(first.value.content, 'after');

  inbox.push({
    scope: 'turn',
    sessionId: HOST_SESSION_ID,
    turn: { invocationId: 'inv-1', nativeTurnId: 'turn-1' },
    seq: 3,
    type: 'done',
    outcome: 'completed',
  });
  inbox.close();
  await collectIterator(iterator);
});

test('[2] a throwing observer is logged and the turn continues', async () => {
  const log = createLogSpy();
  const { provider } = createFakeProvider({
    continuityEvidence: 'none',
    events: (ctx) => [
      compactionEvent(ctx.sessionId, 1, { eventId: 'c1', runtimeSessionId: 'native-1', evidenceRef: 'e1' }),
      turnEvent(ctx, 2, { type: 'output', text: 'still here', textMode: 'append' }),
      turnEvent(ctx, 3, { type: 'done', outcome: 'completed' }),
    ],
  });
  const service = bridgeFor(provider, {
    log,
    onCompactionObserved: () => {
      throw new Error('observer exploded');
    },
  });

  const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.deepEqual(
    messages.map((m) => m.type),
    ['text', 'done'],
  );
  assert.equal(messages[0].content, 'still here');
  assert.ok(log.calls.warn.length >= 1, 'the failure must be reported through log.warn');
});

test('[25] a repeated observation is delivered every time, in event order', async () => {
  const repeated = { eventId: 'compaction-1', runtimeSessionId: 'native-1', evidenceRef: 'evidence-1' };
  const other = { eventId: 'compaction-2', runtimeSessionId: 'native-1', evidenceRef: 'evidence-2' };
  const observed = [];

  const { provider } = createFakeProvider({
    continuityEvidence: 'none',
    events: (ctx) => [
      compactionEvent(ctx.sessionId, 1, repeated),
      compactionEvent(ctx.sessionId, 2, repeated),
      compactionEvent(ctx.sessionId, 3, other),
      turnEvent(ctx, 4, { type: 'output', text: 'ok', textMode: 'append' }),
      turnEvent(ctx, 5, { type: 'done', outcome: 'completed' }),
    ],
  });
  const service = bridgeFor(provider, {
    onCompactionObserved: (observation) => {
      observed.push(observation.eventId);
    },
  });

  const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.deepEqual(
    observed,
    ['compaction-1', 'compaction-1', 'compaction-2'],
    'dedupe belongs to the Host, not the bridge',
  );
  assert.deepEqual(
    messages.map((m) => m.type),
    ['text', 'done'],
  );
});

test('[2] without an observer the compaction event is dropped silently', async () => {
  const { provider } = createFakeProvider({
    continuityEvidence: 'none',
    events: (ctx) => [
      compactionEvent(ctx.sessionId, 1, { eventId: 'c1', runtimeSessionId: 'native-1', evidenceRef: 'e1' }),
      turnEvent(ctx, 2, { type: 'output', text: 'ok', textMode: 'append' }),
      turnEvent(ctx, 3, { type: 'done', outcome: 'completed' }),
    ],
  });
  const service = bridgeFor(provider);

  const messages = await collect(service.invoke('p', { invocationId: 'inv-1' }));

  assert.deepEqual(
    messages.map((m) => m.type),
    ['text', 'done'],
  );
});
