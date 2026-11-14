import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watcherWindow } from '../dist/domains/concierge/watcher/context/watcher-window.js';
import {
  ensureWatcherRetirement,
  reserveWatcherRetirement,
} from '../dist/domains/concierge/watcher/retirement/watcher-retirement-state.js';
import { WatcherSupervisor } from '../dist/domains/concierge/watcher/WatcherSupervisor.js';
import { runWatcherInvocation } from '../dist/domains/concierge/watcher/watcher-invocation.js';
import { flush, PIN, stuck } from './helpers/watcher-surface-fixture.js';

test('a spent legacy surface-change wake can reach safe settlement without another model attempt or control toggle', async () => {
  const f = await stuck();
  const supervisor = new WatcherSupervisor(f.options);
  await supervisor.start();
  try {
    for (let i = 0; i < 3; i++) {
      await supervisor.poll();
      await flush();
    }
    const record = await f.w.executions.get(f.auth.invocationId);
    assert.equal(record.status, 'failed', 'the real pre-provider failure must not strand every later source');
    assert.equal(record.responseSettlement.kind, 'no_response');
    assert.equal(f.turns(), 0);
    const old = await f.w.sessions.get(f.session.id);
    assert.equal(old.watcherState.toolSchemaHash, PIN, 'the old native contract is never silently repinned');
    assert.equal(old.watcherState.notes, 'durable prior notes');
    assert.equal(old.watcherState.consumedThrough, f.prior.responseSettlement.messageId);
    assert.equal(
      f.events.some((e) => ['watcher_checkpoint', 'watcher_window_skipped'].includes(e.type)),
      false,
    );
    assert.equal((await f.w.registry.verify(f.auth.invocationId, f.auth.callbackToken)).ok, false);
  } finally {
    await supervisor.stop();
  }
});

test('a changed tool pin does not preempt the native-only exact idle proof', async () => {
  const f = await stuck();
  await runWatcherInvocation(f.owners, {
    session: f.session,
    source: f.source,
    service: f.service,
    quiet: true,
    recoveryOnly: true,
  });
  assert.equal(f.turns(), 0);
  assert.notEqual((await f.w.executions.get(f.auth.invocationId)).status, 'running');
  assert.equal((await f.w.sessions.get(f.session.id)).watcherState.toolSchemaHash, PIN);
});

const retire = (f) =>
  runWatcherInvocation(f.owners, {
    session: f.session,
    source: f.source,
    service: f.service,
    quiet: true,
    recoveryOnly: true,
  });

test('a stale retirement snapshot cannot reserve another control launch without consuming another ticket', async () => {
  const f = await stuck();
  const initialized = await ensureWatcherRetirement(f.owners, f.session);
  const stale = structuredClone(initialized);
  const first = await reserveWatcherRetirement(f.owners, initialized, Date.now());
  assert.equal(first.watcherRetirement.probes, 1);
  await assert.rejects(reserveWatcherRetirement(f.owners, stale, Date.now() + 21000), /watcher_session_changed/);
  assert.equal((await f.w.sessions.get(f.session.id)).watcherRetirement.probes, 1);
});

for (const mode of [
  'active',
  'unknown',
  'foreign-tail',
  'missing-target',
  'read-failure',
  'malformed',
  'wrong-thread',
]) {
  test(`${mode} cannot authorize native revert, retirement or acknowledging unread text`, async () => {
    const f = await stuck();
    const before = (await f.w.sessions.get(f.session.id)).watcherState;
    const owned = { id: 'owned', status: 'interrupted', items: [{ text: `watcherAttemptId=${f.auth.invocationId}` }] };
    f.native.turns = [owned];
    if (mode === 'active') owned.status = 'inProgress';
    if (mode === 'unknown') owned.status = 'unknown';
    if (mode === 'foreign-tail') f.native.turns.push({ id: 'foreign', status: 'completed', items: [] });
    if (mode === 'missing-target') {
      await f.w.sessions.compareAndSetWatcherState(f.session.id, before.revision, {
        ...before,
        revision: before.revision + 1,
        attempt: { ...before.attempt, nativeTurnId: 'missing' },
      });
      f.native.turns = [{ id: 'other', status: 'completed', items: [] }];
    }
    if (mode === 'read-failure') f.native.error = new Error('fixture thread/read 404 is not empty history');
    if (mode === 'malformed') f.native.response = { thread: { id: 'old-native', turns: [null] } };
    if (mode === 'wrong-thread') f.native.response = { thread: { id: 'foreign-native', turns: [] } };
    await assert.rejects(retire(f));
    const after = await f.w.sessions.get(f.session.id);
    assert.equal(after.status, 'active');
    assert.equal(after.watcherState.notes, before.notes);
    assert.equal(after.watcherState.consumedThrough, before.consumedThrough);
    assert.equal(after.watcherState.messageOffset, before.messageOffset);
    assert.equal(after.watcherState.attempt.recoveryAttempts, 3);
    assert.equal(after.watcherState.attempt.recoveryControlKey, before.attempt.recoveryControlKey);
    assert.equal(after.watcherState.attempt.failure, 'watcher_native_tool_surface_changed');
    assert.equal(after.watcherRetirement.probes, 1);
    assert.equal(f.calls.includes('thread/revert'), false);
    assert.equal(f.turns(), 0);
    assert.equal((await f.w.executions.get(f.auth.invocationId)).status, 'running');
    assert.equal((await f.w.registry.verify(f.auth.invocationId, f.auth.callbackToken)).ok, true);
  });
}

test('retirement probes retain their three-attempt budget and backoff across Supervisor reconstruction', async () => {
  const f = await stuck();
  f.native.error = new Error('fixture read unavailable');
  for (let i = 0; i < 5; i++) {
    const supervisor = new WatcherSupervisor(f.options);
    await supervisor.start();
    await flush();
    await supervisor.stop();
    f.advance(21000);
  }
  assert.equal(f.launches(), 3);
  assert.equal(f.turns(), 0);
  const current = await f.w.sessions.get(f.session.id);
  assert.equal(current.watcherRetirement.probes, 3);
  assert.match(current.watcherRetirement.lastFailure, /read unavailable/);
  assert.equal(current.watcherState.attempt.recoveryAttempts, 3);
  assert.equal((await f.w.sessions.listPendingWatcherSessions(f.source.userId))[0].id, f.session.id);
});

test('disabled stops even the new retirement control path without modifying the old key or cursor', async () => {
  const f = await stuck();
  await f.options.configs.updateWatcherConfig(f.source.userId, 1, { enabled: false });
  const supervisor = new WatcherSupervisor(f.options);
  await supervisor.start();
  await supervisor.poll();
  await flush();
  await supervisor.stop();
  assert.equal(f.launches(), 0);
  assert.equal((await f.w.sessions.get(f.session.id)).watcherRetirement, undefined);
  assert.equal((await f.w.executions.get(f.auth.invocationId)).status, 'running');
});

test('a close admitted during retirement cancels the control probe before any history mutation or rollover', async () => {
  const f = await stuck();
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  let entered = false;
  const service = {
    ...f.service,
    async *invoke(prompt, options) {
      entered = true;
      await barrier;
      options.signal.throwIfAborted();
      yield* f.service.invoke(prompt, options);
    },
  };
  const supervisor = new WatcherSupervisor({ ...f.options, service: () => service });
  await supervisor.start();
  await flush();
  assert.equal(entered, true);
  await f.options.configs.updateWatcherConfig(f.source.userId, 1, { enabled: false });
  supervisor.controlChanged();
  await flush();
  release();
  await flush();
  await supervisor.stop();
  assert.deepEqual(f.calls, []);
  const old = await f.w.sessions.get(f.session.id);
  assert.equal(old.status, 'active');
  assert.equal(old.watcherRetirement.phase, 'pending');
  assert.equal(old.watcherRetirement.lastFailure, 'watcher_disabled');
  assert.equal(old.watcherState.messageOffset, 5);
  assert.equal((await f.w.executions.get(f.auth.invocationId)).status, 'running');
});

for (const cut of ['after-revert', 'after-host-settlement', 'after-rollover']) {
  test(`a crash ${cut} resumes the same retirement without duplicate successor or lost unread`, async () => {
    const f = await stuck();
    f.native.turns = [
      { id: 'owned', status: 'interrupted', items: [{ text: `watcherAttemptId=${f.auth.invocationId}` }] },
    ];
    let once = true;
    const transition = f.w.executions.transitionTerminal.bind(f.w.executions);
    const rollover = f.w.sessions.rolloverWatcherSession.bind(f.w.sessions);
    if (cut === 'after-revert')
      f.w.executions.transitionTerminal = async (...args) => {
        if (once) {
          once = false;
          throw new Error('fixture power loss after revert');
        }
        return transition(...args);
      };
    else
      f.w.sessions.rolloverWatcherSession = async (...args) => {
        const result = cut === 'after-rollover' ? await rollover(...args) : undefined;
        if (once) {
          once = false;
          throw new Error(`fixture power loss ${cut}`);
        }
        return result ?? rollover(...args);
      };
    await assert.rejects(retire(f), /fixture power loss/);
    const interrupted = await f.w.sessions.get(f.session.id);
    if (cut !== 'after-rollover') {
      assert.ok((await f.w.sessions.listPendingWatcherSessions(f.source.userId)).some((s) => s.id === f.session.id));
      if (cut === 'after-host-settlement') {
        assert.equal(interrupted.watcherState.attempt, undefined);
        assert.equal((await f.w.executions.get(f.auth.invocationId)).status, 'failed');
      }
    }
    f.advance(21000);
    await retire(f);
    const old = await f.w.sessions.get(f.session.id);
    const successor = await f.w.sessions.getByChainKey(f.session.chainKey);
    assert.equal(old.status, 'sealed');
    assert.equal(old.watcherRetirement.successorSessionId, successor.id);
    assert.equal(successor.watcherState.consumedThrough, f.prior.responseSettlement.messageId);
    assert.equal(successor.watcherState.messageOffset, 5);
    assert.equal(f.calls.filter((c) => c === 'thread/revert').length, 1);
    assert.equal(f.turns(), 0);
    assert.equal((await f.w.sessions.getChain('codex', f.source.threadId, f.source.userId)).length, 2);
  });
}

test('retirement drains an already-settled next ordinary source without a new message or activation reset', async () => {
  const f = await stuck();
  const [next] = await f.w.work('already settled source5556');
  const observed = [];
  const supervisor = new WatcherSupervisor({
    ...f.options,
    run: async (owners, input) => {
      if (input.source.invocationId === f.source.invocationId) return runWatcherInvocation(owners, input);
      const raw = await watcherWindow(owners.messages, input.source, input.session.watcherState, '', [], input.signal);
      observed.push({ id: input.source.invocationId, raw, session: input.session });
      throw new Error('fixture stops at the next real unread admission');
    },
  });
  await supervisor.start();
  await flush();
  await supervisor.stop();
  assert.equal(observed.length, 1);
  assert.equal(observed[0].id, next.invocationId);
  assert.ok(observed[0].raw.body.includes(f.source.responseSettlement.messageId));
  assert.ok(observed[0].raw.body.includes(next.responseSettlement.messageId));
  assert.equal(observed[0].session.watcherState.activationCut, '0:0');
  assert.equal(observed[0].session.watcherState.messageOffset, 5);
});

test('a genuine final checkpoint follows its original commit/prune rule instead of becoming a schema failure', async () => {
  const f = await stuck();
  const current = await f.w.sessions.get(f.session.id);
  const window = { ...current.watcherState.attempt.window, complete: true, offset: 0 };
  await f.w.sessions.compareAndSetWatcherState(f.session.id, current.watcherState.revision, {
    ...current.watcherState,
    revision: current.watcherState.revision + 1,
    attempt: { ...current.watcherState.attempt, nativeTurnId: 'owned', window },
  });
  f.native.turns = [
    {
      id: 'owned',
      status: 'completed',
      items: [
        {
          type: 'agentMessage',
          phase: 'final',
          text: JSON.stringify({
            v: 1,
            notes: 'actual native checkpoint notes',
            consumedThrough: `${window.frontier}:0`,
            outcome: 'quiet',
          }),
        },
      ],
    },
  ];
  await retire(f);
  const old = await f.w.sessions.get(f.session.id);
  assert.equal((await f.w.executions.get(f.auth.invocationId)).terminalReason, 'watcher_checkpoint_committed');
  assert.equal(old.watcherState.notes, 'actual native checkpoint notes');
  assert.equal(old.watcherState.consumedThrough, f.source.responseSettlement.messageId);
  assert.equal(f.events.filter((e) => e.type === 'watcher_checkpoint').length, 1);
  assert.equal(f.events.filter((e) => e.type === 'watcher_window_skipped').length, 0);
});
