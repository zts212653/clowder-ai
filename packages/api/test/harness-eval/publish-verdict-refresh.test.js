import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { handleRefreshPublishedVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/refresh-published-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';

describe('publish-verdict refresh lifecycle', () => {
  let harnessFeedbackRoot;

  before(() => {
    harnessFeedbackRoot = setupHarnessFeedback();
  });

  after(() => {
    rmSync(harnessFeedbackRoot, { recursive: true, force: true });
  });

  it('derives the verdict branch and refreshes only through the publisher lifecycle', async () => {
    const calls = [];
    const result = await handleRefreshPublishedVerdict(
      {
        harnessFeedbackRoot,
        gitPublisher: {
          async publishOnIsolatedWorktree() {
            throw new Error('publish path must not run');
          },
          async refreshPublishedVerdictPr(opts) {
            calls.push(opts);
            return {
              outcome: 'updated',
              previousHeadSha: opts.expectedHeadSha,
              commitSha: 'b'.repeat(40),
              baseSha: 'c'.repeat(40),
              prUrl: 'https://github.com/zts212653/clowder-ai/pull/9999',
            };
          },
        },
      },
      {
        domain: 'eval:a2a',
        catId: 'codex',
        verdictId: '2026-08-02-eval-a2a-refresh',
        expectedHeadSha: 'a'.repeat(40),
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].branchName, 'verdict/auto/eval-a2a/2026-08-02-eval-a2a-refresh');
    assert.equal(calls[0].verdictId, '2026-08-02-eval-a2a-refresh');
    assert.equal(calls[0].expectedHeadSha, 'a'.repeat(40));
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'updated');
    assert.equal(result.commitSha, 'b'.repeat(40));
  });

  it('rejects a stale or unsafe refresh request before the publisher runs', async () => {
    let calls = 0;
    const gitPublisher = {
      async publishOnIsolatedWorktree() {
        throw new Error('unreachable');
      },
      async refreshPublishedVerdictPr() {
        calls++;
        throw new Error('unreachable');
      },
    };

    const unsafe = await handleRefreshPublishedVerdict(
      { harnessFeedbackRoot, gitPublisher },
      {
        domain: 'eval:a2a',
        catId: 'codex',
        verdictId: '../other-branch',
        expectedHeadSha: 'a'.repeat(40),
      },
    );
    assert.deepEqual(unsafe, {
      status: 400,
      error: 'invalid_verdict_id',
      detail: 'verdictId must be a lowercase alphanumeric slug with optional hyphens',
    });

    const wrongCat = await handleRefreshPublishedVerdict(
      { harnessFeedbackRoot, gitPublisher },
      {
        domain: 'eval:a2a',
        catId: 'opus',
        verdictId: '2026-08-02-eval-a2a-refresh',
        expectedHeadSha: 'a'.repeat(40),
      },
    );
    assert.equal(wrongCat.status, 403);
    assert.equal(wrongCat.error, 'not_allowed');
    assert.equal(calls, 0);
  });

  it('maps exact-head and derived-census conflicts to actionable 409 responses', async () => {
    for (const [message, error] of [
      ['verdict_pr_head_mismatch: expected a, found b', 'verdict_pr_head_mismatch'],
      ['verdict_pr_scope_invalid: docs/ROADMAP.md', 'verdict_pr_scope_invalid'],
      ['verdict_pr_refresh_conflict: packages/api/src/index.ts', 'verdict_pr_refresh_conflict'],
    ]) {
      const result = await handleRefreshPublishedVerdict(
        {
          harnessFeedbackRoot,
          gitPublisher: {
            async publishOnIsolatedWorktree() {
              throw new Error('unreachable');
            },
            async refreshPublishedVerdictPr() {
              throw new Error(message);
            },
          },
        },
        {
          domain: 'eval:a2a',
          catId: 'codex',
          verdictId: '2026-08-02-eval-a2a-refresh',
          expectedHeadSha: 'a'.repeat(40),
        },
      );
      assert.equal(result.status, 409);
      assert.equal(result.error, error);
    }
  });
});
