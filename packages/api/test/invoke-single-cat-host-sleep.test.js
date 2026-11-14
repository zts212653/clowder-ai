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
const { HOST_SLEEP_ERROR_NOTE, HOST_SLEEP_REPEAT_ERROR_NOTE } = await import(
  '../dist/domains/cats/services/agents/invocation/stop-reason-wording.js'
);

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

async function run(deps, extraParams = {}) {
  const messages = [];
  for await (const message of invokeSingleCat(deps, {
    catId: 'kimi31-pro',
    service: stalledProvider,
    prompt: 'test',
    userId: 'user-1',
    threadId: 'thread-1',
    parentInvocationId: 'parent-1',
    routingDispatchPreflightDecision: routingDecision,
    isLastCat: true,
    ...extraParams,
  })) {
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
