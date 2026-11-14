import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WatcherSupervisor } from '../dist/domains/concierge/watcher/WatcherSupervisor.js';
import { runWatcherInvocation } from '../dist/domains/concierge/watcher/watcher-invocation.js';
import { flush, stuck } from './helpers/watcher-surface-fixture.js';

const retire = (f) =>
  runWatcherInvocation(f.owners, {
    session: f.session,
    source: f.source,
    service: f.service,
    quiet: true,
    recoveryOnly: true,
  });

for (const mode of ['backoff', 'exhausted']) {
  test(`Supervisor parks ${mode} retirement when a new natural source reaches drain`, async () => {
    const f = await stuck();
    f.native.error = new Error('fixture native read unavailable');
    for (let count = 0; count < (mode === 'exhausted' ? 3 : 1); count++) {
      await assert.rejects(retire(f), /native read unavailable/);
      if (mode === 'exhausted') f.advance(21000);
    }
    const starts = f.launches();
    await f.w.work('a new natural source must not cause retirement to spin');
    let runs = 0,
      drains = 0;
    const getOrCreate = f.w.sessions.getOrCreateActive.bind(f.w.sessions);
    // Preserve the real store's synchronous method: making it async changes its own reuse semantics.
    f.w.sessions.getOrCreateActive = (...args) => {
      drains++;
      return getOrCreate(...args);
    };
    const supervisor = new WatcherSupervisor({
      ...f.options,
      run: async (...args) => {
        runs++;
        await new Promise((resolve) => setImmediate(resolve));
        // A broken drain must fail the assertion without starving the test runner's event loop.
        if (runs > 12) throw new Error('fixture stops an unbounded retirement drain');
        return runWatcherInvocation(...args);
      },
    });
    try {
      await supervisor.start();
      await flush();
      for (let poll = 0; poll < 4; poll++) {
        const beforeRuns = runs,
          beforeDrains = drains;
        await supervisor.poll();
        await flush();
        assert.ok(
          runs - beforeRuns <= 4,
          `poll ${poll} must park pending retirement; actual runs=${runs - beforeRuns}`,
        );
        assert.ok(drains - beforeDrains <= 2, 'drain must not immediately reschedule itself');
      }
      assert.equal(f.launches(), starts, 'neither backoff nor exhaustion authorizes another native launch');
      assert.equal((await f.w.executions.get(f.auth.invocationId)).status, 'running');
      assert.equal((await f.w.sessions.get(f.session.id)).watcherState.messageOffset, 5);
    } finally {
      await supervisor.stop();
    }
  });
}

test('Supervisor parks an unbound retirement when successor publication keeps failing', async () => {
  const f = await stuck();
  // Seed the never-bound variant; its Host failure can settle before publication fails.
  const original = await f.w.sessions.get(f.session.id);
  delete original.cliSessionId;
  delete original.nativeSessionBinding;
  let publications = 0,
    runs = 0;
  f.w.sessions.rolloverWatcherSession = async () => {
    publications++;
    throw new Error('fixture successor publication unavailable');
  };
  await f.w.work('a new natural source behind the failed retirement');
  const supervisor = new WatcherSupervisor({
    ...f.options,
    run: async (...args) => {
      runs++;
      await new Promise((resolve) => setImmediate(resolve));
      if (runs > 12) throw new Error('fixture stops an unbounded publication retry');
      return runWatcherInvocation(...args);
    },
  });
  try {
    await supervisor.start();
    await flush();
    for (let poll = 0; poll < 4; poll++) {
      const beforeRuns = runs,
        beforePublications = publications;
      await supervisor.poll();
      await flush();
      assert.ok(runs - beforeRuns <= 4, `poll ${poll} must park failed publication; runs=${runs - beforeRuns}`);
      assert.ok(publications - beforePublications <= 4, 'publication must wait for another poll');
    }
    const current = await f.w.sessions.get(f.session.id);
    assert.equal(current.status, 'active');
    assert.equal(current.watcherRetirement.phase, 'idle');
    assert.equal(current.watcherState.attempt, undefined);
    assert.equal(current.watcherState.consumedThrough, f.prior.responseSettlement.messageId);
    assert.equal(current.watcherState.messageOffset, 5);
    const execution = await f.w.executions.get(f.auth.invocationId);
    assert.equal(execution.status, 'failed');
    assert.equal(execution.responseSettlement.kind, 'no_response');
    assert.equal(f.launches(), 0);
    assert.equal(f.turns(), 0);
    assert.ok(f.errors.some((error) => /publication unavailable/.test(error.message)));
    assert.equal(
      f.events.some((e) => ['watcher_checkpoint', 'watcher_window_skipped'].includes(e.type)),
      false,
    );
  } finally {
    await supervisor.stop();
  }
});
