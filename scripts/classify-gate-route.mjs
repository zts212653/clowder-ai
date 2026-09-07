#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { computeGateFingerprint, GATE_EXECUTION_PATHS, listGateRuns } from './lib/gate-terminal-receipt.mjs';

const LEGACY_RISK_LANES = new Set(['targeted', 'full', 'unknown']);
const RISK_AXES = new Set(['behavior', 'data', 'security', 'contract', 'irreversible']);
const PREVIOUS_STATUSES = new Set(['none', 'green', 'failed', 'cancelled', 'timed_out', 'lost', 'partial']);
const FAILURE_RELATIONS = new Set(['none', 'unrelated', 'related', 'unknown']);
const PATCH_RELATIONS = new Set(['equivalent', 'changed', 'unknown']);
const CHECK_STATUSES = new Set(['green', 'failed', 'not_run']);
const SHARED_ROOT_CONTRACTS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'sync-manifest.yaml',
  'biome.json',
]);
const SHARED_PREFIXES = ['.github/workflows/', 'cat-cafe-skills/merge-gate/', 'packages/shared/', 'sop-definitions/'];
const GATE_EXECUTION_PATH_SET = new Set(GATE_EXECUTION_PATHS);

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function normalizePaths(paths) {
  if (!Array.isArray(paths)) return null;
  return paths.map((filePath) => String(filePath).replace(/^\.\//, '')).filter(Boolean);
}

function pathsFromGit(repoRoot, args) {
  const output = git(repoRoot, args);
  return output
    ? output
        .split('\n')
        .map((filePath) => filePath.trim())
        .filter(Boolean)
    : [];
}

function packageRoot(filePath) {
  const match = String(filePath)
    .replace(/\\/g, '/')
    .match(/(?:^|\/)(packages\/[^/]+)(?:\/|$)/);
  return match?.[1] ?? null;
}

function isSharedContract(filePath) {
  return [
    SHARED_ROOT_CONTRACTS.has(filePath),
    SHARED_PREFIXES.some((prefix) => filePath.startsWith(prefix)),
    /(^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(filePath),
  ].some(Boolean);
}

function isGateExecutionPath(filePath) {
  return GATE_EXECUTION_PATH_SET.has(filePath);
}

export function analyzeGateFailure(outputTail, diffPaths) {
  const failurePackages = [
    ...new Set(
      [...String(outputTail ?? '').matchAll(/(?:^|[/\s:(])packages\/([^/\s:()]+)\//gm)].map(
        (match) => `packages/${match[1]}`,
      ),
    ),
  ].sort();
  const diffPackages = [...new Set((normalizePaths(diffPaths) ?? []).map(packageRoot).filter(Boolean))].sort();
  const relation =
    failurePackages.length === 0
      ? 'unknown'
      : failurePackages.some((root) => diffPackages.includes(root))
        ? 'related'
        : 'unrelated';
  return { relation, failurePackages, diffPackages };
}

export function createGateTerminalResult({ routeEvidence, status, failedStage = null, outputTail = '' }) {
  const failed = status !== 'green';
  return {
    route: routeEvidence.route,
    baseSha: routeEvidence.baseSha,
    headSha: routeEvidence.headSha,
    treeSha: routeEvidence.treeSha,
    patchId: routeEvidence.patchId,
    fullGateCount: routeEvidence.fullGateCount + (routeEvidence.route === 'full' ? 1 : 0),
    failedStage: failed ? failedStage : null,
    failure: failed ? { ...analyzeGateFailure(outputTail, routeEvidence.diffPaths), outputTail } : null,
  };
}

export function assessBaseRelation({ prPaths, basePaths }) {
  const normalizedPrPaths = normalizePaths(prPaths);
  const normalizedBasePaths = normalizePaths(basePaths);
  if (![normalizedPrPaths, normalizedBasePaths].every(Array.isArray) || normalizedPrPaths.length === 0) {
    return 'unknown';
  }
  const prPathSet = new Set(normalizedPrPaths);
  if (normalizedBasePaths.some((filePath) => prPathSet.has(filePath))) return 'related';
  if ([...normalizedPrPaths, ...normalizedBasePaths].some(isSharedContract)) return 'unknown';
  return 'unrelated';
}

function invalidValue(name, value, allowed, optional = false) {
  if (optional && (value === null || value === undefined)) return null;
  return allowed.has(value) ? null : `${name}=${JSON.stringify(value)} is unknown`;
}

function fullResult(baseRelation, reasons, resumeStages = []) {
  return {
    route: 'full',
    baseRelation,
    mergeReady: false,
    reusesFullGreen: false,
    requiredChecks: ['canonical-full-gate'],
    resumeStages,
    reasons,
  };
}

function legacyInvalid(input) {
  if (input.riskLane === undefined) return [];
  return [
    invalidValue('riskLane', input.riskLane, LEGACY_RISK_LANES),
    invalidValue('typecheckStatus', input.typecheckStatus, CHECK_STATUSES),
    invalidValue('targetedStatus', input.targetedStatus, CHECK_STATUSES),
  ].filter(Boolean);
}

function canReuseFullGreen(input) {
  if (input.exactGreen === true) return true;
  return [
    input.previousStatus === 'green',
    input.previousFailureRelevance === 'none',
    input.authoredPatch === 'equivalent',
    input.typecheckStatus === 'green',
    input.targetedStatus === 'green',
  ].every(Boolean);
}

function collectFullReasons(input, baseRelation) {
  const reasons = [];
  if (input.riskLane === 'full') reasons.push('the five-axis risk route requires full gate');
  if (input.riskLane === 'unknown') reasons.push('the five-axis risk route is unknown and fails closed');
  if (input.riskAxis !== null && input.riskAxis !== undefined) {
    reasons.push(`the ${input.riskAxis} risk axis requires full gate`);
  }
  if ((normalizePaths(input.prPaths) ?? []).some(isGateExecutionPath)) {
    reasons.push('the patch changes the canonical gate classifier or gate execution path');
  }
  if (input.authoredPatch === 'unknown') reasons.push('authored patch continuity is unknown');
  if (baseRelation === 'related') reasons.push('the upstream base delta intersects the authored patch');
  if (baseRelation === 'unknown') {
    reasons.push('the upstream base delta touches a shared contract or cannot be proven unrelated');
  }
  if (!['none', 'green'].includes(input.previousStatus) && input.previousFailureRelevance !== 'unrelated') {
    reasons.push('the previous non-green failure is related or cannot be proven unrelated');
  }
  return reasons;
}

function targetedChecks(input) {
  if (input.riskLane === undefined) return ['risk-matched-targeted-evidence'];
  return [
    input.typecheckStatus === 'green' ? null : 'cross-package-typecheck',
    input.targetedStatus === 'green' ? null : 'targeted-checks',
  ].filter(Boolean);
}

function targetedReason(input) {
  if (!['none', 'green'].includes(input.previousStatus)) {
    return 'an incomplete unrelated full-gate receipt invalidates reuse but does not upgrade the risk route';
  }
  return input.previousStatus === 'green'
    ? 'full-green continuity is incomplete, so targeted evidence must be refreshed'
    : 'no reusable full-green receipt exists';
}

export function classifyGateRoute(input) {
  const baseRelation = assessBaseRelation(input);
  const invalid = [
    ...legacyInvalid(input),
    invalidValue('riskAxis', input.riskAxis, RISK_AXES, true),
    invalidValue('previousStatus', input.previousStatus, PREVIOUS_STATUSES),
    invalidValue('previousFailureRelevance', input.previousFailureRelevance, FAILURE_RELATIONS),
    invalidValue('authoredPatch', input.authoredPatch, PATCH_RELATIONS),
  ].filter(Boolean);
  if (invalid.length > 0) return fullResult(baseRelation, invalid);

  if (canReuseFullGreen(input)) {
    return {
      route: 'reuse',
      baseRelation,
      mergeReady: true,
      reusesFullGreen: true,
      requiredChecks: [],
      resumeStages: [],
      reasons: ['canonical full-green continuity is proven for the exact tree'],
    };
  }

  const fullReasons = collectFullReasons(input, baseRelation);
  if (fullReasons.length > 0) return fullResult(baseRelation, fullReasons, input.resumableStages ?? []);

  const legacyChecks = targetedChecks(input);
  return {
    route: 'targeted',
    baseRelation,
    mergeReady: legacyChecks.length === 0,
    reusesFullGreen: false,
    requiredChecks: legacyChecks,
    resumeStages: [],
    reasons: [targetedReason(input)],
  };
}

function stablePatchId(repoRoot, baseSha) {
  const patch = execFileSync('git', ['diff', '--binary', `${baseSha}...HEAD`], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (patch.length === 0) return null;
  const result = spawnSync('git', ['patch-id', '--stable'], { cwd: repoRoot, input: patch, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'git patch-id failed');
  return result.stdout.trim().split(/\s+/)[0] || null;
}

function previousEvidence(runs, fingerprint, patchId, repoRoot, baseSha, diffPaths) {
  const exactRuns = runs.filter((run) => run.fingerprint === fingerprint);
  const exactGreen = exactRuns.some((run) => run.terminalStatus === 'green');
  const previous = exactRuns[0] ?? runs.find((run) => patchId && run.result?.patchId === patchId) ?? null;
  const previousStatus = previous?.terminalStatus ?? 'none';
  const failure = previous?.result?.failure ?? null;
  const previousFailureRelevance = ['none', 'green'].includes(previousStatus)
    ? 'none'
    : (failure?.relation ?? analyzeGateFailure(failure?.outputTail ?? '', diffPaths).relation);
  const previousBase = previous?.result?.baseSha;
  let basePaths = [];
  if (previousBase && previousBase !== baseSha) {
    try {
      basePaths = pathsFromGit(repoRoot, ['diff', '--name-only', `${previousBase}..${baseSha}`]);
    } catch {
      basePaths = null;
    }
  }
  return {
    exactGreen,
    previous,
    previousStatus,
    previousFailureRelevance,
    authoredPatch: previous ? (previous.result?.patchId === patchId ? 'equivalent' : 'changed') : 'changed',
    basePaths,
    resumableStages: previous?.result?.failedStage ? [previous.result.failedStage] : [],
  };
}

export function deriveGateRoute({ repoRoot, baseSha, databasePath, riskAxis = null, invocationArgs = [] }) {
  const headSha = git(repoRoot, ['rev-parse', 'HEAD']);
  const treeSha = git(repoRoot, ['rev-parse', 'HEAD^{tree}']);
  const diffPaths = pathsFromGit(repoRoot, ['diff', '--name-only', `${baseSha}...HEAD`]);
  const patchId = stablePatchId(repoRoot, baseSha);
  const { fingerprint } = computeGateFingerprint(repoRoot, invocationArgs);
  const runs = listGateRuns(databasePath);
  const evidence = previousEvidence(runs, fingerprint, patchId, repoRoot, baseSha, diffPaths);
  const classified = classifyGateRoute({
    riskAxis,
    previousStatus: evidence.previousStatus,
    previousFailureRelevance: evidence.previousFailureRelevance,
    authoredPatch: evidence.authoredPatch,
    prPaths: diffPaths,
    basePaths: evidence.basePaths,
    exactGreen: evidence.exactGreen,
    resumableStages: evidence.resumableStages,
  });
  return {
    ...classified,
    baseSha,
    headSha,
    treeSha,
    fingerprint,
    patchId,
    diffPaths,
    diffPackages: [...new Set(diffPaths.map(packageRoot).filter(Boolean))].sort(),
    previous: evidence.previous
      ? { runId: evidence.previous.runId, status: evidence.previousStatus, result: evidence.previous.result }
      : { runId: null, status: 'none', result: null },
    fullGateCount: runs.filter((run) => run.fingerprint === fingerprint && run.terminalStatus !== null).length,
  };
}

function valueAfter(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const repoRoot = path.resolve(valueAfter(args, '--repo-root') ?? process.cwd());
    const baseSha = valueAfter(args, '--base-sha');
    const databasePath = valueAfter(args, '--database-path');
    const riskAxis = valueAfter(args, '--risk') ?? null;
    const invocationArgsJson = valueAfter(args, '--invocation-args-json');
    if (!baseSha || !databasePath) {
      throw new Error(
        'usage: classify-gate-route --base-sha SHA --database-path PATH [--risk AXIS] [--invocation-args-json JSON]',
      );
    }
    const invocationArgs = invocationArgsJson ? JSON.parse(invocationArgsJson) : riskAxis ? ['--risk', riskAxis] : [];
    if (!Array.isArray(invocationArgs) || invocationArgs.some((value) => typeof value !== 'string')) {
      throw new Error('--invocation-args-json must encode a string array');
    }
    console.log(JSON.stringify(deriveGateRoute({ repoRoot, baseSha, databasePath, riskAxis, invocationArgs })));
  } catch (error) {
    console.error(`[gate-route] ${error.message}`);
    process.exitCode = 2;
  }
}
