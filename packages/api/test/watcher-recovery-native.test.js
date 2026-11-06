import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { WatcherSupervisor } from '../dist/domains/concierge/watcher/WatcherSupervisor.js';
import { nativeWatcherAvailable, watcherNativeFixture } from './helpers/watcher-native-fixture.js';
import { watcherWorld } from './helpers/watcher-world.js';

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
