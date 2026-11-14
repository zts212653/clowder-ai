import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { parseWatcherSessionState } from '@cat-cafe/shared';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { WatcherSupervisor } from '../dist/domains/concierge/watcher/WatcherSupervisor.js';
import { watcherInvocationAuthority } from '../dist/domains/concierge/watcher/watcher-authority.js';
import { watcherWorld } from './helpers/watcher-world.js';

async function flush() {
  for (let i = 0; i < 80; i++) await setImmediate();
}

// boot79's saved failure: bound Session, no native turn id, expired reservation,
// three recovery launches, plain deadline, partial window and an unchanged raw cursor.
async function capped(mode = 'absent', entry = 'startup') {
  const w = await watcherWorld();
  const [source] = await w.work('original material remains unread '.repeat(160));
  const session = await w.sessions.getOrCreateActive({
    userId: source.userId,
    threadId: source.threadId,
    catId: 'codex',
    sessionPurpose: 'watcher',
    chainKey: watcherSessionChainKey(source.userId, 'codex', source.threadId),
  });
  const events = [];
  const owners = {
    ...w,
    apiUrl: 'http://127.0.0.1:3102',
    now: () => 1_794_240_800_000,
    maySpeak: async () => false,
    transcript: { appendDurableEvent: async (_session, event) => events.push(event) },
  };
  const run = { session, state: parseWatcherSessionState(undefined), prefixTokens: 0, committed: false };
  const { auth } = await watcherInvocationAuthority(owners, run, source, []);
  const admittedAt = Date.now();
  await w.executions.markProviderStarted(auth.invocationId, admittedAt);
  await w.executions.recordProviderTeardown(auth.invocationId, admittedAt + 1);
  const bound = await w.sessions.bindCliSessionIdIfUnbound(session.id, 'same-native');
  const original = source.responseSettlement.messageId;
  await w.sessions.compareAndSetWatcherState(session.id, 0, {
    revision: 1,
    afterSequence: 0,
    notes: 'prior checkpoint',
    activationCut: '0:0',
    consumedThrough: original,
    messageOffset: 1240,
    wakeInvocationId: auth.invocationId,
    attempt: {
      invocationId: auth.invocationId,
      sourceInvocationId: source.invocationId,
      sourceSequence: source.settledSequence,
      startedAt: 1_794_230_641_445,
      recoveryAttempts: 3,
      recoveryRetryAt: 1_794_230_944_159,
      phase: 'failed',
      failure: 'watcher_deadline_exceeded',
      window: { frontier: original, tokenBudget: 2500, offset: 860, complete: false, messageIds: [original] },
    },
  });
  const configs = new MemoryConciergeConfigStore();
  await configs.updateWatcherConfig(source.userId, 0, {
    scope: 'all',
    memberCatId: 'codex',
    enabled: mode !== 'disabled',
  });
  await configs.initializeWatcherCursor(source.userId, 0);
  const calls = [];
  const probeStates = [];
  let launches = 0,
    modelTurns = 0;
  const service = {
    boundedWatcherSessionCapability: () => ({ supported: true }),
    async *invoke(_prompt, options) {
      launches++;
      const proceed = await options.boundedWatcher.beforeTurn({
        threadId: bound.cliSessionId,
        client: {
          async request(method) {
            calls.push(method);
            if (mode === 'read-failed') throw new Error('fixture native history read failed');
            if (method === 'thread/revert') return {};
            if (mode === 'unknown') return { thread: { id: bound.cliSessionId } };
            const turns =
              mode === 'absent' || mode === 'disabled'
                ? []
                : [
                    {
                      id: 'owned-turn',
                      status: mode === 'active' ? 'inProgress' : 'interrupted',
                      items: [{ type: 'userMessage', text: `watcherAttemptId=${auth.invocationId}` }],
                    },
                  ];
            return { thread: { id: bound.cliSessionId, turns } };
          },
        },
      });
      probeStates.push((await w.sessions.get(session.id)).watcherState);
      if (proceed) {
        modelTurns++;
        throw new Error('an exhausted wake cannot admit another model turn');
      }
    },
  };
  if (entry === 'ordinary-drain') {
    w.sessions.listPendingWatcherSessions = async () => [];
    w.executions.listRunningByUser = async () => [];
    w.executions.listResponsePending = async () => [];
  }
  const errors = [];
  const options = {
    ...owners,
    configs,
    userId: source.userId,
    labels: { list: async () => [] },
    service: () => service,
    capability: () => ({ supported: true }),
    report: (error) => errors.push(error),
  };
  return {
    ...w,
    source,
    session: bound,
    auth,
    events,
    calls,
    probeStates,
    configs,
    errors,
    options,
    launches: () => launches,
    modelTurns: () => modelTurns,
  };
}

for (const entry of ['startup', 'ordinary-drain'])
  for (const mode of ['absent', 'interrupted'])
    test(`exhausted ${entry} recovery settles only after exact native ${mode} proof, without a model retry`, async () => {
      const f = await capped(mode, entry);
      const supervisor = new WatcherSupervisor(f.options);
      await supervisor.start();
      try {
        await supervisor.poll();
        await flush();
        const row = await f.executions.get(f.auth.invocationId);
        assert.equal(row.status, 'failed', 'the capped wake still owes native-only finalization');
        assert.equal(row.terminalReason, 'watcher_checkpoint_retry_exhausted');
        assert.equal(row.responseSettlement.kind, 'no_response');
        assert.equal((await f.registry.verify(f.auth.invocationId, f.auth.callbackToken)).ok, false);
        const state = (await f.sessions.get(f.session.id)).watcherState;
        assert.equal(state.attempt, undefined);
        assert.equal(state.wakeInvocationId, undefined);
        assert.equal(f.probeStates[0].afterSequence, 0, 'native finalization does not acknowledge source input');
        assert.equal(state.consumedThrough, f.source.responseSettlement.messageId);
        assert.equal(state.messageOffset, 1240, 'settlement does not acknowledge the unread partial window');
        assert.equal(state.notes, 'prior checkpoint');
        assert.equal(f.launches(), 1);
        assert.equal(f.modelTurns(), 0);
        assert.equal(f.calls.includes('thread/revert'), mode === 'interrupted');
        assert.equal(
          f.events.some((event) => /watcher_checkpoint|watcher_window_skipped/.test(event.type)),
          false,
        );
        assert.equal((await f.executions.get(f.source.invocationId)).status, 'succeeded');
        for (let i = 0; i < 4; i++) {
          await supervisor.poll();
          await flush();
        }
        assert.equal(f.launches(), 1, 'a settled source cannot wake again');
        assert.deepEqual(f.errors, []);
      } finally {
        await supervisor.stop();
      }
    });

for (const mode of ['active', 'unknown', 'read-failed', 'disabled'])
  test(`exhausted recovery preserves pending ownership for ${mode} and its probe limit survives restart`, async () => {
    const f = await capped(mode);
    let supervisor = new WatcherSupervisor(f.options);
    await supervisor.start();
    try {
      for (let i = 0; i < 4; i++) {
        await supervisor.poll();
        await flush();
      }
      const state = (await f.sessions.get(f.session.id)).watcherState;
      assert.equal(f.launches(), mode === 'disabled' ? 0 : 1, 'one terminal probe, never one per poll');
      assert.equal(f.modelTurns(), 0);
      assert.equal(state.attempt.recoveryAttempts, 3, 'terminal probes do not reset or replenish model recovery');
      assert.equal(state.attempt.invocationId, f.auth.invocationId);
      assert.equal(state.afterSequence, 0);
      assert.equal(state.messageOffset, 1240);
      assert.equal((await f.executions.get(f.auth.invocationId)).status, 'running');
      assert.equal((await f.registry.verify(f.auth.invocationId, f.auth.callbackToken)).ok, true);
      assert.equal(f.calls.includes('thread/revert'), false);
      assert.equal(
        f.events.some((event) => event.type === 'watcher_window_skipped'),
        false,
      );
      await supervisor.stop();
      supervisor = new WatcherSupervisor(f.options);
      await supervisor.start();
      await supervisor.poll();
      await flush();
      assert.equal(f.launches(), mode === 'disabled' ? 0 : 1, 'the reservation is durable across reconstruction');
    } finally {
      await supervisor.stop();
    }
  });
