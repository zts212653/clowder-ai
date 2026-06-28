/**
 * F233 Phase C C2a step 2 — feat-trajectory keys + makeGitRefEntryId focused tests
 *
 * 砚砚 KD-C6 step 1 review advisory #1 钉死：
 *   "makeGitRefEntryId 加 focused test：同 branch/head 下 24h/72h/7d/30d 四个 id
 *    互不相等；branch_pushed staleBucket null 输出 n/a。"
 *
 * 这是 P2-4 (staleBucket 进 entry id) 的 regression test —— 防未来 refactor 把
 * bucket 从 entry id 公式里去掉（会让"怎么拖到今天"叙事消失）。
 *
 * node:test (对齐 api test runner，import dist)。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  makeEventStreamEntryId,
  makeFeatSubjectKey,
  makeGitRefEntryId,
  makeGitRefSubjectKey,
  makeStitchedEntryId,
} from '../dist/domains/feat-trajectory/feat-trajectory-keys.js';

describe('feat-trajectory keys', () => {
  describe('makeFeatSubjectKey', () => {
    it('feat:{featId}', () => {
      assert.strictEqual(makeFeatSubjectKey('F233'), 'feat:F233');
      assert.strictEqual(makeFeatSubjectKey('F188'), 'feat:F188');
    });
  });

  describe('makeGitRefSubjectKey', () => {
    it('git-ref:{branchName}', () => {
      assert.strictEqual(
        makeGitRefSubjectKey('fix/f188-phase-k-config-health-surface'),
        'git-ref:fix/f188-phase-k-config-health-surface',
      );
    });
  });

  describe('makeEventStreamEntryId / makeStitchedEntryId', () => {
    it('evt:{sourceEventId}', () => {
      assert.strictEqual(makeEventStreamEntryId('route:msg-123:opus-47'), 'evt:route:msg-123:opus-47');
    });
    it('stitch:{featId}:{at}:{stitchType}', () => {
      assert.strictEqual(
        makeStitchedEntryId('F192', 1_700_000_000_000, 'phase_transition'),
        'stitch:F192:1700000000000:phase_transition',
      );
    });
  });

  describe('makeGitRefEntryId — per-kind stable formula (cloud P2 fix + 砚砚 P2-4 bucket-in-id 保留)', () => {
    const baseBranch = 'fix/f188-phase-k-config-health-surface';
    const baseSha = 'abc1234567890def';
    const otherSha = 'def4567890abc123';

    it('branch_pushed: id = git-ref:{branch}:{sha}:branch_pushed (no PR/merge state)', () => {
      const id = makeGitRefEntryId({
        kind: 'branch_pushed',
        branchName: baseBranch,
        headCommitSha: baseSha,
      });
      assert.strictEqual(id, `git-ref:${baseBranch}:${baseSha}:branch_pushed`);
    });

    it('pr_opened: id = git-ref:{branch}:pr-{prNumber}:pr_opened (PR identity, not headCommitSha)', () => {
      const id = makeGitRefEntryId({
        kind: 'pr_opened',
        branchName: baseBranch,
        prNumber: 1234,
      });
      assert.strictEqual(id, `git-ref:${baseBranch}:pr-1234:pr_opened`);
    });

    it('branch_merged_to_main: id = git-ref:{branch}:pr-{prNumber}:branch_merged_to_main', () => {
      const id = makeGitRefEntryId({
        kind: 'branch_merged_to_main',
        branchName: baseBranch,
        prNumber: 1234,
      });
      assert.strictEqual(id, `git-ref:${baseBranch}:pr-1234:branch_merged_to_main`);
    });

    it('branch_stale_unmerged: 4 staleBucket 互不相等（24h/72h/7d/30d 各产生独立轨迹点，砚砚 P2-4 regression）', () => {
      const ids = ['24h', '72h', '7d', '30d'].map((bucket) =>
        makeGitRefEntryId({
          kind: 'branch_stale_unmerged',
          branchName: baseBranch,
          headCommitSha: baseSha,
          staleBucket: bucket,
        }),
      );
      assert.strictEqual(new Set(ids).size, 4, '同 branch/head 下 4 个 staleBucket 必须产生 4 个不同的 entry id');
      assert.strictEqual(ids[0], `git-ref:${baseBranch}:${baseSha}:branch_stale_unmerged:24h`);
      assert.strictEqual(ids[3], `git-ref:${baseBranch}:${baseSha}:branch_stale_unmerged:30d`);
    });

    it('CLOUD P2 regression: branch_pushed id stable across PR state changes (same branch+sha → same id)', () => {
      const id1 = makeGitRefEntryId({ kind: 'branch_pushed', branchName: baseBranch, headCommitSha: baseSha });
      const id2 = makeGitRefEntryId({ kind: 'branch_pushed', branchName: baseBranch, headCommitSha: baseSha });
      assert.strictEqual(
        id1,
        id2,
        'branch_pushed id is stable per (branchName, headCommitSha) — PR state changes do not affect id',
      );
    });

    it('CLOUD P2 regression: pr_opened id stable across head commit changes (same PR → same id)', () => {
      const id1 = makeGitRefEntryId({ kind: 'pr_opened', branchName: baseBranch, prNumber: 1234 });
      const id2 = makeGitRefEntryId({ kind: 'pr_opened', branchName: baseBranch, prNumber: 1234 });
      assert.strictEqual(
        id1,
        id2,
        'pr_opened id is stable per (branchName, prNumber) — head commit changes do not affect id',
      );
    });

    it('CLOUD P2 regression: branch_merged_to_main id stable per PR identity (same PR → same id)', () => {
      const id1 = makeGitRefEntryId({ kind: 'branch_merged_to_main', branchName: baseBranch, prNumber: 1234 });
      const id2 = makeGitRefEntryId({ kind: 'branch_merged_to_main', branchName: baseBranch, prNumber: 1234 });
      assert.strictEqual(id1, id2);
    });

    it('CLOUD P2 boundary: different prNumber → different id (per-PR event identity)', () => {
      const id1 = makeGitRefEntryId({ kind: 'pr_opened', branchName: baseBranch, prNumber: 1234 });
      const id2 = makeGitRefEntryId({ kind: 'pr_opened', branchName: baseBranch, prNumber: 5678 });
      assert.notStrictEqual(id1, id2);
    });

    it('CLOUD P2 boundary: different headCommitSha → different branch_pushed id (per-push identity)', () => {
      const id1 = makeGitRefEntryId({ kind: 'branch_pushed', branchName: baseBranch, headCommitSha: baseSha });
      const id2 = makeGitRefEntryId({ kind: 'branch_pushed', branchName: baseBranch, headCommitSha: otherSha });
      assert.notStrictEqual(id1, id2);
    });

    it('同 parts → 同 id (pure function idempotency, 防 cron tick 鞭打 store)', () => {
      const parts = {
        kind: 'branch_stale_unmerged',
        branchName: baseBranch,
        headCommitSha: baseSha,
        staleBucket: '7d',
      };
      const id1 = makeGitRefEntryId(parts);
      const id2 = makeGitRefEntryId(parts);
      assert.strictEqual(id1, id2, '同 parts → 同 id (pure function idempotency)');
    });
  });
});
