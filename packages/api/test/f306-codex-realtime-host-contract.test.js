import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import {
  isNativeRealtimeCompanionDeployment,
  REALTIME_CONVERSATION_FEATURE,
} from '../dist/domains/cats/services/agents/providers/CodexRealtimeFeatureConfig.js';
import { createHarness, sessionOptions } from './helpers/codex-host-pool-harness.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

class Inbox {
  #values = [];
  #waiters = [];
  #closed = false;

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class TurnWire {
  constructor(threadId) {
    this.threadId = threadId;
    this.inbox = new Inbox();
  }

  read() {
    return this.inbox;
  }

  async write(message) {
    if (message.method === 'initialize') this.inbox.push({ id: message.id, result: {} });
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      const threadId = message.method === 'thread/resume' ? message.params.threadId : this.threadId;
      this.inbox.push({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
    }
    if (message.method === 'turn/start') {
      this.inbox.push({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
      setImmediate(() => {
        this.inbox.push({
          method: 'turn/completed',
          params: { threadId: message.params.threadId, turn: { id: 'turn-1', status: 'completed', items: [] } },
        });
      });
    }
  }

  async close() {
    this.inbox.close();
  }
}

async function captureAppServerArgs({ enabled, sessionId, cliConfigArgs = [] }) {
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
    nativeRealtimeCompanionEnabled: enabled,
  });
  let launch;
  for await (const _event of service.invoke('contract probe', {
    invocationId: `probe-${sessionId ?? 'create'}`,
    ...(sessionId ? { sessionId } : {}),
    cliConfigArgs,
    agentCarrierSessionFactory: async (options) => {
      launch = options;
      return new TurnWire(sessionId ?? 'native-created');
    },
  })) {
    // Drain the authoritative app-server path.
  }
  assert.ok(launch, 'the injected carrier must receive the app-server launch');
  return launch.args;
}

test('Realtime attachment reuses the active session writer without weakening ordinary lease exclusion', async () => {
  const { pool, hosts } = createHarness({ idleTtlMs: 60_000 });
  try {
    const activeTurn = await pool.createSession(
      sessionOptions({ invocationId: 'turn-active', sessionId: 'native-thread-1' }),
    );
    activeTurn.rememberSession('native-thread-1');

    const companion = await pool.createSessionAttachment(
      sessionOptions({ invocationId: 'realtime-companion', sessionId: 'native-thread-1' }),
    );

    assert.equal(hosts.length, 1, 'Realtime must not spawn a competing writer process');
    assert.equal(hosts[0].connections.length, 2, 'the same host receives an isolated companion websocket');
    assert.equal(companion.reusedSessionHost, true);
    assert.equal(pool.getMetrics().activeLeaseCount, 1, 'an attachment is not a second writer lease');
    await assert.rejects(
      pool.createSessionAttachment(
        sessionOptions({ invocationId: 'realtime-duplicate', sessionId: 'native-thread-1' }),
      ),
      /already has an active host attachment/,
    );
    await assert.rejects(
      pool.createSession(sessionOptions({ invocationId: 'turn-duplicate', sessionId: 'native-thread-1' })),
      /already has an active host lease/,
    );

    await activeTurn.close();
    assert.equal(pool.getMetrics().warmHostCount, 0, 'the companion must pin the host after the turn ends');
    assert.equal(hosts[0].closeCalls, 0);

    const nextTurn = await pool.createSession(
      sessionOptions({ invocationId: 'turn-next', sessionId: 'native-thread-1' }),
    );
    assert.equal(hosts.length, 1, 'normal turns must return to the companion-owned writer host');
    assert.equal(nextTurn.reusedSessionHost, true);
    await nextTurn.close();
    assert.equal(pool.getMetrics().warmHostCount, 0, 'the live companion still pins the writer host');

    await companion.close();
    assert.equal(pool.getMetrics().warmHostCount, 1, 'the host becomes warm only after both users release it');
  } finally {
    await pool.closeAll();
  }
});

test('a cold Realtime attachment becomes the sole session owner without taking a writer lease', async () => {
  const { pool, hosts } = createHarness({ idleTtlMs: 60_000 });
  try {
    const companion = await pool.createSessionAttachment(
      sessionOptions({ invocationId: 'realtime-cold', sessionId: 'native-thread-cold' }),
    );
    assert.equal(hosts.length, 1);
    assert.equal(pool.getMetrics().activeLeaseCount, 0);
    assert.equal(companion.reusedSessionHost, false);

    const turn = await pool.createSession(
      sessionOptions({ invocationId: 'turn-after-cold', sessionId: 'native-thread-cold' }),
    );
    assert.equal(hosts.length, 1);
    assert.equal(turn.reusedSessionHost, true);
    await turn.close();
    await companion.close();
  } finally {
    await pool.closeAll();
  }
});

test('a warm session host stays pinned beyond idle TTL while Realtime is attached', async () => {
  const { pool, hosts } = createHarness({ idleTtlMs: 10 });
  try {
    const seed = await pool.createSession(sessionOptions({ sessionId: 'native-thread-warm' }));
    seed.rememberSession('native-thread-warm');
    await seed.close();
    assert.equal(pool.getMetrics().warmHostCount, 1);

    const companion = await pool.createSessionAttachment(
      sessionOptions({ invocationId: 'realtime-warm', sessionId: 'native-thread-warm' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(hosts[0].closeCalls, 0, 'the prior idle timer must be cancelled by the attachment');
    assert.equal(pool.getMetrics().warmHostCount, 0);
    await companion.close();
  } finally {
    await pool.closeAll();
  }
});

test('an attachment cannot migrate an active session across launch contracts', async () => {
  const { pool, hosts } = createHarness();
  try {
    const active = await pool.createSession(
      sessionOptions({ invocationId: 'turn-active', sessionId: 'native-thread-1' }),
    );
    active.rememberSession('native-thread-1');

    const attaching = pool.createSessionAttachment(
      sessionOptions({
        invocationId: 'realtime-mismatch',
        sessionId: 'native-thread-1',
        cwd: '/workspace/different-project',
      }),
    );
    await assert.rejects(attaching, /launch contract mismatch/);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].closeCalls, 0, 'the active writer must remain untouched');
    await active.close();
  } finally {
    await pool.closeAll();
  }
});

test('a normal turn cannot retire a differently configured host while its attachment is active', async () => {
  const { pool, hosts } = createHarness();
  try {
    const companion = await pool.createSessionAttachment(
      sessionOptions({ invocationId: 'realtime-owner', sessionId: 'native-thread-1' }),
    );
    await assert.rejects(
      pool.createSession(
        sessionOptions({
          invocationId: 'turn-mismatch',
          sessionId: 'native-thread-1',
          cwd: '/workspace/different-project',
        }),
      ),
      /attachment launch contract mismatch/,
    );
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].closeCalls, 0, 'the attached writer host must remain untouched');
    await companion.close();
  } finally {
    await pool.closeAll();
  }
});

test('an attachment close failure terminates only its websocket and releases the host pin', async () => {
  const { pool, hosts } = createHarness();
  try {
    const active = await pool.createSession(
      sessionOptions({ invocationId: 'turn-active', sessionId: 'native-thread-1' }),
    );
    active.rememberSession('native-thread-1');
    const companion = await pool.createSessionAttachment(
      sessionOptions({ invocationId: 'realtime-close-failure', sessionId: 'native-thread-1' }),
    );
    const companionConnection = hosts[0].connections[1];
    companionConnection.close = async () => {
      throw new Error('websocket close failed');
    };

    await assert.rejects(companion.close(), /websocket close failed/);
    assert.equal(companionConnection.terminateCalls, 1, 'the failed attachment socket receives a bounded fallback');
    assert.equal(hosts[0].closeCalls, 0, 'the normal writer host must not be terminated with its attachment');
    await active.close();
    assert.equal(pool.getMetrics().warmHostCount, 1, 'the failed attachment must not leave a hidden host pin');
  } finally {
    await pool.closeAll();
  }
});

test('pool shutdown closes an attached writer host once and tolerates late session cleanup', async () => {
  const { pool, hosts } = createHarness();
  const active = await pool.createSession(
    sessionOptions({ invocationId: 'turn-active', sessionId: 'native-thread-1' }),
  );
  active.rememberSession('native-thread-1');
  const companion = await pool.createSessionAttachment(
    sessionOptions({ invocationId: 'realtime-active', sessionId: 'native-thread-1' }),
  );

  await pool.closeAll();
  assert.equal(hosts[0].closeCalls, 1);
  assert.deepEqual(pool.getMetrics(), {
    liveHostCount: 0,
    activeLeaseCount: 0,
    warmHostCount: 0,
    coldStartCount: 1,
    warmHitCount: 0,
    evictionCount: 0,
  });

  await Promise.all([active.close(), companion.close()]);
  assert.equal(hosts[0].closeCalls, 1, 'late websocket cleanup must not close the provider host twice');
  assert.equal(pool.getMetrics().warmHostCount, 0, 'late attachment release must not resurrect a warm host');
});

test('only Alpha enables the server-owned Realtime feature for create and cold resume', async () => {
  assert.equal(isNativeRealtimeCompanionDeployment('alpha'), true);
  assert.equal(isNativeRealtimeCompanionDeployment('production'), false);
  assert.equal(isNativeRealtimeCompanionDeployment(undefined), false);

  for (const sessionId of [undefined, 'native-thread-cold']) {
    const args = await captureAppServerArgs({ enabled: true, sessionId });
    const featureIndex = args.indexOf('--enable');
    assert.ok(featureIndex >= 0, 'the Alpha app-server launch must own feature enablement');
    assert.equal(args[featureIndex + 1], REALTIME_CONVERSATION_FEATURE);
    assert.equal(args.filter((value) => value === REALTIME_CONVERSATION_FEATURE).length, 1);
  }
});

test('free-form CLI config cannot opt production in or disable Alpha Realtime', async () => {
  const production = await captureAppServerArgs({
    enabled: false,
    cliConfigArgs: [
      '--enable realtime_conversation',
      '--enable=realtime_conversation',
      '-c features.realtime_conversation=true',
      '-c=features.realtime_conversation=true',
      '-cfeatures.realtime_conversation=true',
      '--config features.realtime_conversation=true',
      '--config=features.realtime_conversation=true',
      '--config features.realtime_conversation.enabled=true',
      '--enable web_search',
    ],
  });
  assert.equal(
    production.some((value) => value.includes(REALTIME_CONVERSATION_FEATURE)),
    false,
    'no feature flag or config namespace may opt a production host into Realtime',
  );
  assert.ok(production.includes('web_search'), 'unrelated user feature flags remain available');

  const alpha = await captureAppServerArgs({
    enabled: true,
    cliConfigArgs: [
      '--disable realtime_conversation',
      '--disable=realtime_conversation',
      '-c features.realtime_conversation=false',
      '-c=features.realtime_conversation=false',
      '-cfeatures.realtime_conversation=false',
      '--config features.realtime_conversation=false',
      '--config=features.realtime_conversation=false',
      '--config features.realtime_conversation.enabled=false',
      '--config model_verbosity="high"',
    ],
  });
  assert.equal(alpha.includes('--disable'), false);
  assert.equal(
    alpha.some((value) => value.includes(`features.${REALTIME_CONVERSATION_FEATURE}`)),
    false,
    'member config cannot override the Alpha-owned Realtime namespace',
  );
  assert.equal(alpha.filter((value) => value === REALTIME_CONVERSATION_FEATURE).length, 1);
  assert.ok(alpha.includes('model_verbosity="high"'), 'unrelated user config retains its existing precedence');
});
