#!/usr/bin/env node

// Classifies the outcome of `gh pr merge --squash --delete-branch` in a worktree.
//
// THE GAP (repeated harness miss #2567 opus48 + #2837 Sol):
//   In a feature worktree, `gh pr merge --delete-branch` can exit NONZERO even
//   though the REMOTE MERGE SUCCEEDED. gh squash-merges + deletes the remote
//   branch (done), then tries to check out the default branch (main) locally —
//   git refuses because main is held by the primary worktree ("main is already
//   used by <path>"). The nonzero exit is a LOCAL worktree-cleanup artifact,
//   NOT a merge failure. Blindly re-running `gh pr merge` then fails/confuses
//   because the PR is already MERGED.
//
//   DUAL GAP (cloud P2-2): the exit code is unreliable in BOTH directions — a merge
//   queue / auto-merge enqueues (or enables auto-merge) on exit 0 with the PR still
//   OPEN (not merged). So cleanup must be authorized by confirmed PR truth
//   (state=MERGED), NEVER by the exit code alone.
//
// This script turns "consult PR truth before trusting a merge exit code" from
// cat memory into a tested, fail-closed harness check.
//
// Usage:
//   MERGE_RC=0
//   gh pr merge 2567 --squash --delete-branch || MERGE_RC=$?
//   node scripts/classify-merge-outcome.mjs --pr 2567 --merge-exit-code "$MERGE_RC"
//     # exit 0  → PR truth confirms MERGED — proceed to cleanup (Step 7.5b/8)
//     # exit 1  → not merged: genuine failure / indeterminate — block, DO NOT retry
//     # exit 2  → bad invocation
//     # exit 3  → merge_pending (merge queue / auto-merge) — NOT a failure; wait for MERGED, don't cleanup
//
// Test fixture (bypass gh): CAT_CAFE_MERGE_OUTCOME_PR_FIXTURE=<path to gh-json file>
//
// Structured output: last stdout line is JSON.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Pure classifier. Decides what a merge exit code means given PR truth.
 * @param {{ mergeExitCode: number, prState: string|null|undefined }} input
 * @returns {{ outcome: string, remoteMerged: boolean, shouldRetryMerge: boolean,
 *             proceedToCleanup: boolean, exitCode: 0|1, reason: string }}
 */
export function classifyMergeOutcome({ mergeExitCode, prState }) {
  // Cleanup is authorized ONLY by confirmed PR truth (state=MERGED), never by the
  // exit code alone. P2-2 (cloud): `gh pr merge` exits 0 when a merge queue enqueues
  // the PR or auto-merge is enabled — the PR is NOT merged yet in those cases.
  if (prState === 'MERGED') {
    if (mergeExitCode === 0) {
      return {
        outcome: 'merged_clean',
        remoteMerged: true,
        shouldRetryMerge: false,
        proceedToCleanup: true,
        exitCode: 0,
        reason: 'gh pr merge exited 0 and PR state=MERGED — merge completed cleanly. Proceed to cleanup.',
      };
    }
    return {
      outcome: 'remote_merged_cleanup_needed',
      remoteMerged: true,
      shouldRetryMerge: false,
      proceedToCleanup: true,
      exitCode: 0,
      reason:
        'gh pr merge exited nonzero but PR state=MERGED — remote merge SUCCEEDED. ' +
        'Nonzero is a local worktree-cleanup artifact (main held by primary worktree). ' +
        'Proceed to cleanup (Step 7.5b/8); do NOT re-run gh pr merge.',
    };
  }

  // Not merged. A clean exit here means the merge is PENDING (queue / auto-merge),
  // not done — must not cleanup or re-run.
  if (mergeExitCode === 0) {
    if (prState === 'OPEN') {
      return {
        outcome: 'merge_pending',
        remoteMerged: false,
        shouldRetryMerge: false,
        proceedToCleanup: false,
        // P2-4: distinct exit code 3 — pending is NOT a failure. The merge-gate must wait
        // for the queue/auto-merge to reach MERGED, not abort as if the merge failed.
        exitCode: 3,
        reason:
          'gh pr merge exited 0 but PR state=OPEN — merge queue / auto-merge pending; PR not merged yet. ' +
          'This is NOT a failure: wait for the queue/auto-merge to reach MERGED, then cleanup. Do NOT cleanup, retry, or abort now.',
      };
    }
    return {
      outcome: 'indeterminate',
      remoteMerged: false,
      shouldRetryMerge: false,
      proceedToCleanup: false,
      exitCode: 1,
      reason:
        `gh pr merge exited 0 but PR state=${prState ?? 'unknown'} (not MERGED) — cannot confirm the merge ` +
        '(exit 0 alone is not proof; merge queue exits 0 on enqueue). Fail-closed: verify PR state manually before cleanup.',
    };
  }

  // Nonzero exit, not merged.
  if (prState === 'OPEN') {
    return {
      outcome: 'merge_failed',
      remoteMerged: false,
      shouldRetryMerge: false,
      proceedToCleanup: false,
      exitCode: 1,
      reason:
        'gh pr merge exited nonzero and PR state=OPEN — genuine merge failure. ' +
        'Block and diagnose (mergeable / mergeStateStatus / conflicts / gate); do NOT blindly retry.',
    };
  }

  if (prState === 'CLOSED') {
    return {
      outcome: 'merge_failed_pr_closed',
      remoteMerged: false,
      shouldRetryMerge: false,
      proceedToCleanup: false,
      exitCode: 1,
      reason:
        'gh pr merge exited nonzero and PR state=CLOSED (not merged) — anomalous. ' +
        'Block and investigate why the PR is closed without a merge.',
    };
  }

  // prState null / undefined / unexpected → fail-closed. NEVER assume merged.
  return {
    outcome: 'indeterminate',
    remoteMerged: false,
    shouldRetryMerge: false,
    proceedToCleanup: false,
    exitCode: 1,
    reason:
      `gh pr merge exited nonzero and PR truth is unavailable (state=${prState ?? 'unknown'}) — ` +
      'cannot classify. Fail-closed: block and verify PR state manually before any cleanup or retry.',
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) {
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      args[key.slice(2)] = true;
    } else {
      args[key.slice(2)] = value;
      i += 1;
    }
  }
  return args;
}

// Reads PR truth from `gh` (or a fixture file for tests). Returns parsed gh JSON,
// or an object with state:null when gh/parse fails (classifier fail-closes on it).
function readPrTruth(prNumber) {
  const fixturePath = process.env.CAT_CAFE_MERGE_OUTCOME_PR_FIXTURE;
  let raw;
  if (fixturePath) {
    raw = readFileSync(fixturePath, 'utf8');
  } else {
    try {
      raw = execFileSync(
        'gh',
        ['pr', 'view', String(prNumber), '--json', 'state,mergedAt,mergeCommit,mergeable,mergeStateStatus'],
        { encoding: 'utf8' },
      );
    } catch (error) {
      return { state: null, _ghError: String(error.stderr ?? error.message ?? error).trim() };
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { state: null, _parseError: true };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const prNumber = args.pr;
  const mergeExitCode = Number(args['merge-exit-code']);
  if (!prNumber || !Number.isInteger(mergeExitCode)) {
    console.error('usage: classify-merge-outcome.mjs --pr <N> --merge-exit-code <code>');
    process.exit(2);
  }

  // Always consult PR truth — exit 0 is NOT proof of merge. A merge queue enqueues
  // (or enables auto-merge) on exit 0 with the PR still OPEN. See classifyMergeOutcome P2-2.
  const prTruth = readPrTruth(prNumber);
  const result = classifyMergeOutcome({ mergeExitCode, prState: prTruth.state });

  // merge_pending is NOT a failure — use a waiting glyph, never the ❌ failure glyph (P2-4).
  let icon = '❌';
  if (result.proceedToCleanup) {
    icon = '✅';
  } else if (result.outcome === 'merge_pending') {
    icon = '⏳';
  }
  console.log(`${icon} merge-outcome: ${result.outcome}`);
  console.log(`   ${result.reason}`);
  if (prTruth._ghError) {
    console.log(`   (gh pr view failed: ${prTruth._ghError})`);
  }
  // last line = JSON (matches check-hotfix-pattern.mjs convention)
  console.log(
    JSON.stringify({
      ...result,
      pr: Number(prNumber),
      prState: prTruth.state ?? null,
      mergedAt: prTruth.mergedAt ?? null,
      mergeCommit: prTruth.mergeCommit?.oid ?? null,
    }),
  );
  process.exit(result.exitCode);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}
