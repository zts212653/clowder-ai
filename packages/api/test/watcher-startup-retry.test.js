import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { parseWatcherSessionState } from '@cat-cafe/shared';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { watcherInvocationAuthority } from '../dist/domains/concierge/watcher/watcher-authority.js';
import { saveWatcherState } from '../dist/domains/concierge/watcher/watcher-checkpoint.js';
import { settleWatcherStartupFailure } from '../dist/domains/concierge/watcher/watcher-startup-failure.js';
import { watcherWorld } from './helpers/watcher-world.js';

const { WatcherSupervisor } = await import(
  process.env.F335_STARTUP_RED_SUPERVISOR_MODULE ?? '../dist/domains/concierge/watcher/WatcherSupervisor.js'
);
const { runWatcherInvocation } = await import(
  process.env.F335_STARTUP_RED_INVOCATION_MODULE ?? '../dist/domains/concierge/watcher/watcher-invocation.js'
);

async function failed({ bound = false, teardown = true } = {}) {
  const w = await watcherWorld();
  const [source] = await w.work('ordinary source remains independent');
  let session = await w.sessions.getOrCreateActive({
    userId: source.userId,
    threadId: source.threadId,
    catId: 'codex',
    sessionPurpose: 'watcher',
    chainKey: watcherSessionChainKey(source.userId, 'codex', source.threadId),
  });
  const owners = {
    ...w,
    apiUrl: 'http://127.0.0.1:3102',
    transcript: { appendDurableEvent: async () => {} },
    maySpeak: async () => true,
  };
  const run = { session, state: parseWatcherSessionState(undefined), prefixTokens: 0, committed: false };
  const { auth } = await watcherInvocationAuthority(owners, run, source, []);
  const startedAt = Date.now();
  await w.executions.markProviderStarted(auth.invocationId, startedAt);
  if (teardown) await w.executions.recordProviderTeardown(auth.invocationId, startedAt + 1);
  if (bound) session = await w.sessions.bindCliSessionIdIfUnbound(session.id, 'original-native');
  await saveWatcherState(w.sessions, session.id, run.state, {
    activationCut: '0:0',
    wakeInvocationId: auth.invocationId,
    attempt: {
      invocationId: auth.invocationId,
      sourceInvocationId: source.invocationId,
      sourceSequence: source.settledSequence,
      startedAt: Date.now(),
      phase: 'failed',
      failure: 'configuration rejected',
    },
  });
  let launches = 0;
  const service = {
    boundedWatcherSessionCapability: () => ({ supported: true }),
    async *invoke() {
      launches++;
      throw new Error('configuration rejected before native admission');
    },
  };
  return { ...w, owners, source, session, auth, service, launches: () => launches };
}

for (const recoveryOnly of [false, true]) {
  test(`a proved pre-native failure settles the original principal without launching when recoveryOnly=${recoveryOnly}`, async () => {
    const f = await failed();
    await runWatcherInvocation(f.owners, {
      session: f.session,
      source: f.source,
      service: f.service,
      quiet: true,
      recoveryOnly,
    });
    assert.equal(f.launches(), 0);
    const row = await f.executions.get(f.auth.invocationId);
    assert.notEqual(row.status, 'running');
    assert.equal(row.responseSettlement.kind, 'no_response');
    assert.equal((await f.registry.verify(f.auth.invocationId, f.auth.callbackToken)).ok, false);
    const state = parseWatcherSessionState((await f.sessions.get(f.session.id)).watcherState);
    assert.equal(state.attempt, undefined);
    assert.equal(state.wakeInvocationId, undefined);
    assert.equal(state.afterSequence, 0, 'failure never pretends to consume original text');
    assert.equal((await f.executions.listByParent(`watcher-source:codex:${f.source.invocationId}`)).length, 1);
  });
}

test('a started provider without its exit fact remains pending, even without a native binding', async () => {
  const f = await failed({ teardown: false });
  assert.equal(await settleWatcherStartupFailure(f.owners, await f.sessions.get(f.session.id), f.source), false);
  assert.equal((await f.executions.get(f.auth.invocationId)).status, 'running');
  assert.equal((await f.registry.verify(f.auth.invocationId, f.auth.callbackToken)).ok, true);
  assert.ok((await f.sessions.get(f.session.id)).watcherState.attempt);
});

test('the failing invocation closes its own unbound wake and still reports the original error', async () => {
  const f = await failed();
  const session = await f.sessions.get(f.session.id);
  const state = parseWatcherSessionState(session.watcherState);
  await saveWatcherState(f.sessions, session.id, state, { attempt: { ...state.attempt, phase: 'running' } });
  await assert.rejects(
    runWatcherInvocation(f.owners, { session, source: f.source, service: f.service, quiet: true }),
    /configuration rejected before native admission/,
  );
  assert.equal(f.launches(), 1);
  const execution = await f.executions.get(f.auth.invocationId);
  assert.equal(execution.status, 'failed');
  assert.equal(execution.responseSettlement.kind, 'no_response');
  assert.equal((await f.sessions.get(f.session.id)).watcherState.attempt, undefined);
});

test('automatic native recovery backs off, caps launches across restart, and never relaunches while disabled', async () => {
  const f = await failed({ bound: true });
  const configs = new MemoryConciergeConfigStore();
  await configs.updateWatcherConfig('watcher-owner', 0, { scope: 'all', memberCatId: 'codex' });
  let now = Date.now();
  f.owners.now = () => now;
  const errors = [];
  const options = {
    ...f.owners,
    userId: 'watcher-owner',
    configs,
    labels: { list: async () => [] },
    capability: () => ({ supported: true }),
    service: () => f.service,
    report: (error) => errors.push(error),
  };
  let supervisor = new WatcherSupervisor(options);
  const poll = async () => {
    await supervisor.poll();
    for (let i = 0; i < 40; i++) await setImmediate();
  };
  await supervisor.start();
  try {
    await poll();
    const first = f.launches();
    assert.equal(first, 1);
    for (let i = 0; i < 5; i++) await poll();
    assert.equal(f.launches(), first, 'no every-poll provider relaunch');
    now += 5001;
    await poll();
    assert.equal(f.launches(), 2);
    now += 20001;
    await poll();
    assert.equal(f.launches(), 3);
    now += 120000;
    await poll();
    assert.equal(f.launches(), 3, 'three failures park recovery without inventing a terminal native fact');
    await supervisor.stop();
    supervisor = new WatcherSupervisor(options);
    await supervisor.start();
    await poll();
    assert.equal(f.launches(), 3, 'persisted limit survives supervisor reconstruction');
    await configs.updateWatcherConfig('watcher-owner', 1, { enabled: false });
    await poll();
    assert.equal(f.launches(), 3, 'an explicit stop does not start even a control-only CLI');
    for (let i = 0; i < 5; i++) await poll();
    assert.equal(f.launches(), 3, 'disabled does not restart a failed control probe');
    await configs.updateWatcherConfig(
      'watcher-owner',
      2,
      { enabled: true },
      await f.executions.settledHead('watcher-owner'),
    );
    await poll();
    assert.equal(f.launches(), 4, 'an explicit reopen permits one control-only check of the old native binding');
    for (let i = 0; i < 5; i++) await poll();
    assert.equal(f.launches(), 4);
    assert.equal((await f.executions.get(f.auth.invocationId)).status, 'running');
    assert.equal(parseWatcherSessionState((await f.sessions.get(f.session.id)).watcherState).afterSequence, 0);
    assert.ok(errors.every((error) => error instanceof Error));
  } finally {
    await supervisor.stop();
  }
});
