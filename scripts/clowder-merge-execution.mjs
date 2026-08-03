#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CLOWDER_REPOSITORY = 'zts212653/clowder-ai';
const CAFE_MESSAGE_ID = /^\d{16,}-\d{6}-[0-9a-f]{8}$/i;
const PASSING_CHECK_RESULTS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
const PENDING_CHECK_RESULTS = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING']);

function blocked(reasonCode, nextAction, requiresNewAuthorization, detail) {
  return {
    outcome: 'blocked',
    reasonCode,
    nextAction,
    requiresNewAuthorization,
    authorizationContinuity: 'invalid',
    command: null,
    detail,
  };
}

function canonicalSubjectRef(repository, prNumber) {
  return `pr:${repository.toLowerCase()}#${prNumber}`;
}

function classifyStatusChecks(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) return 'unavailable';

  let sawPending = false;
  for (const check of statusCheckRollup) {
    const result = String(check?.conclusion ?? check?.state ?? check?.status ?? '').toUpperCase();
    const status = String(check?.status ?? '').toUpperCase();
    if (PASSING_CHECK_RESULTS.has(result)) continue;
    if (PENDING_CHECK_RESULTS.has(result) || (status && status !== 'COMPLETED')) {
      sawPending = true;
      continue;
    }
    return 'failed';
  }
  return sawPending ? 'pending' : 'passed';
}

function validateInvocation(repository, prNumber, expectedHead) {
  const normalizedRepository = String(repository ?? '').toLowerCase();
  if (normalizedRepository !== CLOWDER_REPOSITORY) {
    return blocked(
      'unsupported_repository',
      'use_repository_merge_policy',
      false,
      `This execution guard only owns ${CLOWDER_REPOSITORY}.`,
    );
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return blocked('invalid_pr_number', 'fix_invocation', false, 'PR number must be a positive integer.');
  }
  if (!/^[0-9a-f]{40}$/i.test(String(expectedHead ?? ''))) {
    return blocked('invalid_expected_head', 'fix_invocation', false, 'Expected HEAD must be a full 40-character SHA.');
  }
  return { normalizedRepository };
}

function validateAuthorization(authorization, expectedSubject, expectedHead) {
  if (!authorization?.sourceMessageId?.trim()) {
    return blocked(
      'authorization_source_missing',
      'request_authorization',
      true,
      'A durable, independently grounded operator authorization messageId is required.',
    );
  }
  if (!CAFE_MESSAGE_ID.test(authorization.sourceMessageId)) {
    return blocked(
      'authorization_source_invalid',
      'request_authorization',
      true,
      'Authorization source must be a canonical Clowder AI messageId, not narrative text.',
    );
  }
  if (String(authorization.subjectRef ?? '').toLowerCase() !== expectedSubject) {
    return blocked(
      'authorization_subject_mismatch',
      'request_authorization',
      true,
      `Authorization subject must be ${expectedSubject}.`,
    );
  }
  if (authorization.scope === 'pull_request') {
    return {
      authorizationContinuity:
        authorization.authorizedHead && authorization.authorizedHead !== expectedHead
          ? 'valid_across_head'
          : 'valid_same_head',
    };
  }
  if (authorization.scope === 'exact_head' && authorization.authorizedHead === expectedHead) {
    return { authorizationContinuity: 'valid_same_head' };
  }
  if (authorization.scope === 'exact_head') {
    return blocked(
      'authorization_head_stale',
      'request_authorization',
      true,
      'The authorization was explicitly exact-HEAD scoped and does not cover the current HEAD.',
    );
  }
  return blocked(
    'authorization_scope_invalid',
    'request_authorization',
    true,
    'Authorization scope must be pull_request or exact_head.',
  );
}

function validatePrTruth(prTruth, expectedHead) {
  if (prTruth?.state !== 'OPEN') {
    return blocked(
      'pr_not_open',
      'inspect_pr_truth',
      false,
      `PR state is ${prTruth?.state ?? 'unknown'}; no merge execution is admitted.`,
    );
  }
  if (prTruth.headRefOid !== expectedHead) {
    return blocked(
      'pr_head_mismatch',
      'refresh_pr_truth',
      false,
      'Expected HEAD does not match current GitHub PR truth. Refresh gate evidence; do not refresh authorization.',
    );
  }
  if (prTruth.mergeable === 'CONFLICTING') {
    return blocked(
      'merge_conflict',
      'resolve_conflict',
      false,
      'The PR has a real merge conflict. Resolve the conflict and refresh gate evidence; authorization remains separate.',
    );
  }
  if (prTruth.mergeable !== 'MERGEABLE') {
    return blocked(
      'mergeability_unknown',
      'refresh_pr_truth',
      false,
      `PR mergeability is ${prTruth.mergeable ?? 'unknown'}; refresh GitHub truth before execution.`,
    );
  }

  const checks = classifyStatusChecks(prTruth.statusCheckRollup);
  if (checks === 'unavailable') {
    return blocked(
      'checks_unavailable',
      'refresh_pr_truth',
      false,
      'No status-check truth is available for the current HEAD. Refresh gate evidence; authorization remains valid.',
    );
  }
  if (checks === 'pending') {
    return blocked(
      'checks_pending',
      'wait_for_ci',
      false,
      'Status checks are still pending for the current HEAD. Wait for CI; do not request merge authorization again.',
    );
  }
  if (checks === 'failed') {
    return blocked(
      'checks_failed',
      'fix_ci',
      false,
      'At least one status check failed for the current HEAD. Fix CI; do not request merge authorization again.',
    );
  }
  return null;
}

/**
 * Separate durable merge authorization from mutable PR gate evidence.
 *
 * The caller must ground authorization.sourceMessageId as direct operator evidence
 * before calling this function. This planner owns continuity and transport:
 * a pull-request-scoped grant survives HEAD changes, an exact-HEAD grant does
 * not, and clowder-ai always uses the repository-required admin transport.
 */
export function planClowderMergeExecution({ repository, prNumber, expectedHead, prTruth, authorization }) {
  const invocation = validateInvocation(repository, prNumber, expectedHead);
  if (invocation.outcome === 'blocked') return invocation;

  const expectedSubject = canonicalSubjectRef(invocation.normalizedRepository, prNumber);
  const authorizationResult = validateAuthorization(authorization, expectedSubject, expectedHead);
  if (authorizationResult.outcome === 'blocked') return authorizationResult;
  const authorizationKey = `merge:${expectedSubject}:${authorization.sourceMessageId}`;
  const subjectFreshnessKey = `head:${expectedHead}`;

  const prTruthBlock = validatePrTruth(prTruth, expectedHead);
  if (prTruthBlock) {
    return {
      ...prTruthBlock,
      authorizationContinuity: authorizationResult.authorizationContinuity,
      authorizationKey,
      subjectFreshnessKey,
    };
  }

  return {
    outcome: 'admitted',
    reasonCode: 'authorized_admin_transport',
    nextAction: 'execute',
    requiresNewAuthorization: false,
    authorizationContinuity: authorizationResult.authorizationContinuity,
    authorizationKey,
    subjectFreshnessKey,
    transport: {
      admin: true,
      reason: 'clowder_repository_policy',
    },
    command: [
      'gh',
      'pr',
      'merge',
      String(prNumber),
      '--repo',
      CLOWDER_REPOSITORY,
      '--squash',
      '--admin',
      '--match-head-commit',
      expectedHead,
    ],
    detail:
      prTruth.mergeStateStatus === 'BLOCKED'
        ? 'GitHub ruleset BLOCKED is handled by the required admin transport; it is not a new authorization edge.'
        : 'Authorization and current PR truth are valid for merge execution.',
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      args[token.slice(2)] = true;
    } else {
      args[token.slice(2)] = value;
      index += 1;
    }
  }
  return args;
}

function readPrTruth(prNumber) {
  const fixturePath = process.env.CAT_CAFE_CLOWDER_MERGE_PR_FIXTURE;
  let raw;
  if (fixturePath) {
    raw = readFileSync(fixturePath, 'utf8');
  } else {
    raw = execFileSync(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--repo',
        CLOWDER_REPOSITORY,
        '--json',
        'state,headRefOid,mergeable,mergeStateStatus,statusCheckRollup',
      ],
      { encoding: 'utf8' },
    );
  }
  return JSON.parse(raw);
}

function usage() {
  return (
    'usage: clowder-merge-execution.mjs --pr <N> --head <SHA> ' +
    '--authorization-ref <messageId> --authorization-subject <pr:repo#N> ' +
    '--authorization-scope <pull_request|exact_head> [--authorized-head <SHA>] [--execute]'
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const prNumber = Number(args.pr);
  if (
    !Number.isInteger(prNumber) ||
    !args.head ||
    !args['authorization-ref'] ||
    !args['authorization-subject'] ||
    !args['authorization-scope']
  ) {
    console.error(usage());
    process.exit(2);
  }

  let prTruth;
  try {
    prTruth = readPrTruth(prNumber);
  } catch (error) {
    const result = blocked(
      'pr_truth_unavailable',
      'refresh_pr_truth',
      false,
      `Unable to read GitHub PR truth: ${String(error.stderr ?? error.message ?? error).trim()}`,
    );
    console.log(JSON.stringify(result));
    process.exit(1);
  }

  const result = planClowderMergeExecution({
    repository: CLOWDER_REPOSITORY,
    prNumber,
    expectedHead: args.head,
    prTruth,
    authorization: {
      sourceMessageId: args['authorization-ref'],
      subjectRef: args['authorization-subject'],
      scope: args['authorization-scope'],
      authorizedHead: args['authorized-head'],
    },
  });

  console.log(JSON.stringify(result));
  if (result.outcome !== 'admitted') process.exit(1);
  if (!args.execute) return;

  const execution = spawnSync(result.command[0], result.command.slice(1), { stdio: 'inherit' });
  process.exit(execution.status ?? 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
