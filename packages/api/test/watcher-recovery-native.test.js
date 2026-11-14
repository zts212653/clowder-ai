import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { parseWatcherSessionState } from '@cat-cafe/shared';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { WatcherSupervisor } from '../dist/domains/concierge/watcher/WatcherSupervisor.js';
import { watcherInvocationAuthority } from '../dist/domains/concierge/watcher/watcher-authority.js';
import { saveWatcherState } from '../dist/domains/concierge/watcher/watcher-checkpoint.js';
import { runWatcherInvocation } from '../dist/domains/concierge/watcher/watcher-invocation.js';
import { nativeWatcherAvailable, watcherNativeFixture } from './helpers/watcher-native-fixture.js';
import { watcherWorld } from './helpers/watcher-world.js';

test(
  'a capped wake resumes and reads its real native binding without sending another model request',
  { timeout: 40000, skip: !nativeWatcherAvailable },
  async () => {
    const w = await watcherWorld();
    const f = await watcherNativeFixture(w);
    let supervisor;
    try {
      const [first] = await w.work('RAW_INCREMENT_16');
      const session = await f.run(first, AbortSignal.timeout(20000));
      const before = parseWatcherSessionState(session.watcherState);
      const [source] = await w.work('RAW_INCREMENT_17 still owes an observation');
      const run = { session, state: before, prefixTokens: 0, committed: false };
      const { auth } = await watcherInvocationAuthority(f.owners, run, source, []);
      await w.executions.markProviderStarted(auth.invocationId, Date.now());
      await w.executions.recordProviderTeardown(auth.invocationId, Date.now());
      await saveWatcherState(w.sessions, session.id, before, {
        activationCut: '0:0',
        wakeInvocationId: auth.invocationId,
        attempt: {
          invocationId: auth.invocationId,
          sourceInvocationId: source.invocationId,
          sourceSequence: source.settledSequence,
          startedAt: Date.now(),
          phase: 'failed',
          failure: 'watcher_deadline_exceeded',
          recoveryAttempts: 3,
          recoveryRetryAt: Date.now() - 1,
          window: {
            frontier: source.responseSettlement.messageId,
            offset: 860,
            complete: false,
            tokenBudget: 2500,
            messageIds: [source.responseSettlement.messageId],
          },
        },
      });
      const requests = f.requests.length;
      const launches = f.state.nativeLaunchPids.length;
      const configs = new MemoryConciergeConfigStore();
      await configs.updateWatcherConfig(source.userId, 0, { scope: 'all', memberCatId: 'codex' });
      const reports = [];
      let finished = false;
      supervisor = new WatcherSupervisor({
        ...f.owners,
        configs,
        userId: source.userId,
        labels: { list: async () => [] },
        service: () => f.service,
        capability: () => ({ supported: true }),
        report: (error) => reports.push(error),
        run: async (owners, input) => {
          try {
            await runWatcherInvocation(owners, input);
          } finally {
            finished = true;
          }
        },
      });
      await supervisor.start();
      await until(() => finished);
      await supervisor.stop();
      const final = await w.sessions.get(session.id);
      assert.equal(final.cliSessionId, session.cliSessionId);
      assert.equal(final.watcherState.attempt, undefined);
      assert.equal(final.watcherState.wakeInvocationId, undefined);
      assert.equal(final.watcherState.afterSequence, before.afterSequence);
      assert.equal(final.watcherState.consumedThrough, before.consumedThrough);
      assert.equal((await w.executions.get(auth.invocationId)).terminalReason, 'watcher_checkpoint_retry_exhausted');
      assert.equal((await w.registry.verify(auth.invocationId, auth.callbackToken)).ok, false);
      assert.equal(f.requests.length, requests, 'thread resume/read is not a model attempt');
      assert.equal(f.state.nativeLaunchPids.length, launches + 1);
      assert.deepEqual(reports, []);
    } finally {
      await supervisor?.stop();
      await f.close();
    }
  },
);

async function until(check) {
  const deadline = Date.now() + 15000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'native recovery did not finish');
    await delay(10);
  }
}

for (const mode of ['disabled', 'switched']) {
  test(
    `native prune recovers its failed finalization CAS after ${mode} without another model request`,
    { timeout: 40000, skip: !nativeWatcherAvailable },
    async () => {
      const w = await watcherWorld();
      const f = await watcherNativeFixture(w);
      let supervisor;
      try {
        const [source] = await w.work('RAW_INCREMENT_14');
        const save = w.sessions.compareAndSetWatcherState.bind(w.sessions);
        let fail = true;
        w.sessions.compareAndSetWatcherState = async (...args) => {
          if (fail && args[2].attempt?.phase === 'finalize_pending') {
            fail = false;
            throw new Error('fixture_after_native_revert');
          }
          return save(...args);
        };
        await assert.rejects(f.run(source, AbortSignal.timeout(20000)), /fixture_after_native_revert/);
        const session = await w.sessions.getByChainKey(watcherSessionChainKey(source.userId, 'codex', source.threadId));
        assert.equal(session.watcherState.attempt.phase, 'prune_pending');
        const id = session.watcherState.attempt.invocationId;
        const originalAuth = await w.registry.peekRecord(id);
        assert.equal((await w.registry.verify(id, originalAuth.callbackToken)).ok, true);
        const originalRequests = f.requests.length;
        assert.equal(originalRequests, 1);
        const configs = new MemoryConciergeConfigStore();
        await configs.updateWatcherConfig(source.userId, 0, {
          scope: 'all',
          enabled: mode !== 'disabled',
          memberCatId: mode === 'switched' ? 'unsupported-after-switch' : 'codex',
        });
        const reports = [];
        supervisor = new WatcherSupervisor({
          ...f.owners,
          configs,
          userId: source.userId,
          labels: { list: async () => [] },
          service: (catId) => (catId === 'codex' ? f.service : undefined),
          capability: () => ({ supported: true }),
          report: (error) => reports.push(error),
        });
        await supervisor.start();
        if (mode === 'disabled') {
          for (let i = 0; i < 3; i++) {
            await supervisor.poll();
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.equal(
            f.state.nativeLaunchPids.length,
            1,
            'off leaves an unproved prune pending without launching CLI',
          );
          assert.equal((await w.sessions.get(session.id)).watcherState.attempt.phase, 'prune_pending');
          await configs.updateWatcherConfig(source.userId, 1, { enabled: true });
          await supervisor.poll();
        }
        await until(async () => !(await w.sessions.get(session.id)).watcherState.attempt);
        await supervisor.stop();
        const final = await w.sessions.get(session.id);
        assert.equal(final.cliSessionId, session.cliSessionId);
        assert.equal(final.watcherState.notes, 'saved-note-14');
        assert.equal(final.watcherState.afterSequence, source.settledSequence);
        assert.equal((await w.executions.get(id)).status, 'succeeded');
        assert.equal((await w.registry.verify(id, originalAuth.callbackToken)).ok, false);
        assert.equal(f.requests.length, originalRequests);
        assert.equal((await w.executions.listByParent(`watcher-source:codex:${source.invocationId}`)).length, 1);
        assert.deepEqual(reports, []);
      } finally {
        await supervisor?.stop();
        await f.close();
      }
    },
  );
}

test(
  'failure after execution admission but before Session CAS resumes its original execution through native',
  { timeout: 40000, skip: !nativeWatcherAvailable },
  async () => {
    const w = await watcherWorld();
    const f = await watcherNativeFixture(w);
    try {
      const [source] = await w.work('RAW_INCREMENT_15');
      const save = w.sessions.compareAndSetWatcherState.bind(w.sessions);
      let fail = true;
      w.sessions.compareAndSetWatcherState = async (...args) => {
        if (fail && args[2].attempt?.phase === 'running') {
          fail = false;
          throw new Error('fixture_before_attempt_CAS');
        }
        return save(...args);
      };
      await assert.rejects(f.run(source, AbortSignal.timeout(20000)), /fixture_before_attempt_CAS/);
      const parent = `watcher-source:codex:${source.invocationId}`;
      const [original] = await w.executions.listByParent(parent);
      assert.equal(original.status, 'running');
      assert.equal(f.requests.length, 0);
      const recovered = await f.run(source, AbortSignal.timeout(20000));
      const executions = await w.executions.listByParent(parent);
      assert.equal(executions.length, 1);
      assert.equal(executions[0].invocationId, original.invocationId);
      assert.equal(executions[0].status, 'succeeded');
      assert.equal(recovered.watcherState.afterSequence, source.settledSequence);
      assert.equal(f.requests.length, 1);
    } finally {
      await f.close();
    }
  },
);
