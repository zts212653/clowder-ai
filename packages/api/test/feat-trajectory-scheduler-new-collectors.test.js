/**
 * F233 — FeatTrajectoryCollectorScheduler: ThreadSplit + CrossPost wiring tests
 *
 * Split from feat-trajectory-collector-scheduler.test.js (P2: 497 lines > 350 limit).
 * Tests the scheduler's optional ThreadSplitCollector / CrossPostCollector paths.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('FeatTrajectoryCollectorScheduler — new collectors', () => {
  function makeSnap(featId = 'F188', branchName = 'fix/f188-x') {
    return {
      branchName,
      headCommitSha: 'abc1234',
      headCommitAt: 1_700_000_000_000,
      prNumber: null,
      prState: null,
      mergedToMain: null,
      prOpenedAt: null,
      prMergedAt: null,
      authorIdentity: 'opus-47',
      featureCandidates: [featId],
      associatedThreadIds: [],
      lastThreadMessageAt: null,
      lastThreadActivityAt: null,
      joinProvenance: { confidence: 'high', joinedVia: ['branch_name_F#'] },
    };
  }

  test('tick() calls threadSplitCollector when provided', async () => {
    const { FeatTrajectoryCollectorScheduler } = await import(
      '../dist/domains/feat-trajectory/FeatTrajectoryCollectorScheduler.js'
    );
    const { FeatTrajectoryProjector } = await import('../dist/domains/feat-trajectory/FeatTrajectoryProjector.js');
    const { InMemoryFeatTrajectoryStore } = await import('../dist/domains/feat-trajectory/FeatTrajectoryStore.js');

    const store = new InMemoryFeatTrajectoryStore();
    const projector = new FeatTrajectoryProjector(store);
    const gitCollector = {
      async collectAll() {
        return [];
      },
    };
    const threadSplitCollector = {
      async collectAll() {
        return [
          {
            kind: 'thread_split',
            proposalId: 'prop_001',
            parentThreadId: 't_parent',
            childThreadId: 't_child',
            featId: 'F252',
            splitAt: 1719360060000,
            catId: 'opus',
          },
        ];
      },
    };

    const scheduler = new FeatTrajectoryCollectorScheduler({
      collector: gitCollector,
      projector,
      store,
      threadSplitCollector,
    });
    const result = await scheduler.tick();
    assert.strictEqual(result.applied, 1);
    const proj = await store.get('F252');
    assert.ok(proj);
    assert.equal(proj.entries[0].kind, 'thread_split');
  });

  test('tick() calls crossPostCollector when provided', async () => {
    const { FeatTrajectoryCollectorScheduler } = await import(
      '../dist/domains/feat-trajectory/FeatTrajectoryCollectorScheduler.js'
    );
    const { FeatTrajectoryProjector } = await import('../dist/domains/feat-trajectory/FeatTrajectoryProjector.js');
    const { InMemoryFeatTrajectoryStore } = await import('../dist/domains/feat-trajectory/FeatTrajectoryStore.js');

    const store = new InMemoryFeatTrajectoryStore();
    const projector = new FeatTrajectoryProjector(store);
    const gitCollector = {
      async collectAll() {
        return [];
      },
    };
    const crossPostCollector = {
      async collectAll() {
        return [
          {
            kind: 'thread_merge',
            messageId: 'msg_001',
            sourceThreadId: 't_source',
            targetThreadId: 't_target',
            catId: 'opus',
            featId: 'F252',
            postedAt: 1719360099000,
          },
        ];
      },
    };

    const scheduler = new FeatTrajectoryCollectorScheduler({
      collector: gitCollector,
      projector,
      store,
      crossPostCollector,
    });
    const result = await scheduler.tick();
    assert.strictEqual(result.applied, 1);
    const proj = await store.get('F252');
    assert.ok(proj);
    assert.equal(proj.entries[0].kind, 'thread_merge');
  });

  test('tick() runs all three collectors together', async () => {
    const { FeatTrajectoryCollectorScheduler } = await import(
      '../dist/domains/feat-trajectory/FeatTrajectoryCollectorScheduler.js'
    );
    const { FeatTrajectoryProjector } = await import('../dist/domains/feat-trajectory/FeatTrajectoryProjector.js');
    const { InMemoryFeatTrajectoryStore } = await import('../dist/domains/feat-trajectory/FeatTrajectoryStore.js');

    const store = new InMemoryFeatTrajectoryStore();
    const projector = new FeatTrajectoryProjector(store);
    const gitCollector = {
      async collectAll() {
        return [makeSnap('F188')];
      },
    };
    const threadSplitCollector = {
      async collectAll() {
        return [
          {
            kind: 'thread_split',
            proposalId: 'prop_a',
            parentThreadId: 't_p',
            childThreadId: 't_c',
            featId: 'F252',
            splitAt: 1719360060000,
            catId: 'opus',
          },
        ];
      },
    };
    const crossPostCollector = {
      async collectAll() {
        return [
          {
            kind: 'thread_merge',
            messageId: 'msg_a',
            sourceThreadId: 't_s',
            targetThreadId: 't_t',
            catId: 'sonnet',
            featId: 'F252',
            postedAt: 1719360099000,
          },
        ];
      },
    };

    const scheduler = new FeatTrajectoryCollectorScheduler({
      collector: gitCollector,
      projector,
      store,
      threadSplitCollector,
      crossPostCollector,
    });
    const result = await scheduler.tick();
    // git collector: 1 snapshot → 2 entries (branch_pushed + stale)
    // thread split: 1
    // cross-post: 1
    assert.ok(result.applied >= 3, `expected >=3 applied, got ${result.applied}`);
    assert.strictEqual(result.featsInStore, 2); // F188 + F252
  });

  test('git collector error does not block split/merge collectors (cloud R1 P2)', async () => {
    const { FeatTrajectoryCollectorScheduler } = await import(
      '../dist/domains/feat-trajectory/FeatTrajectoryCollectorScheduler.js'
    );
    const { FeatTrajectoryProjector } = await import('../dist/domains/feat-trajectory/FeatTrajectoryProjector.js');
    const { InMemoryFeatTrajectoryStore } = await import('../dist/domains/feat-trajectory/FeatTrajectoryStore.js');

    const store = new InMemoryFeatTrajectoryStore();
    const projector = new FeatTrajectoryProjector(store);
    const gitCollector = {
      async collectAll() {
        throw new Error('gh auth rate limited');
      },
    };
    const threadSplitCollector = {
      async collectAll() {
        return [
          {
            kind: 'thread_split',
            proposalId: 'prop_git_fail',
            parentThreadId: 't_p',
            childThreadId: 't_c',
            featId: 'F252',
            splitAt: 1719360060000,
            catId: 'opus',
          },
        ];
      },
    };
    const crossPostCollector = {
      async collectAll() {
        return [
          {
            kind: 'thread_merge',
            messageId: 'msg_git_fail',
            sourceThreadId: 't_s',
            targetThreadId: 't_t',
            catId: 'sonnet',
            featId: 'F252',
            postedAt: 1719360099000,
          },
        ];
      },
    };
    const logs = [];
    const scheduler = new FeatTrajectoryCollectorScheduler({
      collector: gitCollector,
      projector,
      store,
      threadSplitCollector,
      crossPostCollector,
      logger: {
        info: (obj, msg) => logs.push({ level: 'info', msg }),
        warn: (obj, msg) => logs.push({ level: 'warn', msg }),
        error: (obj, msg) => logs.push({ level: 'error', msg }),
      },
    });
    const result = await scheduler.tick();
    // Git collector failed, but split + merge should still be applied
    assert.strictEqual(result.applied, 2, 'split + merge should apply despite git failure');
    assert.ok(logs.some((l) => l.level === 'error' && String(l.msg).includes('collector.collectAll failed')));
    const proj = await store.get('F252');
    assert.ok(proj, 'F252 projection should exist from split/merge entries');
  });

  test('git collector failure skips setLastCollectorTickAt (cloud R3 P2)', async () => {
    const { FeatTrajectoryCollectorScheduler } = await import(
      '../dist/domains/feat-trajectory/FeatTrajectoryCollectorScheduler.js'
    );
    const { FeatTrajectoryProjector } = await import('../dist/domains/feat-trajectory/FeatTrajectoryProjector.js');
    const { InMemoryFeatTrajectoryStore } = await import('../dist/domains/feat-trajectory/FeatTrajectoryStore.js');

    const store = new InMemoryFeatTrajectoryStore();
    const projector = new FeatTrajectoryProjector(store);

    // Spy on setLastCollectorTickAt to verify it's NOT called
    let tickAtCalled = false;
    const origSetLast = store.setLastCollectorTickAt.bind(store);
    store.setLastCollectorTickAt = async (now) => {
      tickAtCalled = true;
      return origSetLast(now);
    };

    const gitCollector = {
      async collectAll() {
        throw new Error('GitHub API rate limited');
      },
    };
    const threadSplitCollector = {
      async collectAll() {
        return [
          {
            kind: 'thread_split',
            proposalId: 'prop_r3',
            parentThreadId: 't_p',
            childThreadId: 't_c',
            featId: 'F252',
            splitAt: 1719360060000,
            catId: 'opus',
          },
        ];
      },
    };
    const scheduler = new FeatTrajectoryCollectorScheduler({
      collector: gitCollector,
      projector,
      store,
      threadSplitCollector,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const result = await scheduler.tick();
    // Split collector should still succeed
    assert.strictEqual(result.applied, 1);
    // But freshness should NOT be recorded since git source failed
    assert.strictEqual(tickAtCalled, false, 'setLastCollectorTickAt should NOT be called when git collector fails');
  });

  test('new collector error does not block other collectors', async () => {
    const { FeatTrajectoryCollectorScheduler } = await import(
      '../dist/domains/feat-trajectory/FeatTrajectoryCollectorScheduler.js'
    );
    const { FeatTrajectoryProjector } = await import('../dist/domains/feat-trajectory/FeatTrajectoryProjector.js');
    const { InMemoryFeatTrajectoryStore } = await import('../dist/domains/feat-trajectory/FeatTrajectoryStore.js');

    const store = new InMemoryFeatTrajectoryStore();
    const projector = new FeatTrajectoryProjector(store);
    const gitCollector = {
      async collectAll() {
        return [];
      },
    };
    const threadSplitCollector = {
      async collectAll() {
        throw new Error('proposal store unreachable');
      },
    };
    const crossPostCollector = {
      async collectAll() {
        return [
          {
            kind: 'thread_merge',
            messageId: 'msg_ok',
            sourceThreadId: 't_s',
            targetThreadId: 't_t',
            catId: 'opus',
            featId: 'F252',
            postedAt: 1719360099000,
          },
        ];
      },
    };
    const logs = [];
    const scheduler = new FeatTrajectoryCollectorScheduler({
      collector: gitCollector,
      projector,
      store,
      threadSplitCollector,
      crossPostCollector,
      logger: {
        info: (obj, msg) => logs.push({ level: 'info', msg }),
        warn: (obj, msg) => logs.push({ level: 'warn', msg }),
        error: (obj, msg) => logs.push({ level: 'error', msg }),
      },
    });
    const result = await scheduler.tick();
    // cross-post should still work despite thread split collector error
    assert.strictEqual(result.applied, 1);
    assert.ok(logs.some((l) => l.level === 'error' && String(l.msg).includes('threadSplitCollector')));
  });
});
