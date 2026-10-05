#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isCoCreationDocPath, isGovernanceDocPath } from './co-creation-docs-lane.mjs';
import { designGateJourneyReason, listDefaultEntryJourneyPaths } from './design-gate/claim-journey-paths.mjs';
import {
  assessBrowserPolicyRegistration,
  BROWSER_IMPACT_POLICY_PATH,
  readBrowserPolicyChange,
} from './lib/browser-policy-registration.mjs';
import { validateGateContinuityClaim } from './lib/gate-continuity-claim.mjs';
import { readPackageDependencyClosure } from './lib/gate-failure-package-dependencies.mjs';
import {
  computeGateFingerprint,
  GATE_EXECUTION_PATHS,
  gateFingerprintFromComponents,
  listGateRuns,
  readGateRun,
} from './lib/gate-terminal-receipt.mjs';
import {
  assertSourceFullCut,
  gateInvocationScope,
  gateRunHasScope,
  gateVerificationScope,
} from './lib/gate-verification-scope.mjs';
import { stablePatchId } from './lib/git-patch-id.mjs';

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
const NODE_FAILURE_SUMMARY = /^\s*[✖✕×]\s+failing tests:\s*$/u;
const EXPLICIT_FAILURE_RECORD = /^\s*(?:FAIL(?:\s|$)|not ok(?:\s|$))/u;
const NODE_FAILURE_PATH_RECORD = /^\s*(?:test at\s+|at\s+)/u;
const PNPM_RECURSIVE_FAILURE = /ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL/u;
const PNPM_FAILURE_WORKSPACE = /(?:^|\/)(packages\/[^/\s:]+):\s*$/u;
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

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

function diffDomain(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
  const packagePath = packageRoot(normalized);
  if (packagePath) return packagePath;
  const [root, child] = normalized.split('/');
  return child ? root : null;
}

function pnpmFailureWorkspaceRecords(lines) {
  const pnpmFailureRecords = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!PNPM_RECURSIVE_FAILURE.test(lines[index])) continue;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      if (!lines[previous].trim()) continue;
      if (PNPM_FAILURE_WORKSPACE.test(lines[previous])) pnpmFailureRecords.push(lines[previous]);
      break;
    }
  }
  return pnpmFailureRecords;
}

function failurePathRecords(outputTail) {
  const text = typeof outputTail === 'string' ? outputTail : '';
  const lines = text.replace(ANSI_ESCAPE, '').replace(/\\/g, '/').split(/\r?\n/);
  const pnpmFailureRecords = pnpmFailureWorkspaceRecords(lines);
  let summaryIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (NODE_FAILURE_SUMMARY.test(lines[index])) summaryIndex = index;
  }
  if (summaryIndex >= 0) {
    // Test names are prose and can contain command operands or unrelated paths.
    // Only runner-owned path records and stack frames are failure evidence.
    return [
      ...lines.slice(summaryIndex + 1).filter((line) => {
        return [EXPLICIT_FAILURE_RECORD.test(line), NODE_FAILURE_PATH_RECORD.test(line)].some(Boolean);
      }),
      ...pnpmFailureRecords,
    ];
  }
  return [...lines.filter((line) => EXPLICIT_FAILURE_RECORD.test(line)), ...pnpmFailureRecords];
}

function failureDomains(outputTail) {
  const records = failurePathRecords(outputTail).join('\n');
  return [
    ...new Set(
      [...records.matchAll(/(?:^|[/\s:(])packages\/([^/\s:()]+)(?:\/|:)/gm)].map((match) => `packages/${match[1]}`),
    ),
  ].sort();
}

function failureScriptPaths(outputTail) {
  const evidenceLines = failurePathRecords(outputTail);
  return [
    ...new Set(
      [
        ...evidenceLines
          .join('\n')
          .matchAll(/(?:^|[/\s:(['])((?:scripts)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+)(?=$|[/\s:)\]',])/gm),
      ].map((match) => match[1]),
    ),
  ].sort();
}

function scriptIdentity(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized.startsWith('scripts/') ? normalized.replace(/\.(?:test|spec)(?=\.[^./]+$)/, '') : null;
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

function packageClosureProvesDisjoint(failurePackages, diffPackages, packageDependencyClosure) {
  if (!packageDependencyClosure || typeof packageDependencyClosure !== 'object') return false;
  const involvedPackages = [...failurePackages, ...diffPackages];
  if (!involvedPackages.every((packageRoot) => Array.isArray(packageDependencyClosure[packageRoot]))) return false;
  return failurePackages.every((failurePackage) =>
    diffPackages.every((diffPackage) => !packageDependencyClosure[failurePackage].includes(diffPackage)),
  );
}

function failureRelation({
  hasAttributableEvidence,
  packageOverlap,
  scriptOverlap,
  touchesSharedContract,
  scriptDisjointNeedsMoreEvidence,
  packageDisjointNeedsMoreEvidence,
}) {
  if (!hasAttributableEvidence) return 'unknown';
  if (packageOverlap || scriptOverlap) return 'related';
  if (touchesSharedContract || scriptDisjointNeedsMoreEvidence || packageDisjointNeedsMoreEvidence) return 'unknown';
  return 'unrelated';
}

export function analyzeGateFailure(outputTail, diffPaths, packageDependencyClosure = null) {
  const normalizedDiffPaths = normalizePaths(diffPaths);
  const observedFailureDomains = failureDomains(outputTail);
  const attributableDiffPaths = Array.isArray(normalizedDiffPaths) ? normalizedDiffPaths : [];
  const diffDomains = [...new Set(attributableDiffPaths.map(diffDomain).filter(Boolean))].sort();
  const failurePackages = observedFailureDomains.filter((domain) => domain.startsWith('packages/'));
  const diffPackages = diffDomains.filter((domain) => domain.startsWith('packages/'));
  const observedScriptPaths = failureScriptPaths(outputTail);
  const diffScriptPaths = attributableDiffPaths.filter((filePath) => filePath.startsWith('scripts/'));
  const observedScriptIdentities = new Set(observedScriptPaths.map(scriptIdentity).filter(Boolean));
  const diffScriptIdentities = new Set(diffScriptPaths.map(scriptIdentity).filter(Boolean));
  const packageOverlap = failurePackages.some((domain) => diffPackages.includes(domain));
  const scriptOverlap = [...observedScriptIdentities].some((identity) => diffScriptIdentities.has(identity));
  const hasAttributableEvidence = [
    failurePackages.length > 0 || observedScriptPaths.length > 0,
    Boolean(normalizedDiffPaths?.length),
  ].every(Boolean);
  const scriptDisjointNeedsMoreEvidence = [observedScriptPaths.length > 0, diffScriptPaths.length > 0].every(Boolean);
  const packageDisjointNeedsMoreEvidence =
    [failurePackages.length > 0, diffPackages.length > 0].every(Boolean) &&
    !packageClosureProvesDisjoint(failurePackages, diffPackages, packageDependencyClosure);
  const relation = failureRelation({
    hasAttributableEvidence,
    packageOverlap,
    scriptOverlap,
    touchesSharedContract: attributableDiffPaths.some(isSharedContract),
    scriptDisjointNeedsMoreEvidence,
    packageDisjointNeedsMoreEvidence,
  });
  return { relation, failurePackages, diffPackages };
}

export function createGateTerminalResult({ routeEvidence, status, failedStage = null, outputTail = '' }) {
  const failed = status !== 'green';
  return {
    route: routeEvidence.route,
    verificationScope: gateVerificationScope(routeEvidence.verificationScope),
    ...(routeEvidence.browserVerification ? { browserVerification: routeEvidence.browserVerification } : {}),
    assuranceLevel: routeEvidence.assuranceLevel,
    baseSha: routeEvidence.baseSha,
    headSha: routeEvidence.headSha,
    treeSha: routeEvidence.treeSha,
    patchId: routeEvidence.patchId,
    fullGateCount: routeEvidence.fullGateCount + (routeEvidence.route === 'full' ? 1 : 0),
    failedStage: failed ? failedStage : null,
    failure: failed
      ? {
          ...analyzeGateFailure(outputTail, routeEvidence.diffPaths, routeEvidence.packageDependencyClosure),
          outputTail,
        }
      : null,
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
  if (input.exactGreen !== undefined) return input.exactGreen === true;
  return [
    input.previousStatus === 'green',
    input.previousFailureRelevance === 'none',
    input.authoredPatch === 'equivalent',
    input.typecheckStatus === 'green',
    input.targetedStatus === 'green',
  ].every(Boolean);
}

function baseRelationReasons(input, baseRelation) {
  if (baseRelation === 'related') return ['the upstream base delta intersects the authored patch'];
  if (baseRelation !== 'unknown') return [];
  if ((normalizePaths(input.basePaths) ?? []).some(isSharedContract)) {
    return ['the upstream base delta touches a shared contract'];
  }
  return (normalizePaths(input.prPaths) ?? []).some(isSharedContract)
    ? []
    : ['the base relationship cannot be proven unrelated'];
}

function collectFullReasons(input, baseRelation, browserPolicyRegistration) {
  const reasons = [];
  const authoredSharedContract = (normalizePaths(input.prPaths) ?? []).some(isSharedContract);
  if (authoredSharedContract) reasons.push('the authored patch touches a shared contract');
  if (input.riskLane === 'full') reasons.push('the five-axis risk route requires full gate');
  if (input.riskLane === 'unknown') reasons.push('the five-axis risk route is unknown and fails closed');
  if (
    (normalizePaths(input.prPaths) ?? []).some(
      (file) =>
        isGateExecutionPath(file) &&
        !(file === BROWSER_IMPACT_POLICY_PATH && browserPolicyRegistration?.status === 'registration'),
    )
  ) {
    reasons.push('the patch changes the canonical gate classifier or gate execution path');
  }
  const journeyReason = designGateJourneyReason(
    normalizePaths(input.prPaths) ?? [],
    normalizePaths(input.journeyEvidencePaths) ?? [],
  );
  if (journeyReason) reasons.push(journeyReason);
  if (input.authoredPatch === 'unknown') reasons.push('authored patch continuity is unknown');
  reasons.push(...baseRelationReasons(input, baseRelation));
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

function classifyCoverageRoute(input, browserPolicyRegistration) {
  const baseRelation = assessBaseRelation(input);
  const invalid = [
    ...legacyInvalid(input),
    invalidValue('riskAxis', input.riskAxis, RISK_AXES, true),
    invalidValue('previousStatus', input.previousStatus, PREVIOUS_STATUSES),
    invalidValue('previousFailureRelevance', input.previousFailureRelevance, FAILURE_RELATIONS),
    invalidValue('authoredPatch', input.authoredPatch, PATCH_RELATIONS),
  ].filter(Boolean);
  if (invalid.length > 0) return fullResult(baseRelation, invalid);

  const paths = normalizePaths(input.prPaths);
  if (paths?.length && paths.every(isCoCreationDocPath) && !['full', 'unknown'].includes(input.riskLane)) {
    return {
      route: 'targeted',
      baseRelation,
      mergeReady: false,
      reusesFullGreen: false,
      requiredChecks: ['docs-validation'],
      resumeStages: [],
      reasons: ['docs-only changes require documentation validation; review assurance is independent'],
    };
  }

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

  const fullReasons = collectFullReasons(input, baseRelation, browserPolicyRegistration);
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

export function classifyGateRoute(input) {
  const browserPolicyRegistration = (normalizePaths(input.prPaths) ?? []).includes(BROWSER_IMPACT_POLICY_PATH)
    ? assessBrowserPolicyRegistration(input.browserImpactPolicyChange)
    : null;
  const highAssurance =
    (input.riskAxis != null && input.riskAxis !== 'behavior') ||
    (normalizePaths(input.prPaths) ?? []).some((file) => isGateExecutionPath(file) || isGovernanceDocPath(file));
  return {
    ...classifyCoverageRoute(input, browserPolicyRegistration),
    assuranceLevel: highAssurance ? 'high' : 'standard',
    ...(browserPolicyRegistration ? { browserPolicyRegistration } : {}),
  };
}

function previousEvidence(runs, fingerprint, patchId, repoRoot, baseSha, diffPaths, packageDependencyClosure) {
  const exactRuns = runs.filter((run) => run.fingerprint === fingerprint);
  const exactGreen = exactRuns.some((run) => run.terminalStatus === 'green' && run.reuseEligible !== false);
  const previous = exactRuns[0] ?? runs.find((run) => patchId && run.result?.patchId === patchId) ?? null;
  const previousStatus = previous?.terminalStatus ?? 'none';
  const failure = previous?.result?.failure ?? null;
  const previousFailureRelevance = ['none', 'green'].includes(previousStatus)
    ? 'none'
    : (failure?.relation ??
      analyzeGateFailure(failure?.outputTail ?? '', diffPaths, packageDependencyClosure).relation);
  const previousBase = previous?.result?.baseSha;
  let basePaths = [];
  if (previousBase && previousBase !== baseSha) {
    try {
      basePaths = pathsFromGit(repoRoot, ['diff', '--no-renames', '--name-only', `${previousBase}..${baseSha}`]);
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

function classifyContinuityClaim(
  classified,
  { repoRoot, databasePath, continuityClaimId, baseSha, invocationArgs, riskAxis, headSha, treeSha, fingerprint },
) {
  try {
    if (riskAxis !== null && !RISK_AXES.has(riskAxis))
      throw new Error('continuity cannot override an unknown risk axis');
    const claim = validateGateContinuityClaim({
      repoRoot,
      databasePath,
      claimHash: continuityClaimId,
      baseSha,
      invocationArgs,
    });
    if (
      claim.target.headSha !== headSha ||
      claim.target.treeSha !== treeSha ||
      claim.target.fingerprint !== fingerprint
    )
      throw new Error('continuity inputs changed during route classification');
    return {
      classified: {
        ...classified,
        route: 'targeted',
        baseRelation: 'unrelated',
        mergeReady: false,
        reusesFullGreen: false,
        requiredChecks: claim.requiredChecks,
        resumeStages: [],
        reasons: ['gate owner asserted exact C2 scope; immutable input bindings match; C3 remains unverified'],
      },
      continuityClaim: { status: 'valid', ...claim },
      previous: readGateRun(databasePath, claim.source.runId),
    };
  } catch (error) {
    return {
      classified: { ...classified, ...fullResult('unknown', [`continuity claim rejected: ${error.message}`]) },
      continuityClaim: { status: 'invalid', claimHash: continuityClaimId, reason: error.message },
      previous: null,
    };
  }
}

export function deriveGateRoute({
  repoRoot,
  baseSha,
  databasePath,
  riskAxis = null,
  invocationArgs = [],
  continuityClaimId = null,
}) {
  const headSha = git(repoRoot, ['rev-parse', 'HEAD']);
  const treeSha = git(repoRoot, ['rev-parse', 'HEAD^{tree}']);
  const { verificationScope, sourceSha } = gateInvocationScope(invocationArgs);
  assertSourceFullCut(sourceSha, headSha, baseSha, continuityClaimId);
  const dirtyProbe = invocationArgs.includes('--no-rebase') && Boolean(git(repoRoot, ['status', '--porcelain']));
  const diffPaths = [
    ...new Set([
      ...pathsFromGit(repoRoot, ['diff', '--name-only', `${baseSha}...HEAD`]),
      ...(dirtyProbe ? pathsFromGit(repoRoot, ['diff', '--name-only', 'HEAD']) : []),
      ...(dirtyProbe ? pathsFromGit(repoRoot, ['ls-files', '--others', '--exclude-standard']) : []),
    ]),
  ].sort();
  const patchId = dirtyProbe ? null : stablePatchId(repoRoot, baseSha);
  const fingerprintInput = dirtyProbe ? null : computeGateFingerprint(repoRoot, invocationArgs);
  const fingerprint = fingerprintInput?.fingerprint ?? null;
  const frozenFingerprints = sourceSha
    ? {
        runnerFingerprint: gateFingerprintFromComponents({
          gateCode: fingerprintInput.components.gateCode,
          gateConfig: fingerprintInput.components.gateConfig,
        }),
        toolchainFingerprint: gateFingerprintFromComponents({
          lockfileSha256: fingerprintInput.components.lockfileSha256,
          toolchain: fingerprintInput.components.toolchain,
        }),
      }
    : {};
  const runs = dirtyProbe ? [] : listGateRuns(databasePath).filter((run) => gateRunHasScope(run, verificationScope));
  const packageDependencyClosure = readPackageDependencyClosure(repoRoot, headSha);
  const evidence = previousEvidence(runs, fingerprint, patchId, repoRoot, baseSha, diffPaths, packageDependencyClosure);
  let classified = classifyGateRoute({
    riskAxis,
    browserImpactPolicyChange: readBrowserPolicyChange(repoRoot, baseSha, headSha, dirtyProbe ? [] : diffPaths),
    journeyEvidencePaths: listDefaultEntryJourneyPaths(repoRoot),
    previousStatus: evidence.previousStatus,
    previousFailureRelevance: evidence.previousFailureRelevance,
    authoredPatch: evidence.authoredPatch,
    prPaths: diffPaths,
    basePaths: evidence.basePaths,
    exactGreen: evidence.exactGreen,
    resumableStages: evidence.resumableStages,
  });
  if (sourceSha) {
    classified = {
      ...classified,
      ...fullResult('unrelated', ['explicit source_full requires the complete frozen source plan']),
      mergeReady: false,
    };
  }
  let continuityClaim = null;
  if (continuityClaimId !== null && continuityClaimId !== undefined) {
    const resolved = classifyContinuityClaim(classified, {
      repoRoot,
      databasePath,
      continuityClaimId,
      baseSha,
      invocationArgs,
      riskAxis,
      headSha,
      treeSha,
      fingerprint,
    });
    classified = resolved.classified;
    continuityClaim = resolved.continuityClaim;
    if (resolved.previous) {
      evidence.previous = resolved.previous;
      evidence.previousStatus = resolved.previous.terminalStatus;
    }
  }
  return {
    ...classified,
    verificationScope,
    ...frozenFingerprints,
    dirtyProbe,
    baseSha,
    headSha,
    treeSha,
    fingerprint,
    patchId,
    diffPaths,
    continuityClaim,
    packageDependencyClosure,
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
    const continuityClaimId = valueAfter(args, '--continuity-claim');
    if (args.includes('--continuity-claim') && !continuityClaimId)
      throw new Error('--continuity-claim requires a claim hash');
    console.log(
      JSON.stringify(deriveGateRoute({ repoRoot, baseSha, databasePath, riskAxis, invocationArgs, continuityClaimId })),
    );
  } catch (error) {
    console.error(`[gate-route] ${error.message}`);
    process.exitCode = 2;
  }
}
