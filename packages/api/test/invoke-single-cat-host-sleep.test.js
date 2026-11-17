import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
const {
  HOST_SLEEP_ERROR_NOTE,
  HOST_SLEEP_REPEAT_ERROR_NOTE,
  RESTART_SHUTDOWN_ERROR_NOTE,
  RESTART_SHUTDOWN_REPEAT_ERROR_NOTE,
} = await import('../dist/domains/cats/services/agents/invocation/stop-reason-wording.js');

let auditDir;
let originalAuditDir;
let originalPreflightDisable;

before(async () => {
  auditDir = await mkdtemp(join(tmpdir(), 'host-sleep-audit-'));
  originalAuditDir = process.env.AUDIT_LOG_DIR;
  originalPreflightDisable = process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT;
  process.env.AUDIT_LOG_DIR = auditDir;
  process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = '1';
});

after(async () => {
  if (originalAuditDir === undefined) delete process.env.AUDIT_LOG_DIR;
  else process.env.AUDIT_LOG_DIR = originalAuditDir;
  if (originalPreflightDisable === undefined) delete process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT;
  else process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = originalPreflightDisable;
  await rm(auditDir, { recursive: true, force: true });
});

const routingDecision = {
  v: 1,
  ownerId: 'user-1',
  observedAt: 1,
  resolverState: 'fresh',
  snapshotRef: 'routing-snapshot:1',
  targets: [{ targetCatId: 'kimi31-pro', disposition: 'allowed', reasons: [], alternatives: [] }],
};

/** The provider stalls (the machine "sleeps" through it), then its stream ends empty. */
const stalledProvider = {
  async *invoke() {
    await new Promise((resolve) => setTimeout(resolve, 30));
    yield {
      type: 'error',
      catId: 'kimi31-pro',
      error: 'kimi 未返回可用回复或工具调用',
      errorCode: 'network_error',
      timestamp: Date.now(),
    };
    yield { type: 'done', catId: 'kimi31-pro', timestamp: Date.now() };
  },
};

/** Power evidence relative to the window the invocation asks for: slept just after start, woke just before. */
const sleptThroughTheTurn = async ({ from, to }) => ({
  status: 'available',
  confirmedSleep: [{ evidenceId: 'mac-power:t', startedAt: from + 5, endedAt: to - 5, wakeKind: 'dark' }],
});

function harness(invocationId, readEvidence) {
  const store = new InMemoryTurnExecutionStore();
  const scheduled = [];
  const observed = [];
  const deps = {
    registry: {
      create: async () => ({ invocationId, callbackToken: `token-${invocationId}` }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp/test',
    },
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
    turnExecutionStore: store,
    hostSleep: { readEvidence, scheduleContinuation: (input) => scheduled.push(input) },
    routingDispatchSignalObserver: {
      async observeTerminal(evidence) {
        observed.push(evidence);
      },
    },
  };
  return { store, scheduled, observed, deps };
}

const baseParams = {
  catId: 'kimi31-pro',
  service: stalledProvider,
  prompt: 'test',
  userId: 'user-1',
  threadId: 'thread-1',
  parentInvocationId: 'parent-1',
  routingDispatchPreflightDecision: routingDecision,
  isLastCat: true,
};

async function run(deps, extraParams = {}) {
  const messages = [];
  for await (const message of invokeSingleCat(deps, { ...baseParams, ...extraParams })) {
    messages.push(message);
  }
  return messages;
}

describe('F337 invokeSingleCat host sleep', () => {
  test('a failure after a mid-turn sleep is recorded as host_sleep, explained, and waits for the lid', async () => {
    const h = harness('child-slept', sleptThroughTheTurn);
    const messages = await run(h.deps);

    const terminal = await h.store.get('child-slept');
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.terminalReason, 'host_sleep');
    const error = messages.find((message) => message.type === 'error');
    assert.ok(error.error.endsWith(HOST_SLEEP_ERROR_NOTE.trim()), error.error);
    const done = messages.find((message) => message.type === 'done');
    assert.equal(done.errorCode, 'HOST_SLEEP', 'the response reason the receipt reads');
    assert.equal(h.scheduled.length, 1);
    assert.equal(h.scheduled[0].invocationId, 'child-slept');
    assert.equal(h.observed.length, 1);
    assert.equal(h.observed[0].status, 'failed');
    assert.equal(h.observed[0].failureClass, undefined, 'a sleeping machine is no provider outage');
  });

  test('without readable power evidence the failure stays a provider failure', async () => {
    const h = harness('child-unknown', async () => ({ status: 'unavailable', reason: 'power log unavailable' }));
    const messages = await run(h.deps);

    const terminal = await h.store.get('child-unknown');
    assert.equal(terminal.terminalReason, 'provider_execution_failed');
    const error = messages.find((message) => message.type === 'error');
    assert.equal(error.error, 'kimi 未返回可用回复或工具调用');
    assert.deepEqual(h.scheduled, []);
    assert.equal(h.observed[0].failureClass, 'provider_unreachable');
  });

  test('a sleep that ended long before the failure is not blamed', async () => {
    const h = harness('child-old-sleep', async ({ from }) => ({
      status: 'available',
      confirmedSleep: [
        { evidenceId: 'mac-power:old', startedAt: from - 60_000, endedAt: from - 30_000, wakeKind: 'full' },
      ],
    }));
    await run(h.deps);
    assert.equal((await h.store.get('child-old-sleep')).terminalReason, 'provider_execution_failed');
    assert.deepEqual(h.scheduled, []);
  });

  // Review R2 (codex61-sol, PR #7038): a turn the loop guard will not wake again must not promise to.
  test('a continuation cut by sleep again says it will not be woken, and schedules nothing', async () => {
    const h = harness('child-repeat', sleptThroughTheTurn);
    h.deps.messageStore = {
      getById: async (id) => (id === 'continuation-msg' ? { id, source: { connector: 'restart-recovery' } } : null),
    };
    const messages = await run(h.deps, { executionCausal: { triggerMessageId: 'continuation-msg' } });

    assert.equal((await h.store.get('child-repeat')).terminalReason, 'host_sleep_repeat');
    const error = messages.find((message) => message.type === 'error');
    assert.ok(error.error.endsWith(HOST_SLEEP_REPEAT_ERROR_NOTE.trim()), error.error);
    assert.equal(messages.find((message) => message.type === 'done').errorCode, 'HOST_SLEEP_REPEAT');
    assert.deepEqual(h.scheduled, []);
  });
});

// Boot 90 (11-15 01:04 PST): `runtime:restart` signalled the API and its provider children together; four
// turns ended 1.2–1.7 s later as provider failures while the API was still up, and nobody recalled them.
describe('F337 invokeSingleCat runtime stop', () => {
  /** The runtime's stop begins mid-turn and takes the provider down with it: an error, a closed stream, or a throw. */
  function cutByStop(stop, { error = true, throws = false } = {}) {
    return {
      async *invoke() {
        yield { type: 'text', catId: 'kimi31-pro', content: '在做了', timestamp: Date.now() };
        stop.begun = true;
        if (throws) throw new Error('provider killed during shutdown');
        if (!error) return;
        yield {
          type: 'error',
          catId: 'kimi31-pro',
          error: 'provider process exited',
          errorCode: 'network_error',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'kimi31-pro', timestamp: Date.now() };
      },
    };
  }

  function stopHarness(invocationId) {
    const stop = { begun: false };
    let powerLogReads = 0;
    const h = harness(invocationId, async () => {
      powerLogReads += 1;
      return { status: 'unavailable', reason: 'not needed' };
    });
    h.deps.isRuntimeShuttingDown = () => stop.begun;
    return { ...h, stop, powerLogReads: () => powerLogReads };
  }

  const owedIds = async (store) => (await store.listOwedContinuations()).map((record) => record.invocationId);

  test('a provider failure after the stop began is a restart cut, explained, and owed to the next boot', async () => {
    const h = stopHarness('child-stopped');
    const messages = await run(h.deps, { service: cutByStop(h.stop) });

    const terminal = await h.store.get('child-stopped');
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.terminalReason, 'restart_shutdown');
    const error = messages.find((message) => message.type === 'error');
    assert.ok(error.error.endsWith(RESTART_SHUTDOWN_ERROR_NOTE.trim()), error.error);
    assert.equal(messages.find((message) => message.type === 'done').errorCode, 'RESTART_SHUTDOWN');
    assert.equal(h.observed[0].failureClass, undefined, 'a restarting runtime is no provider outage');
    assert.deepEqual(await owedIds(h.store), ['child-stopped']);
    assert.deepEqual(h.scheduled, [], 'nothing waits in a process that is exiting');
    assert.equal(h.powerLogReads(), 0, 'the stop is known; the power log is not consulted');
  });

  // Review R1 P1-2 (codex61-sol, PR #7102): the reply and the caller's receipt must carry the cut too.
  for (const [mode, shape] of [
    ['closes its stream', { error: false }],
    ['throws', { throws: true }],
  ]) {
    test(`a provider that ${mode} after the stop began is a restart cut, in the record, the reply and the receipt`, async () => {
      const h = stopHarness(`child-${shape.throws ? 'threw' : 'closed'}`);
      const messages = await run(h.deps, { service: cutByStop(h.stop, shape) });

      const terminal = await h.store.get(`child-${shape.throws ? 'threw' : 'closed'}`);
      assert.equal(terminal.status, 'failed');
      assert.equal(terminal.terminalReason, 'restart_shutdown');
      const error = messages.find((message) => message.type === 'error');
      assert.ok(error?.error.endsWith(RESTART_SHUTDOWN_ERROR_NOTE.trim()), error?.error);
      assert.equal(messages.find((message) => message.type === 'done')?.errorCode, 'RESTART_SHUTDOWN');
      assert.equal(h.observed[0].failureClass, undefined);
      assert.deepEqual(await owedIds(h.store), [terminal.invocationId]);
    });
  }

  test('a continuation whose stream closes in the stop again says it will not be recalled', async () => {
    const h = stopHarness('child-closed-again');
    h.deps.messageStore = {
      getById: async (id) => (id === 'continuation-msg' ? { id, source: { connector: 'restart-recovery' } } : null),
    };
    const messages = await run(h.deps, {
      service: cutByStop(h.stop, { error: false }),
      executionCausal: { triggerMessageId: 'continuation-msg' },
    });

    assert.equal((await h.store.get('child-closed-again')).terminalReason, 'restart_shutdown_repeat');
    const error = messages.find((message) => message.type === 'error');
    assert.ok(error?.error.endsWith(RESTART_SHUTDOWN_REPEAT_ERROR_NOTE.trim()), error?.error);
    assert.equal(messages.find((message) => message.type === 'done')?.errorCode, 'RESTART_SHUTDOWN_REPEAT');
    assert.deepEqual(await owedIds(h.store), []);
  });

  test('a reader that stops reading after the stop began still records the restart cut', async () => {
    const h = stopHarness('child-dropped');
    const service = {
      async *invoke() {
        yield { type: 'text', catId: 'kimi31-pro', content: '在做了', timestamp: Date.now() };
        h.stop.begun = true;
        yield { type: 'text', catId: 'kimi31-pro', content: '还在做', timestamp: Date.now() };
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      },
    };
    for await (const message of invokeSingleCat(h.deps, { ...baseParams, service })) {
      if (message.type === 'text' && h.stop.begun) break;
    }

    assert.equal((await h.store.get('child-dropped')).terminalReason, 'restart_shutdown');
    assert.deepEqual(await owedIds(h.store), ['child-dropped']);
  });

  test('a user stop while the runtime is stopping stays a user cancel', async () => {
    const h = stopHarness('child-cancelled');
    const controller = new AbortController();
    const service = {
      async *invoke() {
        yield { type: 'text', catId: 'kimi31-pro', content: '在做了', timestamp: Date.now() };
        h.stop.begun = true;
        controller.abort();
        throw new Error('aborted');
      },
    };
    await run(h.deps, { service, signal: controller.signal });

    const terminal = await h.store.get('child-cancelled');
    assert.equal(terminal.status, 'canceled');
    assert.equal(terminal.terminalReason, 'user_cancel');
    assert.deepEqual(await owedIds(h.store), []);
  });

  test('the same closed stream with no stop under way stays an interruption, owed to no one', async () => {
    const h = stopHarness('child-ended');
    const quiet = { begun: false };
    await run(h.deps, { service: cutByStop(quiet, { error: false }) });

    const terminal = await h.store.get('child-ended');
    assert.equal(terminal.status, 'interrupted');
    assert.equal(terminal.terminalReason, 'provider_ended_without_terminal_done');
    assert.deepEqual(await owedIds(h.store), []);
  });

  test('a continuation cut by the stop again says it will not be recalled, and is not owed', async () => {
    const h = stopHarness('child-stopped-again');
    h.deps.messageStore = {
      getById: async (id) => (id === 'continuation-msg' ? { id, source: { connector: 'restart-recovery' } } : null),
    };
    const messages = await run(h.deps, {
      service: cutByStop(h.stop),
      executionCausal: { triggerMessageId: 'continuation-msg' },
    });

    assert.equal((await h.store.get('child-stopped-again')).terminalReason, 'restart_shutdown_repeat');
    const error = messages.find((message) => message.type === 'error');
    assert.ok(error.error.endsWith(RESTART_SHUTDOWN_REPEAT_ERROR_NOTE.trim()), error.error);
    assert.equal(messages.find((message) => message.type === 'done').errorCode, 'RESTART_SHUTDOWN_REPEAT');
    assert.deepEqual(await owedIds(h.store), []);
  });
});
