/**
 * F233 Phase C C2c — runBackfill main flow tests
 *
 * Stub deps (collector returns canned snapshots; projector + store are real
 * in-memory impls) to verify backfill orchestration without spawning Redis,
 * git, or gh.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('runBackfill', () => {
  async function buildHarness({ snapshots = [] } = {}) {
    const { runBackfill } = await import('../dist/domains/feat-trajectory/FeatTrajectoryBackfill.js');
    const { FeatTrajectoryProjector } = await import('../dist/domains/feat-trajectory/FeatTrajectoryProjector.js');
    const { InMemoryFeatTrajectoryStore } = await import('../dist/domains/feat-trajectory/FeatTrajectoryStore.js');

    const store = new InMemoryFeatTrajectoryStore();
    const projector = new FeatTrajectoryProjector(store);
    const collector = {
      async collectAll() {
        return snapshots;
      },
    };
    const logs = [];
    return { runBackfill, collector, projector, store, logs };
  }

  function makeSnapshot(overrides = {}) {
    return {
      branchName: 'fix/f188-phase-k',
      headCommitSha: 'abc1234',
      headCommitAt: 1_700_000_000_000,
      prNumber: null,
      prState: null,
      mergedToMain: null,
      prOpenedAt: null,
      prMergedAt: null,
      authorIdentity: 'opus-47',
      featureCandidates: ['F188'],
      associatedThreadIds: [],
      lastThreadMessageAt: null,
      lastThreadActivityAt: null,
      joinProvenance: { confidence: 'high', joinedVia: ['branch_name_F#'] },
      collectedAt: 1_700_000_000_000 + 10 * 24 * 60 * 60 * 1000, // 10 days later
      ...overrides,
    };
  }

  test('empty snapshots → 0 collected, 0 applied, empty store', async () => {
    const { runBackfill, collector, projector, store, logs } = await buildHarness({ snapshots: [] });
    const result = await runBackfill({
      collector,
      projector,
      store,
      logger: (m) => logs.push(m),
    });
    assert.strictEqual(result.snapshotsCollected, 0);
    assert.strictEqual(result.snapshotsApplied, 0);
    assert.deepStrictEqual(result.featsInStore, []);
    assert.deepStrictEqual(result.perFeatSummary, []);
    assert.ok(logs.some((l) => l.includes('0 snapshots collected')));
  });

  test('F188 fixture snapshot → applied + stored + summary has F188', async () => {
    const { runBackfill, collector, projector, store, logs } = await buildHarness({
      snapshots: [makeSnapshot()],
    });
    const result = await runBackfill({
      collector,
      projector,
      store,
      logger: (m) => logs.push(m),
    });
    assert.strictEqual(result.snapshotsCollected, 1);
    assert.strictEqual(result.snapshotsApplied, 1);
    assert.deepStrictEqual(result.featsInStore, ['F188']);
    assert.strictEqual(result.perFeatSummary.length, 1);
    assert.strictEqual(result.perFeatSummary[0].featId, 'F188');
    // F188 fixture: branch_pushed + branch_stale_unmerged (10d → 7d bucket)
    assert.ok(result.perFeatSummary[0].countsByKind.branch_pushed >= 1);
    assert.ok(result.perFeatSummary[0].countsByKind.branch_stale_unmerged >= 1);
  });

  test('multiple feats → numeric sort in featsInStore', async () => {
    const { runBackfill, collector, projector, store } = await buildHarness({
      snapshots: [
        makeSnapshot({ branchName: 'fix/f999-x', featureCandidates: ['F999'] }),
        makeSnapshot({ branchName: 'fix/f188-y', featureCandidates: ['F188'] }),
        makeSnapshot({ branchName: 'fix/f100-z', featureCandidates: ['F100'] }),
      ],
    });
    const result = await runBackfill({ collector, projector, store });
    assert.deepStrictEqual(result.featsInStore, ['F100', 'F188', 'F999']);
  });

  test('snapshot apply error → skip + continue with remaining', async () => {
    const { runBackfill, collector, projector, store, logs } = await buildHarness({
      snapshots: [
        makeSnapshot({ featureCandidates: ['F188'] }),
        // Bad snapshot: pr_opened kind requires prNumber, but absent here while opened set
        makeSnapshot({
          branchName: 'fix/f200-broken',
          featureCandidates: ['F200'],
          prOpenedAt: 1_700_000_000_000 + 60_000,
          prNumber: null, // contract violation: pr_opened needs prNumber
        }),
        makeSnapshot({ branchName: 'fix/f300-ok', featureCandidates: ['F300'] }),
      ],
    });
    const result = await runBackfill({
      collector,
      projector,
      store,
      logger: (m) => logs.push(m),
    });
    assert.strictEqual(result.snapshotsCollected, 3);
    assert.strictEqual(result.snapshotsApplied, 2, 'F200 broken snapshot skipped, F188 + F300 applied');
    assert.ok(result.featsInStore.includes('F188'));
    assert.ok(result.featsInStore.includes('F300'));
    assert.ok(!result.featsInStore.includes('F200'), 'broken snapshot did not store F200');
    assert.ok(logs.some((l) => l.includes('skip snapshot for fix/f200-broken')));
  });

  test('uses provided now() for deterministic tick', async () => {
    const { runBackfill, collector, projector, store, logs } = await buildHarness();
    const fixedNow = () => 1_900_000_000_000;
    await runBackfill({
      collector,
      projector,
      store,
      now: fixedNow,
      logger: (m) => logs.push(m),
    });
    // 1_900_000_000_000 ms ≈ 2030-03 (Date.toISOString)
    assert.ok(
      logs.some((l) => l.includes('2030-03')),
      `fixed now timestamp reflected in log (logs: ${logs.join(' | ')})`,
    );
  });

  test('logger optional — runs silently if not provided', async () => {
    const { runBackfill, collector, projector, store } = await buildHarness({
      snapshots: [makeSnapshot()],
    });
    // Should not throw even without logger
    const result = await runBackfill({ collector, projector, store });
    assert.strictEqual(result.snapshotsApplied, 1);
  });

  test('idempotency: running backfill twice does not double counts (cloud P2 stable id)', async () => {
    const { runBackfill, collector, projector, store } = await buildHarness({
      snapshots: [makeSnapshot()],
    });
    const first = await runBackfill({ collector, projector, store });
    const second = await runBackfill({ collector, projector, store });
    assert.strictEqual(first.perFeatSummary[0].countsByKind.branch_pushed, 1);
    assert.strictEqual(
      second.perFeatSummary[0].countsByKind.branch_pushed,
      1,
      'cloud P2 stable id: second run does not inflate count',
    );
  });
});
