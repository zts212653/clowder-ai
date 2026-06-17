/**
 * F168 Phase C — C0.3 RepoCommentPollTaskSpec 单元测试
 *
 * repo 级追评轮询：覆盖所有 issue 的追评（含未-routed / 未注册 tracking 的 issue），
 * 灭 IssueCommentTaskSpec 的 per-tracked-issue 盲区（只轮询已注册 issue_tracking task 的 issue）。
 *
 * 复用基础（与 webhook + IssueCommentTaskSpec 三路收敛）：
 *   - issueCommentEventId 去重键 `comment:{repo}#{issueNumber}:{commentId}` → 同一 comment 只 append 一次
 *   - CommunityEvent kind 'issue.commented' + classification 'informational'
 *   - 双 cursor 语义：append 成功推进 collection cursor（INV-9）
 *   - sourceEventId 去重（INV-10）
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

const { repoCommentPollTaskSpec } = await import(
  '../dist/infrastructure/connectors/github-repo-event/RepoCommentPollTaskSpec.js'
);

const makeComment = (overrides = {}) => ({
  issueNumber: 42,
  commentId: 1001,
  author: 'external-user',
  authorAssociation: 'NONE',
  body: 'any update?',
  updatedAt: '2026-06-13T10:00:00Z',
  isPullRequest: false,
  ...overrides,
});

describe('RepoCommentPollTaskSpec (C0.3 repo-comment poller)', () => {
  let eventLog;
  let projector;
  let cursors;
  let fetchRepoComments;
  let log;

  beforeEach(() => {
    const appended = new Set();
    eventLog = {
      append: mock.fn(async (e) => {
        if (appended.has(e.sourceEventId)) return { appended: false };
        appended.add(e.sourceEventId);
        return { appended: true };
      }),
    };
    projector = { apply: mock.fn(async () => {}) };
    cursors = new Map();
    // Steady-state: baseline already established, so existing tests exercise the fetch
    // path. The first-poll baseline (no cursor) is covered by its own test below.
    cursors.set('owner/repo', '2026-06-13T00:00:00Z');
    fetchRepoComments = mock.fn(async () => [makeComment()]);
    log = { info() {}, warn() {}, error() {} };
  });

  const makeSpec = (overrides = {}) =>
    repoCommentPollTaskSpec({
      eventLog,
      projector,
      fetchRepoComments,
      repoAllowlist: ['owner/repo'],
      readCursor: async (repo) => cursors.get(repo),
      writeCursor: async (repo, c) => {
        cursors.set(repo, c);
      },
      log,
      ...overrides,
    });

  test('gate appends issue.commented for repo-level comments (covers un-routed issues)', async () => {
    const spec = makeSpec();
    await spec.admission.gate();
    // repo 级 fetch（不依赖 tracking task）= 灭盲区核心
    assert.equal(fetchRepoComments.mock.callCount(), 1);
    assert.equal(fetchRepoComments.mock.calls[0].arguments[0], 'owner/repo');
    assert.equal(eventLog.append.mock.callCount(), 1);
    const ev = eventLog.append.mock.calls[0].arguments[0];
    assert.equal(ev.kind, 'issue.commented');
    assert.equal(ev.classification, 'informational');
    // 复用 issueCommentEventId 去重键（与 webhook/per-issue 三路收敛）
    assert.equal(ev.sourceEventId, 'comment:owner/repo#42:1001');
    assert.equal(ev.subjectKey, 'issue:owner/repo#42');
  });

  test('advances per-repo cursor to max comment updatedAt (INV-9)', async () => {
    await makeSpec().admission.gate();
    assert.equal(cursors.get('owner/repo'), '2026-06-13T10:00:00Z');
  });

  test('dedup: duplicate comment (append:false) still advances cursor — no polling churn (INV-10)', async () => {
    await makeSpec().admission.gate();
    const firstCursor = cursors.get('owner/repo');
    // 同 comment 第二轮 → append:false（去重）→ cursor 不回退、不重复消费
    await makeSpec().admission.gate();
    assert.equal(cursors.get('owner/repo'), firstCursor);
  });

  test('projector applied only on appended:true (skip duplicates — temporal ordering)', async () => {
    await makeSpec().admission.gate();
    assert.equal(projector.apply.mock.callCount(), 1);
    await makeSpec().admission.gate();
    assert.equal(projector.apply.mock.callCount(), 1);
  });

  test('queries fetchRepoComments with a 1s overlap on the cursor (P2 cloud review)', async () => {
    cursors.set('owner/repo', '2026-06-13T09:00:00Z');
    await makeSpec().admission.gate();
    // 1s overlap: GitHub `since` is after-timestamp + second-granularity; re-query 1s
    // earlier so a same-second comment (created after the prior page) isn't skipped forever.
    // Dedup by issueCommentEventId absorbs the re-fetched overlap; cursor still stores exact max.
    assert.equal(fetchRepoComments.mock.calls[0].arguments[1], '2026-06-13T08:59:59.000Z');
  });

  test('first poll (no cursor) baselines without backfilling repo history (P1-2 cloud review)', async () => {
    cursors.delete('owner/repo'); // first enable / new repo / lost cursor → no cursor stored
    await makeSpec().admission.gate();
    // Baseline must NOT fetch the entire historical comment set (poll storm)...
    assert.equal(fetchRepoComments.mock.callCount(), 0, 'baseline must not fetch all history');
    // ...and must NOT append any historical comment to the event log...
    assert.equal(eventLog.append.mock.callCount(), 0, 'baseline must not backfill history');
    // ...but MUST establish the cursor so the next poll captures only NEW comments forward.
    const baselined = cursors.get('owner/repo');
    assert.ok(baselined, 'baseline must establish a cursor');
    assert.match(baselined, /^\d{4}-\d{2}-\d{2}T/, 'baseline cursor is an ISO-8601 timestamp');
  });

  test('advances cursor over PR comments without appending them (anti-churn — cloud review R4 P2)', async () => {
    // The repo-level /issues/comments endpoint surfaces PR conversation comments too (PRs
    // are issues in GitHub). They belong to the ReviewFeedbackTaskSpec track, so they must
    // NOT be appended/projected here — but the cursor MUST still advance past them, else a
    // repo with PR activity but no NEW issue comments would re-fetch the same pages every
    // 60s tick forever (avoidable API churn / rate-limit risk).
    fetchRepoComments = mock.fn(async () => [
      makeComment({ commentId: 2002, updatedAt: '2026-06-13T11:00:00Z', isPullRequest: true }),
    ]);
    await makeSpec().admission.gate();
    assert.equal(eventLog.append.mock.callCount(), 0, 'PR comment must not be appended');
    assert.equal(projector.apply.mock.callCount(), 0, 'PR comment must not be projected');
    // ...but the cursor advances past the PR comment so the re-fetch loop ends.
    assert.equal(cursors.get('owner/repo'), '2026-06-13T11:00:00Z');
  });

  test('mixed issue + PR comments: appends only the issue comment, cursor = max over ALL (incl PR)', async () => {
    fetchRepoComments = mock.fn(async () => [
      makeComment({ commentId: 1001, updatedAt: '2026-06-13T11:00:00Z', isPullRequest: false }),
      makeComment({ commentId: 2002, issueNumber: 99, updatedAt: '2026-06-13T12:00:00Z', isPullRequest: true }),
    ]);
    await makeSpec().admission.gate();
    // Only the issue comment is appended (the later PR comment is skipped).
    assert.equal(eventLog.append.mock.callCount(), 1, 'only the issue comment is appended');
    assert.equal(eventLog.append.mock.calls[0].arguments[0].sourceEventId, 'comment:owner/repo#42:1001');
    // Cursor = max updatedAt over ALL fetched comments, including the later PR comment.
    assert.equal(cursors.get('owner/repo'), '2026-06-13T12:00:00Z');
  });
});
