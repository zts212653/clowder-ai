/**
 * F233 Phase C C3 — Trajectory mock fixture（UI 自测 + component test 数据源）。
 *
 * **明确构造数据**（非真实警报）：SHA / thread id 为占位，仅供视觉/渲染验证。
 * 基于 `packages/api/test/feat-trajectory-projector-git-ref.test.js` 的 F188 提包球
 * fixture（10-day no-PR stale，lastThreadMessageAt < headCommitAt invariant）扩展，
 * 覆盖 13 kind 的全色系（purple/emerald/cyan/amber/gray），用于 endpoint 就绪前的 UI 开发。
 *
 * opus-47 C2b endpoint 就绪后，生产走真实 `apiFetch`，本 fixture 仅 dev `?trajMock=` 注入。
 */

import type { FeatTrajectoryEntry, FeatTrajectoryProjection, GitRefSnapshot } from '@cat-cafe/shared';
import { makeGitRefEntryId } from '@cat-cafe/shared';

const DAY = 24 * 60 * 60 * 1000;
const BASE = 1_700_000_000_000;

const f188Branch = 'fix/f188-phase-k-config-health-surface';
const f188Sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'; // 占位 SHA（mock）
const f188Thread = 'thread_mov0in6qfn2j2nvg';

/** F188 提包球 snapshot — lastThreadMessageAt < headCommitAt（猫提包走完一棒没回头）。 */
const f188Snapshot: GitRefSnapshot = {
  branchName: f188Branch,
  headCommitSha: f188Sha,
  headCommitAt: BASE,
  prNumber: null,
  prState: null,
  mergedToMain: null,
  prOpenedAt: null,
  prMergedAt: null,
  authorIdentity: 'opus-47',
  featureCandidates: ['F188'],
  associatedThreadIds: [f188Thread],
  lastThreadMessageAt: BASE - 49 * 60 * 1000,
  lastThreadActivityAt: BASE - 49 * 60 * 1000,
  joinProvenance: { confidence: 'high', joinedVia: ['branch_name_F#'] },
  collectedAt: BASE + 7 * DAY,
};

const f188Entries: FeatTrajectoryEntry[] = [
  {
    entryId: 'evt:f188-launched',
    subjectKey: 'feat:F188',
    featId: 'F188',
    at: BASE - 30 * DAY,
    kind: 'launched',
    source: 'event-stream',
    payload: { author: 'opus-47' },
  },
  {
    entryId: 'evt:f188-phase-ab',
    subjectKey: 'feat:F188',
    featId: 'F188',
    at: BASE - 20 * DAY,
    kind: 'phase_transition',
    source: 'event-stream',
    payload: { fromPhase: 'A', toPhase: 'B', author: 'opus-47' },
  },
  {
    entryId: 'stitch:F188:historical:verdict',
    subjectKey: 'feat:F188',
    featId: 'F188',
    at: BASE - 15 * DAY,
    kind: 'historical_stitched',
    source: 'historical-stitched',
    provenance: {
      confidence: 'medium',
      derivedFrom: ['feat_index', 'git_log', `thread:${f188Thread}`],
      note: 'Phase B 上线前考古拼接',
    },
    payload: { stitchType: 'verdict_backfill' },
  },
  {
    entryId: makeGitRefEntryId({ kind: 'branch_pushed', branchName: f188Branch, headCommitSha: f188Sha }),
    subjectKey: `git-ref:${f188Branch}`,
    featId: 'F188',
    at: BASE,
    kind: 'branch_pushed',
    source: 'git-ref-snapshot',
    payload: { snapshot: f188Snapshot, joinProvenance: f188Snapshot.joinProvenance },
  },
  {
    entryId: 'evt:f188-verdict',
    subjectKey: 'feat:F188',
    featId: 'F188',
    at: BASE + 2 * DAY,
    kind: 'verdict',
    source: 'event-stream',
    payload: { author: 'codex', note: '砚砚 verdict 方案 A' },
  },
  {
    entryId: makeGitRefEntryId({
      kind: 'branch_stale_unmerged',
      branchName: f188Branch,
      headCommitSha: f188Sha,
      staleBucket: '7d',
    }),
    subjectKey: `git-ref:${f188Branch}`,
    featId: 'F188',
    at: BASE + 7 * DAY,
    kind: 'branch_stale_unmerged',
    source: 'git-ref-snapshot',
    payload: { snapshot: f188Snapshot, joinProvenance: f188Snapshot.joinProvenance, staleBucket: '7d' },
  },
];

export const F188_MOCK_PROJECTION: FeatTrajectoryProjection = {
  featId: 'F188',
  entries: f188Entries,
  countsBySource: { 'event-stream': 3, 'git-ref-snapshot': 2, 'historical-stitched': 1 },
  countsByKind: {
    launched: 1,
    phase_transition: 1,
    historical_stitched: 1,
    branch_pushed: 1,
    verdict: 1,
    branch_stale_unmerged: 1,
  },
  appliedEntryCount: 6,
  createdAt: BASE - 30 * DAY,
  updatedAt: BASE + 7 * DAY,
};

/** F233 — 成功合并 case（emerald/cyan 全套，无提包球）。 */
const f233Branch = 'feat/f233-phase-c-closing';
const f233Sha = 'ba25164e29f8c7d6e5a4b3c2d1e0f9a8b7c6d5e4'; // 占位 SHA（mock）
const f233Snapshot: GitRefSnapshot = {
  branchName: f233Branch,
  headCommitSha: f233Sha,
  headCommitAt: BASE + 3 * DAY,
  prNumber: 2439,
  prState: 'merged',
  mergedToMain: true,
  prOpenedAt: BASE + 3 * DAY + 60 * 60 * 1000,
  prMergedAt: BASE + 4 * DAY,
  authorIdentity: 'opus-48',
  featureCandidates: ['F233'],
  associatedThreadIds: ['thread_mqcb399ktegukxdy'],
  lastThreadMessageAt: BASE + 4 * DAY,
  lastThreadActivityAt: BASE + 4 * DAY,
  joinProvenance: { confidence: 'high', joinedVia: ['feat_index', 'branch_name_F#'] },
  collectedAt: BASE + 5 * DAY,
};

export const F233_MOCK_PROJECTION: FeatTrajectoryProjection = {
  featId: 'F233',
  entries: [
    {
      entryId: 'evt:f233-launched',
      subjectKey: 'feat:F233',
      featId: 'F233',
      at: BASE,
      kind: 'launched',
      source: 'event-stream',
      payload: { author: 'opus-47' },
    },
    {
      entryId: makeGitRefEntryId({ kind: 'branch_pushed', branchName: f233Branch, headCommitSha: f233Sha }),
      subjectKey: `git-ref:${f233Branch}`,
      featId: 'F233',
      at: BASE + 3 * DAY,
      kind: 'branch_pushed',
      source: 'git-ref-snapshot',
      payload: { snapshot: f233Snapshot, joinProvenance: f233Snapshot.joinProvenance },
    },
    {
      entryId: makeGitRefEntryId({ kind: 'pr_opened', branchName: f233Branch, prNumber: 2439 }),
      subjectKey: `git-ref:${f233Branch}`,
      featId: 'F233',
      at: BASE + 3 * DAY + 60 * 60 * 1000,
      kind: 'pr_opened',
      source: 'git-ref-snapshot',
      payload: { snapshot: f233Snapshot, joinProvenance: f233Snapshot.joinProvenance },
    },
    {
      entryId: makeGitRefEntryId({ kind: 'branch_merged_to_main', branchName: f233Branch, prNumber: 2439 }),
      subjectKey: `git-ref:${f233Branch}`,
      featId: 'F233',
      at: BASE + 4 * DAY,
      kind: 'branch_merged_to_main',
      source: 'git-ref-snapshot',
      payload: { snapshot: f233Snapshot, joinProvenance: f233Snapshot.joinProvenance },
    },
  ],
  countsBySource: { 'event-stream': 1, 'git-ref-snapshot': 3, 'historical-stitched': 0 },
  countsByKind: { launched: 1, branch_pushed: 1, pr_opened: 1, branch_merged_to_main: 1 },
  appliedEntryCount: 4,
  createdAt: BASE,
  updatedAt: BASE + 5 * DAY,
};

export const MOCK_TRAJECTORIES: Record<string, FeatTrajectoryProjection> = {
  F188: F188_MOCK_PROJECTION,
  F233: F233_MOCK_PROJECTION,
};

export const MOCK_FEAT_IDS = ['F188', 'F192', 'F233'];
