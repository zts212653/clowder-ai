import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAppServerClient } from '../dist/domains/cats/services/agents/providers/CodexAppServerClient.js';
import { CodexAppServerNotificationQueue } from '../dist/domains/cats/services/agents/providers/CodexAppServerNotificationQueue.js';
import { runCodexAppServerWithRecovery } from '../dist/domains/cats/services/agents/providers/CodexAppServerRunner.js';
import {
  CodexAppServerRpcError,
  CodexAppServerTurnStartTimeoutError,
} from '../dist/domains/cats/services/agents/providers/codex-app-server-rpc-error.js';

// These tests advance the production timer; no native process, network or two-minute sleep.
const receiptDeadlineMs = 120_000;
const flushProtocol = () => new Promise((resolve) => setImmediate(resolve));

class ReceiptWire {
  inbox = new CodexAppServerNotificationQueue();
  writes = [];
  terminateCalls = 0;
  closeCalls = 0;
  previousTurns = [];

  read() {
    return { [Symbol.asyncIterator]: () => ({ next: () => this.inbox.next() }) };
  }

  async write(message) {
    this.writes.push(message);
    if (message.method === 'initialize' || message.method === 'turn/interrupt') {
      this.inbox.push({ id: message.id, result: {} });
    } else if (message.method === 'config/read') {
      this.inbox.push({ id: message.id, result: { config: { mcp_servers: {} } } });
    } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
      this.inbox.push({
        id: message.id,
        result: { thread: { id: 'thread-1', turns: this.previousTurns } },
      });
    }
  }

  get turnStart() {
    return this.writes.find((message) => message.method === 'turn/start');
  }

  acknowledge() {
    this.inbox.push({ id: this.turnStart.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
  }

  started(threadId = 'thread-1', turnId = 'turn-1') {
    this.inbox.push({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
  }

  complete() {
    this.inbox.push({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    });
  }

  async close() {
    this.closeCalls++;
    this.inbox.end();
  }

  async terminate() {
    this.terminateCalls++;
    this.inbox.end();
  }
}

function observeRun(t, wire, source) {
  const state = { settled: false, values: [], error: null };
  const result = (async () => {
    try {
      for await (const value of source) state.values.push(value);
    } catch (error) {
      state.error = error;
    } finally {
      state.settled = true;
    }
    return state;
  })();
  t.after(async () => {
    wire.inbox.end();
    await result;
  });
  return { state, result };
}

const input = { prompt: { kind: 'frozen', prompt: 'work' }, thread: { kind: 'start' }, timeoutMs: 0 };

test('turn/start without a receipt fails at 120 seconds despite unrelated notifications and is never replayed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wire = new ReceiptWire();
  wire.previousTurns = [{ id: 'previous-turn', status: 'completed' }];
  let factoryCalls = 0;
  const { state, result } = observeRun(
    t,
    wire,
    runCodexAppServerWithRecovery({
      sessionFactory: async () => {
        factoryCalls++;
        return wire;
      },
      sessionOptions: {},
      runInput: { ...input, thread: { kind: 'resume', threadId: 'thread-1' } },
      retryBudget: 2,
    }),
  );
  await flushProtocol();
  assert.ok(wire.turnStart, 'the request must actually be on the wire before advancing time');
  t.mock.timers.tick(receiptDeadlineMs - 1);
  wire.started('other-thread');
  wire.started('thread-1', 'previous-turn');
  wire.inbox.push({ id: wire.turnStart.id + 100, result: { turn: { id: 'unrelated' } } });
  wire.inbox.push({ method: 'skills/changed', params: {} });
  await flushProtocol();
  assert.equal(state.settled, false);
  t.mock.timers.tick(1);
  await flushProtocol();
  assert.equal(state.settled, true, 'an unanswered turn/start must become a visible failure');
  await result;
  assert.match(state.error?.message ?? '', /turn\/start.*120000.*acceptance.*unknown/i);
  assert.equal(factoryCalls, 1, 'missing acknowledgement is not proof that replay is safe');
  assert.equal(wire.writes.filter((message) => message.method === 'turn/start').length, 1);
  assert.equal(wire.terminateCalls, 1, 'an unconfirmed carrier must not return to the warm pool');
  assert.ok(state.values.some((event) => event.type === 'app_server.lifecycle' && event.lifecycle.stage === 'failed'));
  assert.equal(state.values.at(-1)?.lifecycle?.stage, 'closed');
});

test('a second Live root receipt timeout fails the outer run and records unknown acceptance without replay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wire = new ReceiptWire();
  let factoryCalls = 0;
  let port;
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  t.after(() => finish());
  const records = [];
  const outcomes = [];
  const prepared = (text, sourceRef) => ({
    v: 1,
    message: { body: text, sourceRefs: [{ owner: 'message', ref: sourceRef }] },
    nativeInstructions: [],
    runtime: {},
    tools: {},
    providerNativeVisibility: 'unknown',
  });
  const { state, result } = observeRun(
    t,
    wire,
    runCodexAppServerWithRecovery({
      sessionFactory: async () => {
        factoryCalls++;
        return wire;
      },
      sessionOptions: {},
      retryBudget: 2,
      runInput: {
        ...input,
        prepareRequest: (text) => prepared(text, 'bootstrap'),
        prepareLiveRequest: ({ text, sourceRef }) => prepared(text, sourceRef),
        beforeProviderLaunch: async (request) => {
          records.push(request);
          return {
            requestGenerationId: `request-${records.length}`,
            generationOrdinal: records.length,
            sessionId: 'live',
          };
        },
        onLiveInputOutcome: async (receipt) => {
          outcomes.push(receipt);
          // End concurrently with settlement: a queued successful finish must not mask the timeout.
          finish();
        },
        live: {
          finished,
          ready: async (_thread, client) => {
            port = client;
          },
          observe: async () => {},
        },
      },
    }),
  );
  await flushProtocol();
  wire.acknowledge();
  await flushProtocol();
  assert.ok(port, 'the first root must have reached the real Live port');
  wire.complete();
  await flushProtocol();
  assert.ok(state.values.some((event) => event.type === 'app_server.live_turn_completed' && event.turnId === 'turn-1'));
  const submission = assert.rejects(port.submitText('second root', 'message-2'), CodexAppServerTurnStartTimeoutError);
  await flushProtocol();
  const starts = wire.writes.filter((message) => message.method === 'turn/start');
  assert.equal(starts.length, 2);
  assert.equal(starts[1].params.clientUserMessageId, 'message-2');
  assert.equal(starts[1].params.input[0].text, records[1].message.body);
  t.mock.timers.tick(receiptDeadlineMs - 1);
  await flushProtocol();
  assert.equal(state.settled, false);
  t.mock.timers.tick(1);
  await flushProtocol();
  await submission;
  assert.equal(state.settled, true, 'the outer Live run must close after its subsequent-root receipt expires');
  await result;
  assert.ok(state.error instanceof CodexAppServerTurnStartTimeoutError);
  assert.match(state.error.message, /acceptance is unknown/);
  const stages = state.values
    .filter((event) => event.type === 'app_server.lifecycle')
    .map((event) => event.lifecycle.stage);
  assert.deepEqual(stages.slice(-3), ['failed', 'closing', 'closed']);
  assert.equal(
    state.values.some((event) => event.type === 'turn.completed' && event.status === 'completed'),
    false,
  );
  assert.equal(factoryCalls, 1);
  assert.equal(wire.writes.filter((message) => message.method === 'turn/start').length, 2);
  assert.equal(wire.terminateCalls, 1, 'the unconfirmed Live carrier must be terminated instead of pooled');
  assert.deepEqual(
    outcomes.map(({ request, outcome, nativeTurnId }) => [request.requestGenerationId, outcome, nativeTurnId]),
    [['request-2', 'error', undefined]],
  );
});

test('a late but timely RPC receipt retires the deadline and leaves manual-only work unbounded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wire = new ReceiptWire();
  const lifecycle = [];
  const client = new CodexAppServerClient({ wire, onLifecycle: (value) => lifecycle.push(value) });
  const { state, result } = observeRun(t, wire, client.run(input));
  await flushProtocol();
  assert.ok(wire.turnStart);
  t.mock.timers.tick(receiptDeadlineMs - 1);
  wire.acknowledge();
  await flushProtocol();
  assert.ok(lifecycle.some((value) => value.turnAccepted));
  t.mock.timers.tick(10 * receiptDeadlineMs);
  await flushProtocol();
  assert.equal(state.settled, false);
  assert.equal(
    wire.writes.some((message) => message.method === 'turn/interrupt'),
    false,
  );
  wire.complete();
  await result;
  assert.equal(state.error, null);
  assert.equal(wire.terminateCalls, 0);
});

test('a fresh matching turn/started is an acceptance receipt even when its RPC response is missing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wire = new ReceiptWire();
  const lifecycle = [];
  const client = new CodexAppServerClient({ wire, onLifecycle: (value) => lifecycle.push(value) });
  const { state, result } = observeRun(t, wire, client.run(input));
  await flushProtocol();
  assert.ok(wire.turnStart);
  wire.started();
  await flushProtocol();
  assert.ok(lifecycle.some((value) => value.turnAccepted && value.turnId === 'turn-1'));
  t.mock.timers.tick(10 * receiptDeadlineMs);
  await flushProtocol();
  assert.equal(state.settled, false);
  wire.complete();
  await result;
  assert.equal(state.error, null);
  assert.equal(wire.terminateCalls, 0);
});

test('a typed rejection retains its provider cause and cannot fire a later receipt timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wire = new ReceiptWire();
  const client = new CodexAppServerClient({ wire });
  const { state, result } = observeRun(t, wire, client.run(input));
  await flushProtocol();
  wire.inbox.push({ id: wire.turnStart.id, error: { code: -32602, message: 'input too large' } });
  await result;
  t.mock.timers.tick(10 * receiptDeadlineMs);
  await flushProtocol();
  assert.ok(state.error instanceof CodexAppServerRpcError);
  assert.equal(state.error.message, 'input too large');
  assert.equal(wire.terminateCalls, 0);
});

test('explicit cancellation retires the pending receipt timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wire = new ReceiptWire();
  const controller = new AbortController();
  const client = new CodexAppServerClient({ wire });
  const { state, result } = observeRun(t, wire, client.run({ ...input, signal: controller.signal }));
  await flushProtocol();
  assert.ok(wire.turnStart);
  controller.abort();
  await result;
  t.mock.timers.tick(10 * receiptDeadlineMs);
  await flushProtocol();
  assert.doesNotMatch(state.error?.message ?? '', /acknowledge.*120000/i);
  assert.equal(wire.terminateCalls, 1);
});

test('the receipt clock starts after outbound archival, not while request evidence is pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wire = new ReceiptWire();
  let releaseArchive;
  const archived = new Promise((resolve) => {
    releaseArchive = resolve;
  });
  t.after(() => releaseArchive());
  const client = new CodexAppServerClient({
    wire,
    onEnvelope: async (direction, envelope) => {
      if (direction === 'outbound' && envelope.method === 'turn/start') await archived;
    },
  });
  const { state, result } = observeRun(t, wire, client.run(input));
  await flushProtocol();
  t.mock.timers.tick(10 * receiptDeadlineMs);
  await flushProtocol();
  assert.equal(state.settled, false);
  assert.equal(wire.turnStart, undefined);
  releaseArchive();
  await flushProtocol();
  assert.ok(wire.turnStart);
  wire.acknowledge();
  await flushProtocol();
  wire.complete();
  await result;
  assert.equal(state.error, null);
});
