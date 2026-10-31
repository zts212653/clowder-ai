#!/usr/bin/env node

// Unit tests for merge-outcome classification (merge-gate Step 7 hardening).
//
// Context: `gh pr merge --squash --delete-branch` in a feature worktree can exit
// NONZERO even though the remote merge SUCCEEDED — gh deletes the remote branch,
// then tries to check out the default branch (main) locally, which git refuses
// because main is held by the primary worktree. The nonzero exit is a LOCAL
// worktree-cleanup artifact, NOT a merge failure.
//
// Repeated harness gap: #2567 (opus48 first-hand) + #2837 (Sol). Before this,
// classification lived only in cat memory. These tests lock it into code.
//
// Core scenarios (from F128 handoff):
//   - merge cmd nonzero + PR truth MERGED     → remote_merged_cleanup_needed (no retry)
//   - merge cmd nonzero + PR truth NOT merged → blocking failure

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyMergeOutcome } from './classify-merge-outcome.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./classify-merge-outcome.mjs', import.meta.url));

// Runs the CLI with a PR-truth fixture injected, returns { code, stdout, lastJson }.
function runCli({ prState, mergeExitCode, prJson }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'merge-outcome-'));
  const fixture = path.join(dir, 'pr.json');
  writeFileSync(fixture, prJson ?? JSON.stringify({ state: prState }), 'utf8');
  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync('node', [SCRIPT_PATH, '--pr', '2567', '--merge-exit-code', String(mergeExitCode)], {
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_MERGE_OUTCOME_PR_FIXTURE: fixture },
    });
  } catch (error) {
    code = error.status ?? 1;
    stdout = String(error.stdout ?? '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const lines = stdout.trim().split('\n');
  return { code, stdout, lastJson: JSON.parse(lines[lines.length - 1]) };
}

describe('classifyMergeOutcome — pure classification', () => {
  it('exit 0: clean merge, proceed to cleanup', () => {
    const r = classifyMergeOutcome({ mergeExitCode: 0, prState: 'MERGED' });
    assert.equal(r.outcome, 'merged_clean');
    assert.equal(r.remoteMerged, true);
    assert.equal(r.proceedToCleanup, true);
    assert.equal(r.exitCode, 0);
    assert.equal(r.shouldRetryMerge, false);
  });

  // P2-2 (cloud): exit 0 is NOT authoritative. `gh pr merge --help` — merge queue
  // enqueues (or enables auto-merge) on exit 0 without state=MERGED. Must confirm PR truth.
  it('exit 0 without MERGED truth → indeterminate, fail-closed (queue/auto-merge)', () => {
    const r = classifyMergeOutcome({ mergeExitCode: 0, prState: null });
    assert.equal(r.outcome, 'indeterminate');
    assert.equal(r.remoteMerged, false, 'exit 0 alone does not prove MERGED — merge queue exits 0 on enqueue');
    assert.equal(r.proceedToCleanup, false);
    assert.equal(r.exitCode, 1);
  });

  // P2-2 (cloud): exit 0 + OPEN = merge queue / auto-merge pending, PR not merged yet.
  it('exit 0 + PR OPEN → merge_pending (queue/auto-merge), do not cleanup', () => {
    const r = classifyMergeOutcome({ mergeExitCode: 0, prState: 'OPEN' });
    assert.equal(r.outcome, 'merge_pending');
    assert.equal(r.remoteMerged, false);
    assert.equal(r.proceedToCleanup, false, 'still queued — cleanup would delete branch of an unmerged PR');
    assert.equal(r.exitCode, 3, 'P2-4: pending gets its own exit code (3), NOT the failure exit 1');
    assert.equal(r.shouldRetryMerge, false);
  });

  // CORE SCENARIO 1 (#2567 / #2837): worktree false-failure
  it('nonzero + PR MERGED: remote merged, cleanup needed, NEVER retry', () => {
    const r = classifyMergeOutcome({ mergeExitCode: 1, prState: 'MERGED' });
    assert.equal(r.outcome, 'remote_merged_cleanup_needed');
    assert.equal(r.remoteMerged, true);
    assert.equal(r.proceedToCleanup, true);
    assert.equal(r.exitCode, 0, 'remote success → gate proceeds to cleanup, not blocked');
    assert.equal(r.shouldRetryMerge, false, 'PR already MERGED — retrying gh pr merge is wrong');
  });

  it('nonzero + PR MERGED works for any nonzero code (128 = git fatal)', () => {
    const r = classifyMergeOutcome({ mergeExitCode: 128, prState: 'MERGED' });
    assert.equal(r.outcome, 'remote_merged_cleanup_needed');
    assert.equal(r.remoteMerged, true);
    assert.equal(r.exitCode, 0);
  });

  // CORE SCENARIO 2: genuine merge failure
  it('nonzero + PR OPEN: genuine failure, block, do not retry blindly', () => {
    const r = classifyMergeOutcome({ mergeExitCode: 1, prState: 'OPEN' });
    assert.equal(r.outcome, 'merge_failed');
    assert.equal(r.remoteMerged, false);
    assert.equal(r.proceedToCleanup, false);
    assert.equal(r.exitCode, 1, 'genuine failure → gate blocks');
    assert.equal(r.shouldRetryMerge, false, 'block for human diagnosis, not blind retry');
  });

  it('nonzero + PR CLOSED (not merged): anomalous, block', () => {
    const r = classifyMergeOutcome({ mergeExitCode: 1, prState: 'CLOSED' });
    assert.equal(r.outcome, 'merge_failed_pr_closed');
    assert.equal(r.remoteMerged, false);
    assert.equal(r.proceedToCleanup, false);
    assert.equal(r.exitCode, 1);
  });

  // FAIL-CLOSED: PR truth unavailable → never assume merged
  it('nonzero + prState null (gh view failed): indeterminate, fail-closed block', () => {
    const r = classifyMergeOutcome({ mergeExitCode: 1, prState: null });
    assert.equal(r.outcome, 'indeterminate');
    assert.equal(r.remoteMerged, false, 'MUST NOT assume merged when truth is unknown');
    assert.equal(r.proceedToCleanup, false);
    assert.equal(r.exitCode, 1);
  });

  it('nonzero + prState undefined: indeterminate, fail-closed', () => {
    const r = classifyMergeOutcome({ mergeExitCode: 1, prState: undefined });
    assert.equal(r.outcome, 'indeterminate');
    assert.equal(r.remoteMerged, false);
    assert.equal(r.exitCode, 1);
  });

  it('nonzero + unexpected prState string: indeterminate, fail-closed', () => {
    const r = classifyMergeOutcome({ mergeExitCode: 1, prState: 'WEIRD_STATE' });
    assert.equal(r.outcome, 'indeterminate');
    assert.equal(r.remoteMerged, false);
    assert.equal(r.exitCode, 1);
  });
});

describe('classifyMergeOutcome — invariants', () => {
  const allInputs = [
    { mergeExitCode: 0, prState: 'MERGED' },
    { mergeExitCode: 0, prState: 'OPEN' },
    { mergeExitCode: 0, prState: 'CLOSED' },
    { mergeExitCode: 0, prState: null },
    { mergeExitCode: 1, prState: 'MERGED' },
    { mergeExitCode: 1, prState: 'OPEN' },
    { mergeExitCode: 1, prState: 'CLOSED' },
    { mergeExitCode: 1, prState: null },
    { mergeExitCode: 128, prState: 'MERGED' },
  ];

  it('shouldRetryMerge is ALWAYS false (retry is never the fix for this gap)', () => {
    for (const input of allInputs) {
      const r = classifyMergeOutcome(input);
      assert.equal(r.shouldRetryMerge, false, `retry must stay false for ${JSON.stringify(input)}`);
    }
  });

  it('proceedToCleanup iff remoteMerged (only cleanup after remote success)', () => {
    for (const input of allInputs) {
      const r = classifyMergeOutcome(input);
      assert.equal(r.proceedToCleanup, r.remoteMerged, `mismatch for ${JSON.stringify(input)}`);
    }
  });

  // P2-2 (cloud): the exit code never authorizes cleanup on its own — only confirmed
  // PR truth (state=MERGED) does. Guards against merge-queue exit-0-not-merged.
  it('proceedToCleanup iff prState === MERGED (only cleanup on confirmed merge truth)', () => {
    for (const input of allInputs) {
      const r = classifyMergeOutcome(input);
      assert.equal(r.proceedToCleanup, input.prState === 'MERGED', `mismatch for ${JSON.stringify(input)}`);
    }
  });

  it('exitCode 0 iff proceedToCleanup (cleanup ⟺ exit 0)', () => {
    for (const input of allInputs) {
      const r = classifyMergeOutcome(input);
      assert.equal(r.exitCode === 0, r.proceedToCleanup, `mismatch for ${JSON.stringify(input)}`);
    }
  });

  // P2-4 (cloud): pending is a THIRD outcome — not cleanup (0), not failure (1) — so the
  // merge-gate can wait for the queue instead of aborting. Distinct exit code 3.
  it('exit code is three-way: 0 cleanup / 3 merge_pending / 1 block', () => {
    for (const input of allInputs) {
      const r = classifyMergeOutcome(input);
      if (r.outcome === 'merge_pending') {
        assert.equal(r.exitCode, 3, `merge_pending must exit 3 (not failure) for ${JSON.stringify(input)}`);
      } else if (r.proceedToCleanup) {
        assert.equal(r.exitCode, 0, `cleanup must exit 0 for ${JSON.stringify(input)}`);
      } else {
        assert.equal(r.exitCode, 1, `genuine failure/indeterminate must exit 1 for ${JSON.stringify(input)}`);
      }
    }
  });

  it('every result carries a non-empty human-readable reason', () => {
    for (const input of allInputs) {
      const r = classifyMergeOutcome(input);
      assert.equal(typeof r.reason, 'string');
      assert.ok(r.reason.length > 0, `empty reason for ${JSON.stringify(input)}`);
    }
  });
});

describe('classify-merge-outcome CLI (fixture-injected PR truth)', () => {
  it('nonzero + fixture MERGED → exit 0, remote_merged_cleanup_needed', () => {
    const { code, lastJson } = runCli({ prState: 'MERGED', mergeExitCode: 1 });
    assert.equal(code, 0, 'remote merged → CLI exits 0 so gate proceeds to cleanup');
    assert.equal(lastJson.outcome, 'remote_merged_cleanup_needed');
    assert.equal(lastJson.remoteMerged, true);
    assert.equal(lastJson.shouldRetryMerge, false);
    assert.equal(lastJson.pr, 2567);
    assert.equal(lastJson.prState, 'MERGED');
  });

  it('nonzero + fixture OPEN → exit 1, merge_failed', () => {
    const { code, lastJson } = runCli({ prState: 'OPEN', mergeExitCode: 1 });
    assert.equal(code, 1, 'genuine failure → CLI exits nonzero so gate blocks');
    assert.equal(lastJson.outcome, 'merge_failed');
    assert.equal(lastJson.remoteMerged, false);
  });

  it('exit 0 + fixture MERGED → merged_clean, exit 0', () => {
    const { code, lastJson } = runCli({ prState: 'MERGED', mergeExitCode: 0 });
    assert.equal(code, 0);
    assert.equal(lastJson.outcome, 'merged_clean');
    assert.equal(lastJson.remoteMerged, true);
  });

  it('exit 0 + fixture OPEN → merge_pending, exit 3 (P2-4: pending has its own exit code, not failure)', () => {
    const { code, lastJson } = runCli({ prState: 'OPEN', mergeExitCode: 0 });
    assert.equal(code, 3);
    assert.equal(lastJson.outcome, 'merge_pending');
    assert.equal(lastJson.remoteMerged, false);
  });

  it('extracts mergedAt + mergeCommit oid from gh json shape', () => {
    const prJson = JSON.stringify({
      state: 'MERGED',
      mergedAt: '2026-07-09T00:00:00Z',
      mergeCommit: { oid: '2422385e' },
    });
    const { lastJson } = runCli({ mergeExitCode: 1, prJson });
    assert.equal(lastJson.mergedAt, '2026-07-09T00:00:00Z');
    assert.equal(lastJson.mergeCommit, '2422385e');
  });

  it('malformed fixture JSON on nonzero exit → fail-closed indeterminate, exit 1', () => {
    const { code, lastJson } = runCli({ mergeExitCode: 1, prJson: 'not-json{' });
    assert.equal(code, 1);
    assert.equal(lastJson.outcome, 'indeterminate');
    assert.equal(lastJson.remoteMerged, false);
  });

  it('missing --pr → usage error, exit 2', () => {
    let code = 0;
    try {
      execFileSync('node', [SCRIPT_PATH, '--merge-exit-code', '1'], { encoding: 'utf8' });
    } catch (error) {
      code = error.status ?? 1;
    }
    assert.equal(code, 2);
  });
});
