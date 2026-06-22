/**
 * F233 Phase C C2a step 4 — FeatTrajectoryProjector.applyGitRefSnapshot 测试
 *
 * 砚砚 KD-C6 step 3.5 / 3.6 review advisories 钉死：
 *   - entry.at per-kind contract: 真实事件时间，不用 collectedAt 伪装
 *   - null prOpenedAt / prMergedAt → skip emit (不 fallback)
 *   - branch_stale_unmerged.entry.at = headCommitAt + bucketThresholdMs（首次跨阈值时刻）
 *   - payload.detectedAt = collectedAt（observation 真实时间，与 entry.at 显式分开）
 *
 * F188 提包球 fixture 核心：
 *   - no-PR stale branch (prOpenedAt/prMergedAt null + mergedToMain null)
 *   - 路径 = branch_pushed + branch_stale_unmerged + join provenance
 *   - 不需要 pr_opened / branch_merged_to_main 路径
 *
 * node:test，import dist。
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { FeatTrajectoryProjector } from '../dist/domains/feat-trajectory/FeatTrajectoryProjector.js';
import { InMemoryFeatTrajectoryStore } from '../dist/domains/feat-trajectory/FeatTrajectoryStore.js';
import { STALE_BUCKET_THRESHOLDS_MS, staleBucketForAge } from '../dist/domains/feat-trajectory/feat-trajectory-keys.js';

const MS_24H = 24 * 60 * 60 * 1000;
const MS_72H = 72 * 60 * 60 * 1000;
const MS_7D = 7 * 24 * 60 * 60 * 1000;
const MS_30D = 30 * 24 * 60 * 60 * 1000;

function baseSnapshot(overrides = {}) {
  return {
    branchName: 'fix/f188-phase-k-config-health-surface',
    headCommitSha: 'abc1234567890def',
    headCommitAt: 1_700_000_000_000, // base time
    prNumber: null,
    prState: null,
    mergedToMain: null,
    prOpenedAt: null,
    prMergedAt: null,
    authorIdentity: 'opus-47',
    featureCandidates: ['F188'],
    associatedThreadIds: ['thread_mov0in6qfn2j2nvg'],
    lastThreadMessageAt: 1_700_000_000_000 - 49 * 60 * 1000, // 49min before headCommitAt — F188 提包球 invariant
    lastThreadActivityAt: 1_700_000_000_000 - 49 * 60 * 1000,
    joinProvenance: { confidence: 'high', joinedVia: ['branch_name_F#'] },
    collectedAt: 1_700_000_000_000 + MS_24H, // 24h after headCommitAt
    ...overrides,
  };
}

describe('staleBucketForAge — bucket helper', () => {
  it('< 24h → null (无 stale 概念)', () => {
    assert.strictEqual(staleBucketForAge(0), null);
    assert.strictEqual(staleBucketForAge(MS_24H - 1), null);
  });

  it('24h ≤ age < 72h → "24h"', () => {
    assert.strictEqual(staleBucketForAge(MS_24H), '24h');
    assert.strictEqual(staleBucketForAge(MS_72H - 1), '24h');
  });

  it('72h ≤ age < 7d → "72h"', () => {
    assert.strictEqual(staleBucketForAge(MS_72H), '72h');
    assert.strictEqual(staleBucketForAge(MS_7D - 1), '72h');
  });

  it('7d ≤ age < 30d → "7d"', () => {
    assert.strictEqual(staleBucketForAge(MS_7D), '7d');
    assert.strictEqual(staleBucketForAge(MS_30D - 1), '7d');
  });

  it('age ≥ 30d → "30d" (largest crossed wins)', () => {
    assert.strictEqual(staleBucketForAge(MS_30D), '30d');
    assert.strictEqual(staleBucketForAge(MS_30D * 100), '30d');
  });

  it('STALE_BUCKET_THRESHOLDS_MS 暴露给 projector + collector + tests 共享', () => {
    assert.strictEqual(STALE_BUCKET_THRESHOLDS_MS['24h'], MS_24H);
    assert.strictEqual(STALE_BUCKET_THRESHOLDS_MS['72h'], MS_72H);
    assert.strictEqual(STALE_BUCKET_THRESHOLDS_MS['7d'], MS_7D);
    assert.strictEqual(STALE_BUCKET_THRESHOLDS_MS['30d'], MS_30D);
  });
});

describe('FeatTrajectoryProjector — applyGitRefSnapshot', () => {
  let store;
  let projector;

  beforeEach(() => {
    store = new InMemoryFeatTrajectoryStore();
    projector = new FeatTrajectoryProjector(store);
  });

  describe('Skip path (0 candidates)', () => {
    it('featureCandidates.length === 0 → skip whole snapshot (无 feat join, 无轨迹意义)', async () => {
      const snapshot = baseSnapshot({ featureCandidates: [] });
      await projector.applyGitRefSnapshot(snapshot);
      const feats = await store.listFeatIds();
      assert.deepStrictEqual(feats, [], 'no projection created');
    });
  });

  describe('Single-feat contract (single high-confidence candidate)', () => {
    it('targets featureCandidates[0] (collector enforces via skip-low-confidence policy)', async () => {
      const snapshot = baseSnapshot({ featureCandidates: ['F188'] });
      await projector.applyGitRefSnapshot(snapshot);
      const proj = await store.get('F188');
      assert.ok(proj, 'projection created for F188');
      assert.strictEqual(proj.featId, 'F188');
    });
  });

  describe('branch_pushed — always emit, entry.at = headCommitAt', () => {
    it('emits branch_pushed with entry.at = real git commit time (not collectedAt)', async () => {
      const snapshot = baseSnapshot();
      await projector.applyGitRefSnapshot(snapshot);
      const proj = await store.get('F188');
      const pushed = proj.entries.find((e) => e.kind === 'branch_pushed');
      assert.ok(pushed, 'branch_pushed entry emitted');
      assert.strictEqual(pushed.at, snapshot.headCommitAt, 'entry.at = headCommitAt (not collectedAt)');
      assert.strictEqual(pushed.source, 'git-ref-snapshot');
      assert.strictEqual(pushed.featId, 'F188');
      assert.strictEqual(pushed.subjectKey, `git-ref:${snapshot.branchName}`);
      assert.strictEqual(
        pushed.payload.detectedAt,
        snapshot.collectedAt,
        'payload.detectedAt = collectedAt (observation time, separate from entry.at)',
      );
      assert.deepStrictEqual(pushed.payload.joinProvenance, snapshot.joinProvenance);
    });
  });

  describe('pr_opened — null prOpenedAt → skip emit (砚砚 step 4 护栏)', () => {
    it('prOpenedAt === null → no pr_opened entry (避免 collectedAt 伪装真实事件时间)', async () => {
      const snapshot = baseSnapshot({ prOpenedAt: null, prNumber: 1234, prState: 'open' });
      await projector.applyGitRefSnapshot(snapshot);
      const proj = await store.get('F188');
      const pr = proj.entries.find((e) => e.kind === 'pr_opened');
      assert.strictEqual(pr, undefined, 'pr_opened entry skipped when prOpenedAt is null');
    });

    it('prOpenedAt non-null → pr_opened entry emitted with entry.at = prOpenedAt', async () => {
      const realPrOpenedAt = 1_700_000_000_000 + 60 * 60 * 1000; // 1h after headCommit
      const snapshot = baseSnapshot({ prOpenedAt: realPrOpenedAt, prNumber: 1234, prState: 'open' });
      await projector.applyGitRefSnapshot(snapshot);
      const proj = await store.get('F188');
      const pr = proj.entries.find((e) => e.kind === 'pr_opened');
      assert.ok(pr, 'pr_opened emitted when prOpenedAt non-null');
      assert.strictEqual(pr.at, realPrOpenedAt, 'entry.at = prOpenedAt (real PR created time)');
    });
  });

  describe('branch_merged_to_main — null prMergedAt or non-mergedToMain → skip emit', () => {
    it('mergedToMain !== true → no branch_merged_to_main entry', async () => {
      const snapshot = baseSnapshot({ mergedToMain: false, prMergedAt: 1_700_000_000_000 + MS_24H });
      await projector.applyGitRefSnapshot(snapshot);
      const proj = await store.get('F188');
      const merged = proj.entries.find((e) => e.kind === 'branch_merged_to_main');
      assert.strictEqual(merged, undefined, 'branch_merged_to_main skipped when not actually merged');
    });

    it('prMergedAt === null even when mergedToMain === true → skip emit (avoid timestamp guessing)', async () => {
      const snapshot = baseSnapshot({ mergedToMain: true, prMergedAt: null });
      await projector.applyGitRefSnapshot(snapshot);
      const proj = await store.get('F188');
      const merged = proj.entries.find((e) => e.kind === 'branch_merged_to_main');
      assert.strictEqual(merged, undefined, 'no entry without real prMergedAt');
    });

    it('Both prMergedAt non-null AND mergedToMain=true → emit with entry.at = prMergedAt', async () => {
      const realMergedAt = 1_700_000_000_000 + 2 * MS_24H;
      const snapshot = baseSnapshot({
        mergedToMain: true,
        prMergedAt: realMergedAt,
        prState: 'merged',
        prNumber: 1234, // cloud P2 fix: branch_merged_to_main id 用 prNumber
      });
      await projector.applyGitRefSnapshot(snapshot);
      const proj = await store.get('F188');
      const merged = proj.entries.find((e) => e.kind === 'branch_merged_to_main');
      assert.ok(merged, 'emitted when both conditions true');
      assert.strictEqual(merged.at, realMergedAt);
    });
  });

  describe('branch_stale_unmerged — bucket-derived entry.at', () => {
    it('age < 24h → no stale entry (not yet crossed first threshold)', async () => {
      const snapshot = baseSnapshot({ collectedAt: 1_700_000_000_000 + MS_24H - 1 });
      await projector.applyGitRefSnapshot(snapshot);
      const proj = await store.get('F188');
      const stale = proj.entries.find((e) => e.kind === 'branch_stale_unmerged');
      assert.strictEqual(stale, undefined);
    });

    it('age 24h → bucket "24h", entry.at = headCommitAt + 24h (NOT collectedAt)', async () => {
      const snapshot = baseSnapshot({ collectedAt: 1_700_000_000_000 + MS_24H });
      await projector.applyGitRefSnapshot(snapshot);
      const proj = await store.get('F188');
      const stale = proj.entries.find((e) => e.kind === 'branch_stale_unmerged');
      assert.ok(stale);
      assert.strictEqual(stale.at, snapshot.headCommitAt + MS_24H, 'entry.at = bucket crossing time');
      assert.strictEqual(stale.payload.staleBucket, '24h');
      assert.strictEqual(
        stale.payload.detectedAt,
        snapshot.collectedAt,
        'observation time in payload, separate from entry.at',
      );
    });

    it('mergedToMain === true → no stale entry (already merged, not stale)', async () => {
      const snapshot = baseSnapshot({ mergedToMain: true, collectedAt: 1_700_000_000_000 + MS_30D });
      await projector.applyGitRefSnapshot(snapshot);
      const proj = await store.get('F188');
      const stale = proj.entries.find((e) => e.kind === 'branch_stale_unmerged');
      assert.strictEqual(stale, undefined);
    });
  });

  describe('F188 提包球 regression fixture (no-PR + stale, full provenance)', () => {
    it('F188 10-day stale snapshot → branch_pushed + branch_stale_unmerged:7d + full provenance', async () => {
      const snapshot = baseSnapshot({
        // F188 case real-shape:
        prNumber: null, // no PR opened
        prState: null,
        prOpenedAt: null,
        prMergedAt: null,
        mergedToMain: null,
        collectedAt: 1_700_000_000_000 + 10 * MS_24H, // 10 days later (operator 心血来潮发现)
      });
      await projector.applyGitRefSnapshot(snapshot);
      const proj = await store.get('F188');
      assert.ok(proj, 'F188 projection created');

      // F188 路径 = branch_pushed + branch_stale_unmerged (no PR kinds)
      assert.strictEqual(proj.entries.length, 2);

      const kinds = proj.entries.map((e) => e.kind);
      assert.ok(kinds.includes('branch_pushed'));
      assert.ok(kinds.includes('branch_stale_unmerged'));
      assert.ok(!kinds.includes('pr_opened'), 'no pr_opened (no PR exists)');
      assert.ok(!kinds.includes('branch_merged_to_main'), 'no merge (never merged)');

      const stale = proj.entries.find((e) => e.kind === 'branch_stale_unmerged');
      assert.strictEqual(stale.payload.staleBucket, '7d', '10 days → largest crossed is 7d');
      assert.strictEqual(stale.at, snapshot.headCommitAt + MS_7D, 'entry.at = bucket threshold (7d), not collectedAt');

      // Join provenance carry-forward (砚砚 P2-1)
      assert.deepStrictEqual(
        stale.payload.joinProvenance,
        { confidence: 'high', joinedVia: ['branch_name_F#'] },
        'F188 join provenance preserved (high confidence via branch_name_F#)',
      );

      // F188 invariant: lastThreadMessageAt < headCommitAt（"猫提着包走完一棒没回头"）
      assert.ok(
        snapshot.lastThreadMessageAt < snapshot.headCommitAt,
        'F188 fixture invariant: thread silence before final commit',
      );
    });

    it('F188 multi-tick scenario: tick at day 1 / day 3 / day 7 → 3 distinct stale entries', async () => {
      // Same branch, 3 cron ticks at different times → 3 different staleBuckets → 3 entries
      const ticks = [
        { collectedAt: 1_700_000_000_000 + MS_24H, expectedBucket: '24h' },
        { collectedAt: 1_700_000_000_000 + MS_72H, expectedBucket: '72h' },
        { collectedAt: 1_700_000_000_000 + MS_7D, expectedBucket: '7d' },
      ];
      for (const tick of ticks) {
        await projector.applyGitRefSnapshot(baseSnapshot({ collectedAt: tick.collectedAt }));
      }
      const proj = await store.get('F188');
      const staleEntries = proj.entries.filter((e) => e.kind === 'branch_stale_unmerged');
      assert.strictEqual(staleEntries.length, 3, '3 distinct stale entries from 3 bucket crossings');
      const buckets = staleEntries.map((e) => e.payload.staleBucket).sort();
      assert.deepStrictEqual(buckets, ['24h', '72h', '7d']);
      // branch_pushed should appear only ONCE (upsert on same entryId)
      const pushedEntries = proj.entries.filter((e) => e.kind === 'branch_pushed');
      assert.strictEqual(pushedEntries.length, 1, 'branch_pushed upsert idempotent across ticks');
    });
  });

  describe('Upsert idempotency for git-ref entries (砚砚 P2-2 + P2-4)', () => {
    it('Same snapshot applied twice → no duplicate entries, counts unchanged', async () => {
      const snapshot = baseSnapshot();
      await projector.applyGitRefSnapshot(snapshot);
      const projFirst = await store.get('F188');
      const firstCount = projFirst.entries.length;
      const firstAppliedCount = projFirst.appliedEntryCount;

      await projector.applyGitRefSnapshot(snapshot);
      const projSecond = await store.get('F188');
      assert.strictEqual(projSecond.entries.length, firstCount, 'no new entries (upsert by gitRefEntryId)');
      assert.strictEqual(projSecond.appliedEntryCount, firstAppliedCount, 'counts unchanged');
    });
  });

  describe('CLOUD P2 regression: per-kind id stability across state transitions', () => {
    it('branch_pushed: same head, PR state changes (null → open) → single branch_pushed entry (not duplicated)', async () => {
      // 同一 push event 不应该因为 PR 开了而变成两个 branch_pushed entry
      const t0 = baseSnapshot({ prState: null, prNumber: null, prOpenedAt: null, mergedToMain: null });
      const t1 = baseSnapshot({
        prState: 'open',
        prNumber: 1234,
        prOpenedAt: 1_700_000_000_000 + 60 * 1000, // 1min after commit
        mergedToMain: false,
        collectedAt: 1_700_000_000_000 + 60 * 60 * 1000, // 1h after commit, still under 24h
      });
      await projector.applyGitRefSnapshot(t0);
      await projector.applyGitRefSnapshot(t1);
      const proj = await store.get('F188');
      const pushed = proj.entries.filter((e) => e.kind === 'branch_pushed');
      assert.strictEqual(
        pushed.length,
        1,
        'CLOUD P2 fix: branch_pushed id stable across PR state changes (id = branchName:sha:branch_pushed)',
      );
    });

    it('pr_opened: same PR, head commit changes → single pr_opened entry (not duplicated)', async () => {
      // PR 创建只发生一次，新 commit 不应该产生新 pr_opened entry
      const realPrOpenedAt = 1_700_000_000_000 + 60 * 1000;
      const t0 = baseSnapshot({
        headCommitSha: 'sha-A',
        prState: 'open',
        prNumber: 1234,
        prOpenedAt: realPrOpenedAt,
        mergedToMain: false,
      });
      const t1 = baseSnapshot({
        headCommitSha: 'sha-B', // new commit push to same PR
        prState: 'open',
        prNumber: 1234,
        prOpenedAt: realPrOpenedAt, // same PR open time
        mergedToMain: false,
      });
      await projector.applyGitRefSnapshot(t0);
      await projector.applyGitRefSnapshot(t1);
      const proj = await store.get('F188');
      const opens = proj.entries.filter((e) => e.kind === 'pr_opened');
      assert.strictEqual(
        opens.length,
        1,
        'CLOUD P2 fix: pr_opened id stable across head commit changes (id = branchName:pr-N:pr_opened)',
      );
    });

    it('branch_merged_to_main: same PR, head changes → single merge entry (not duplicated)', async () => {
      const realMergedAt = 1_700_000_000_000 + 2 * MS_24H;
      const t0 = baseSnapshot({
        headCommitSha: 'sha-A',
        prState: 'merged',
        prNumber: 1234,
        prMergedAt: realMergedAt,
        mergedToMain: true,
      });
      const t1 = baseSnapshot({
        headCommitSha: 'sha-B',
        prState: 'merged',
        prNumber: 1234,
        prMergedAt: realMergedAt,
        mergedToMain: true,
      });
      await projector.applyGitRefSnapshot(t0);
      await projector.applyGitRefSnapshot(t1);
      const proj = await store.get('F188');
      const merges = proj.entries.filter((e) => e.kind === 'branch_merged_to_main');
      assert.strictEqual(merges.length, 1, 'CLOUD P2 fix: branch_merged_to_main id stable per PR identity');
    });
  });
});
