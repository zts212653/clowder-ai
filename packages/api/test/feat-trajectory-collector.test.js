/**
 * F233 Phase C C2a step 4 part 2 — GitRefSnapshotCollector 测试
 *
 * 砚砚 KD-C6 step 4 part 1 review 钉死：
 *   "collector 必须用测试证明 default multiCandidatePolicy='skip-low-confidence'
 *    会拦住多候选/低置信 snapshot，避免 projector 的 featureCandidates[0] 被误用"
 *
 * 覆盖：
 *   - applyMultiCandidatePolicy (4 path: 0/low/multi/single-high)
 *   - heuristicFeatJoin (4 methods evidence accumulation + confidence)
 *   - GitRefSnapshotCollector.collectOne with mock IO (F188 fixture 端到端)
 *
 * node:test，import dist。
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { FeatTrajectoryProjector } from '../dist/domains/feat-trajectory/FeatTrajectoryProjector.js';
import { InMemoryFeatTrajectoryStore } from '../dist/domains/feat-trajectory/FeatTrajectoryStore.js';
import {
  applyMultiCandidatePolicy,
  GitRefSnapshotCollector,
  heuristicFeatJoin,
} from '../dist/domains/feat-trajectory/GitRefSnapshotCollector.js';

const MS_24H = 24 * 60 * 60 * 1000;
const MS_7D = 7 * 24 * 60 * 60 * 1000;
const BASE_HEAD_COMMIT_AT = 1_700_000_000_000;

// ============================================================================
// applyMultiCandidatePolicy 4-path coverage
// ============================================================================

describe('applyMultiCandidatePolicy — default skip-low-confidence (砚砚 step 4 part 1 护栏)', () => {
  it('0 candidates → skip with reason "no candidates"', () => {
    const d = applyMultiCandidatePolicy([], 'high', 'skip-low-confidence');
    assert.strictEqual(d.decision, 'skip');
    assert.match(d.reason ?? '', /no candidates/);
    assert.strictEqual(d.selectedFeatId, undefined);
  });

  it('low confidence (regardless of candidate count) → skip', () => {
    const d = applyMultiCandidatePolicy(['F188'], 'low', 'skip-low-confidence');
    assert.strictEqual(d.decision, 'skip');
    assert.match(d.reason ?? '', /low confidence/);
  });

  it('multi-candidate even with high confidence → skip (single-feat 模糊)', () => {
    const d = applyMultiCandidatePolicy(['F188', 'F233'], 'high', 'skip-low-confidence');
    assert.strictEqual(d.decision, 'skip');
    assert.match(d.reason ?? '', /multi-candidate/);
  });

  it('single high-confidence → emit with selectedFeatId', () => {
    const d = applyMultiCandidatePolicy(['F188'], 'high', 'skip-low-confidence');
    assert.strictEqual(d.decision, 'emit');
    assert.strictEqual(d.selectedFeatId, 'F188');
  });

  it('single medium-confidence → emit (still single-feat, not low)', () => {
    const d = applyMultiCandidatePolicy(['F188'], 'medium', 'skip-low-confidence');
    assert.strictEqual(d.decision, 'emit');
    assert.strictEqual(d.selectedFeatId, 'F188');
  });

  it('emit-per-candidate-low-confidence throws explicit unimplemented error (砚砚 step 4 part 2 P3 fix)', () => {
    // 防止配置到这个 policy 时静默投到第一个候选（与命名/语义不一致）。
    // Future 真正落地时改成 emit per candidate + low/medium confidence label。
    assert.throws(
      () => applyMultiCandidatePolicy(['F188'], 'high', 'emit-per-candidate-low-confidence'),
      /emit-per-candidate-low-confidence.*not yet implemented/,
      'must throw explicit error rather than silently picking first candidate',
    );
  });
});

// ============================================================================
// heuristicFeatJoin 4 methods coverage (text-based: branch_name_F# +
// commit_message_F#; feat_index added externally with IO. Cloud round 3 P2 fix:
// thread_keyword removed from FeatThreadJoinMethod type entirely — discovery
// from thread content is a future capability (needs ThreadSearch.findByBranchKeyword).
// ============================================================================

describe('heuristicFeatJoin — text-based methods evidence + confidence', () => {
  it('branch_name_F# only → medium confidence single candidate', () => {
    const r = heuristicFeatJoin('fix/f188-phase-k-config-health-surface', []);
    assert.deepStrictEqual(r.featureCandidates, ['F188']);
    assert.deepStrictEqual(r.joinedVia, ['branch_name_F#']);
    assert.strictEqual(r.confidence, 'medium');
  });

  it('commit_message_F# only → medium confidence (1 evidence)', () => {
    const r = heuristicFeatJoin('some-random-branch', ['F233: implement projector', 'F233: tests']);
    assert.deepStrictEqual(r.featureCandidates, ['F233']);
    assert.deepStrictEqual(r.joinedVia, ['commit_message_F#']);
    assert.strictEqual(r.confidence, 'medium');
  });

  it('branch_name_F# + commit_message_F# double evidence → high confidence', () => {
    const r = heuristicFeatJoin('fix/f188-something', ['F188: fix bug', 'F188: more fixes']);
    assert.deepStrictEqual(r.featureCandidates, ['F188']);
    assert.ok(r.joinedVia.includes('branch_name_F#'));
    assert.ok(r.joinedVia.includes('commit_message_F#'));
    assert.strictEqual(r.confidence, 'high');
  });

  it('neither method matches → low confidence + 0 candidates', () => {
    const r = heuristicFeatJoin('release/v1.0', ['Initial release']);
    assert.deepStrictEqual(r.featureCandidates, []);
    assert.deepStrictEqual(r.joinedVia, []);
    assert.strictEqual(r.confidence, 'low');
  });

  it('multi-feat in commit messages → multi-candidate (collector will skip per policy)', () => {
    const r = heuristicFeatJoin('feat/some-branch', ['F188: x', 'F233: y']);
    assert.strictEqual(r.featureCandidates.length, 2);
    assert.ok(r.featureCandidates.includes('F188'));
    assert.ok(r.featureCandidates.includes('F233'));
  });

  it('F-pattern matches uppercase + position in branch name', () => {
    // common conventions: fix/f188-..., feat/F233-..., bugfix/f88-...
    assert.deepStrictEqual(heuristicFeatJoin('fix/f188-x', []).featureCandidates, ['F188']);
    assert.deepStrictEqual(heuristicFeatJoin('feat/F233-x', []).featureCandidates, ['F233']);
  });

  it('CLOUD P2 regression: multi-feat in branch name → matchAll captures all (fix/f188-f233-cleanup)', () => {
    // Cloud P2 (GitRefSnapshotCollector.ts:182): branchName.match() only captures
    // first F# → multi-feat branch like fix/f188-f233-cleanup was incorrectly emitted
    // as single F188 candidate. Fix uses matchAll to collect all F# patterns.
    const r = heuristicFeatJoin('fix/f188-f233-cleanup', []);
    assert.strictEqual(r.featureCandidates.length, 2, 'matchAll must capture both F188 and F233 from branch name');
    assert.ok(r.featureCandidates.includes('F188'));
    assert.ok(r.featureCandidates.includes('F233'));
    assert.deepStrictEqual(r.joinedVia, ['branch_name_F#']);
    assert.strictEqual(
      r.confidence,
      'medium',
      'only branch_name_F# evidence → medium (collector enforces skip on multi-candidate)',
    );
  });
});

// ============================================================================
// GitRefSnapshotCollector with mock IO — F188 fixture end-to-end
// ============================================================================

function makeMockOpts(overrides = {}) {
  const defaults = {
    branches: [{ branchName: 'fix/f188-phase-k-config-health-surface', headCommitSha: 'abc1234' }],
    commitMetas: new Map([
      [
        'abc1234',
        {
          headCommitAt: BASE_HEAD_COMMIT_AT,
          authorIdentity: 'opus-47',
          commitMessages: ['F188 Phase K config health surface', 'wip'],
        },
      ],
    ]),
    prMap: new Map(), // empty → no PR for F188 (提包球本质)
    featIndexMap: new Map(), // empty → no feat_index registration
    threadMap: new Map([
      [
        'F188',
        [
          {
            threadId: 'thread_mov0in6qfn2j2nvg',
            lastMessageAt: BASE_HEAD_COMMIT_AT - 49 * 60 * 1000, // 49min before commit
            lastActivityAt: BASE_HEAD_COMMIT_AT - 49 * 60 * 1000,
          },
        ],
      ],
    ]),
  };
  const merged = { ...defaults, ...overrides };
  return {
    gitRunner: {
      lsRemote: async () => merged.branches,
      getCommitMeta: async (sha) => {
        const m = merged.commitMetas.get(sha);
        if (!m) throw new Error(`mock: no meta for ${sha}`);
        return m;
      },
    },
    ghClient: {
      findPrByBranch: async (branchName) => merged.prMap.get(branchName) ?? null,
    },
    featIndexLookup: {
      findByBranch: async (branchName) => merged.featIndexMap.get(branchName) ?? [],
    },
    threadSearch: {
      findByFeatId: async (featId) => merged.threadMap.get(featId) ?? [],
    },
  };
}

describe('GitRefSnapshotCollector — collectOne with mock IO', () => {
  describe('F188 提包球 happy path (no-PR + branch_name match + thread + medium→high promote)', () => {
    it('emits single high-confidence F188 snapshot via branch_name_F# + commit_message_F# (discovery), threads attached for activity timestamps', async () => {
      const collector = new GitRefSnapshotCollector(makeMockOpts());
      const snap = await collector.collectOne(
        'fix/f188-phase-k-config-health-surface',
        BASE_HEAD_COMMIT_AT + 10 * MS_24H, // 10 days later
      );

      assert.ok(snap !== null, 'F188 fixture must emit snapshot');
      assert.strictEqual(snap.branchName, 'fix/f188-phase-k-config-health-surface');
      assert.strictEqual(snap.headCommitSha, 'abc1234');
      assert.strictEqual(snap.headCommitAt, BASE_HEAD_COMMIT_AT);
      assert.strictEqual(snap.authorIdentity, 'opus-47');

      // No PR (F188 提包球 invariant)
      assert.strictEqual(snap.prNumber, null);
      assert.strictEqual(snap.prState, null);
      assert.strictEqual(snap.mergedToMain, null);
      assert.strictEqual(snap.prOpenedAt, null, 'no PR → prOpenedAt = null (projector will skip emit pr_opened)');
      assert.strictEqual(snap.prMergedAt, null, 'no PR → prMergedAt = null');

      // Feat join (high confidence via branch_name_F# + commit_message_F# double evidence).
      // CLOUD ROUND 3 P2 fix: thread_keyword removed from FeatThreadJoinMethod type entirely;
      // only 3 supported methods (feat_index / commit_message_F# / branch_name_F#).
      assert.deepStrictEqual(snap.featureCandidates, ['F188']);
      assert.strictEqual(snap.joinProvenance.confidence, 'high');
      assert.ok(snap.joinProvenance.joinedVia.includes('branch_name_F#'));
      assert.ok(snap.joinProvenance.joinedVia.includes('commit_message_F#'));
      // joinedVia restricted to discovery methods — no thread_keyword (type now excludes it)

      // Thread join
      assert.deepStrictEqual(snap.associatedThreadIds, ['thread_mov0in6qfn2j2nvg']);
      assert.ok(snap.lastThreadMessageAt !== null);
      assert.ok(snap.lastThreadMessageAt < snap.headCommitAt, 'F188 invariant: thread silence before final commit');

      // Tick context
      assert.strictEqual(snap.collectedAt, BASE_HEAD_COMMIT_AT + 10 * MS_24H);
    });
  });

  describe('multiCandidatePolicy default skip-low-confidence (砚砚 step 4 part 1 护栏)', () => {
    it('0 candidates → skip emit (no feat join, projector cannot select)', async () => {
      const collector = new GitRefSnapshotCollector(
        makeMockOpts({
          branches: [{ branchName: 'release/v1.0', headCommitSha: 'sha0' }],
          commitMetas: new Map([
            ['sha0', { headCommitAt: BASE_HEAD_COMMIT_AT, authorIdentity: 'opus', commitMessages: ['init'] }],
          ]),
        }),
      );
      const snap = await collector.collectOne('release/v1.0', BASE_HEAD_COMMIT_AT + MS_24H);
      assert.strictEqual(snap, null, 'no F# pattern → 0 candidates → skip');
    });

    it('low confidence (only weak signals, no F# in branch/commit) → skip emit', async () => {
      // No branch_name_F# match, no commit_message_F# → low confidence with 0 candidates
      const collector = new GitRefSnapshotCollector(
        makeMockOpts({
          branches: [{ branchName: 'feat/random-name', headCommitSha: 'sha1' }],
          commitMetas: new Map([
            ['sha1', { headCommitAt: BASE_HEAD_COMMIT_AT, authorIdentity: 'opus', commitMessages: ['no F# here'] }],
          ]),
        }),
      );
      const snap = await collector.collectOne('feat/random-name', BASE_HEAD_COMMIT_AT + MS_24H);
      assert.strictEqual(snap, null, 'low confidence → skip emit (避免污染轨迹)');
    });

    it('multi-candidate even with high confidence → skip emit (single-feat 模糊)', async () => {
      // commit messages mention both F188 and F233 → multi-candidate
      const collector = new GitRefSnapshotCollector(
        makeMockOpts({
          branches: [{ branchName: 'feat/multi', headCommitSha: 'sha2' }],
          commitMetas: new Map([
            [
              'sha2',
              {
                headCommitAt: BASE_HEAD_COMMIT_AT,
                authorIdentity: 'opus',
                commitMessages: ['F188: x', 'F233: y'],
              },
            ],
          ]),
        }),
      );
      const snap = await collector.collectOne('feat/multi', BASE_HEAD_COMMIT_AT + MS_24H);
      assert.strictEqual(snap, null, 'multi-candidate → skip emit (single-feat contract cannot be enforced)');
    });

    it('CLOUD P2 regression: multi-feat branch name → multi-candidate → skip emit (fix/f188-f233-cleanup)', async () => {
      // 砚砚 + cloud P2: branch_name_F# matchAll fix → multi-feat in branch name now
      // correctly detected as multi-candidate → skip per policy. Previously single
      // F188 candidate medium-confidence → wrongly emitted.
      const collector = new GitRefSnapshotCollector(
        makeMockOpts({
          branches: [{ branchName: 'fix/f188-f233-cleanup', headCommitSha: 'sha-multi-bn' }],
          commitMetas: new Map([
            [
              'sha-multi-bn',
              {
                headCommitAt: BASE_HEAD_COMMIT_AT,
                authorIdentity: 'opus',
                commitMessages: ['cleanup'],
              },
            ],
          ]),
        }),
      );
      const snap = await collector.collectOne('fix/f188-f233-cleanup', BASE_HEAD_COMMIT_AT + MS_24H);
      assert.strictEqual(snap, null, 'multi-feat branch name → matchAll detects 2 candidates → policy rejects');
    });

    it('feat_index hit promotes single-candidate to high confidence + emit', async () => {
      // branch_name doesn't match, commit doesn't mention F#, but feat_index registers it explicitly
      const collector = new GitRefSnapshotCollector(
        makeMockOpts({
          branches: [{ branchName: 'fix/custom-name', headCommitSha: 'sha3' }],
          commitMetas: new Map([
            ['sha3', { headCommitAt: BASE_HEAD_COMMIT_AT, authorIdentity: 'opus', commitMessages: ['Fix things'] }],
          ]),
          featIndexMap: new Map([['fix/custom-name', ['F999']]]), // explicit anchor
          threadMap: new Map(),
        }),
      );
      const snap = await collector.collectOne('fix/custom-name', BASE_HEAD_COMMIT_AT + MS_24H);
      assert.ok(snap !== null, 'feat_index anchor must emit snapshot even without F# pattern');
      assert.deepStrictEqual(snap.featureCandidates, ['F999']);
      assert.strictEqual(snap.joinProvenance.confidence, 'high', 'feat_index = high confidence');
      assert.strictEqual(snap.joinProvenance.joinedVia[0], 'feat_index');
    });
  });

  describe('Real PR timestamp contract (砚砚 step 3.6 + step 4 part 1)', () => {
    it('PR exists → prOpenedAt/prMergedAt from gh API (not synthesized)', async () => {
      const realPrOpenedAt = BASE_HEAD_COMMIT_AT + 60 * 60 * 1000; // 1h after commit
      const realPrMergedAt = BASE_HEAD_COMMIT_AT + 2 * MS_24H; // 2d after commit
      const collector = new GitRefSnapshotCollector(
        makeMockOpts({
          branches: [{ branchName: 'fix/f188-with-pr', headCommitSha: 'sha-pr' }],
          commitMetas: new Map([
            [
              'sha-pr',
              {
                headCommitAt: BASE_HEAD_COMMIT_AT,
                authorIdentity: 'opus',
                commitMessages: ['F188: with PR'],
              },
            ],
          ]),
          prMap: new Map([
            [
              'fix/f188-with-pr',
              {
                prNumber: 1234,
                prState: 'merged',
                prOpenedAt: realPrOpenedAt,
                prMergedAt: realPrMergedAt,
                mergedToMain: true,
              },
            ],
          ]),
        }),
      );
      const snap = await collector.collectOne('fix/f188-with-pr', BASE_HEAD_COMMIT_AT + 3 * MS_24H);
      assert.ok(snap !== null);
      assert.strictEqual(snap.prNumber, 1234);
      assert.strictEqual(snap.prState, 'merged');
      assert.strictEqual(snap.mergedToMain, true);
      assert.strictEqual(snap.prOpenedAt, realPrOpenedAt, 'prOpenedAt must come from gh API, not collectedAt');
      assert.strictEqual(snap.prMergedAt, realPrMergedAt, 'prMergedAt must come from gh API, not collectedAt');
    });
  });

  describe('Branch not in lsRemote scan → null', () => {
    it('collectOne for unscanned branch → null (no snapshot emitted)', async () => {
      const collector = new GitRefSnapshotCollector(makeMockOpts());
      const snap = await collector.collectOne('feat/nonexistent', BASE_HEAD_COMMIT_AT + MS_24H);
      assert.strictEqual(snap, null);
    });
  });

  describe('collectAll single lsRemote scan (砚砚 step 4 part 2 P2 fix)', () => {
    it('N branches → lsRemote called exactly 1 time (not N+1) — 不退化成 N+1 remote scan + 不读不一致 ref state', async () => {
      const opts = makeMockOpts({
        branches: [
          { branchName: 'fix/f188-x', headCommitSha: 'sha1' },
          { branchName: 'fix/f233-y', headCommitSha: 'sha2' },
          { branchName: 'feat/f242-z', headCommitSha: 'sha3' },
        ],
        commitMetas: new Map([
          ['sha1', { headCommitAt: BASE_HEAD_COMMIT_AT, authorIdentity: 'opus', commitMessages: ['F188: a'] }],
          ['sha2', { headCommitAt: BASE_HEAD_COMMIT_AT, authorIdentity: 'opus', commitMessages: ['F233: b'] }],
          ['sha3', { headCommitAt: BASE_HEAD_COMMIT_AT, authorIdentity: 'opus', commitMessages: ['F242: c'] }],
        ]),
      });

      // Wrap gitRunner.lsRemote with a call counter
      let lsRemoteCallCount = 0;
      const originalLsRemote = opts.gitRunner.lsRemote;
      opts.gitRunner.lsRemote = async (...args) => {
        lsRemoteCallCount++;
        return originalLsRemote(...args);
      };

      const collector = new GitRefSnapshotCollector(opts);
      const snapshots = await collector.collectAll(BASE_HEAD_COMMIT_AT + MS_24H);

      assert.strictEqual(
        lsRemoteCallCount,
        1,
        'collectAll must reuse single lsRemote scan (砚砚 P2: 不退化成 N+1 per branch scan)',
      );
      // Sanity: all 3 branches processed via collectBranchRef
      assert.strictEqual(snapshots.length, 3, '3 branches all emitted (no skip from single-feat F# match)');
      const featIds = snapshots.map((s) => s.featureCandidates[0]).sort();
      assert.deepStrictEqual(featIds, ['F188', 'F233', 'F242']);
    });

    it('collectAll continues past branches that policy rejects (skip-low-confidence) without extra lsRemote', async () => {
      const opts = makeMockOpts({
        branches: [
          { branchName: 'fix/f188-good', headCommitSha: 'sha-good' },
          { branchName: 'release/v1.0', headCommitSha: 'sha-noF' }, // no F# → 0 candidates → skip
          { branchName: 'feat/multi', headCommitSha: 'sha-multi' }, // multi-candidate → skip
        ],
        commitMetas: new Map([
          ['sha-good', { headCommitAt: BASE_HEAD_COMMIT_AT, authorIdentity: 'opus', commitMessages: ['F188: yes'] }],
          ['sha-noF', { headCommitAt: BASE_HEAD_COMMIT_AT, authorIdentity: 'opus', commitMessages: ['no F here'] }],
          [
            'sha-multi',
            { headCommitAt: BASE_HEAD_COMMIT_AT, authorIdentity: 'opus', commitMessages: ['F188 a', 'F233 b'] },
          ],
        ]),
      });

      let lsRemoteCallCount = 0;
      const originalLsRemote = opts.gitRunner.lsRemote;
      opts.gitRunner.lsRemote = async (...args) => {
        lsRemoteCallCount++;
        return originalLsRemote(...args);
      };

      const collector = new GitRefSnapshotCollector(opts);
      const snapshots = await collector.collectAll(BASE_HEAD_COMMIT_AT + MS_24H);

      assert.strictEqual(lsRemoteCallCount, 1, 'single lsRemote even with mid-batch skips');
      assert.strictEqual(snapshots.length, 1, 'only F188 branch survives policy');
      assert.deepStrictEqual(snapshots[0].featureCandidates, ['F188']);
    });
  });
});

// ============================================================================
// End-to-end: collector → projector (F188 提包球 full pipeline)
// ============================================================================

describe('F188 提包球 end-to-end (collector → projector → projection)', () => {
  let store;
  let projector;
  let collector;

  beforeEach(() => {
    store = new InMemoryFeatTrajectoryStore();
    projector = new FeatTrajectoryProjector(store);
    collector = new GitRefSnapshotCollector(makeMockOpts());
  });

  it('Full pipeline: F188 10-day no-PR stale → projection has branch_pushed + branch_stale_unmerged:7d', async () => {
    const now = BASE_HEAD_COMMIT_AT + 10 * MS_24H;
    const snap = await collector.collectOne('fix/f188-phase-k-config-health-surface', now);
    assert.ok(snap !== null, 'collector emits F188 snapshot');

    await projector.applyGitRefSnapshot(snap);
    const proj = await store.get('F188');
    assert.ok(proj, 'projection created for F188');

    // F188 invariant: only branch_pushed + branch_stale_unmerged (no PR kinds)
    const kinds = proj.entries.map((e) => e.kind).sort();
    assert.deepStrictEqual(kinds, ['branch_pushed', 'branch_stale_unmerged']);

    // branch_stale_unmerged: bucket=7d (10d age), entry.at = headCommitAt + 7d (not collectedAt)
    const stale = proj.entries.find((e) => e.kind === 'branch_stale_unmerged');
    assert.strictEqual(stale.payload.staleBucket, '7d');
    assert.strictEqual(stale.at, BASE_HEAD_COMMIT_AT + MS_7D, 'entry.at = headCommitAt + 7d (bucket crossing)');
    assert.strictEqual(stale.payload.detectedAt, now, 'payload.detectedAt = collectedAt');

    // Join provenance carry-forward
    assert.strictEqual(stale.payload.joinProvenance.confidence, 'high');
  });

  it('multi-candidate snapshot from collector → null → projector unaffected', async () => {
    // multi-candidate branch → collector skip → projector no-op
    const multiCollector = new GitRefSnapshotCollector(
      makeMockOpts({
        branches: [{ branchName: 'feat/multi', headCommitSha: 'sha-m' }],
        commitMetas: new Map([
          [
            'sha-m',
            { headCommitAt: BASE_HEAD_COMMIT_AT, authorIdentity: 'opus', commitMessages: ['F188 x', 'F233 y'] },
          ],
        ]),
      }),
    );
    const snap = await multiCollector.collectOne('feat/multi', BASE_HEAD_COMMIT_AT + MS_24H);
    assert.strictEqual(snap, null, 'collector skips multi-candidate');
    // Projector never called → no projections created
    const feats = await store.listFeatIds();
    assert.deepStrictEqual(feats, [], 'no projection for skipped snapshot');
  });
});
