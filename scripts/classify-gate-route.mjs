#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const RISK_LANES = new Set(['targeted', 'full', 'unknown']);
const PREVIOUS_STATUSES = new Set(['none', 'green', 'failed', 'cancelled', 'timed_out', 'lost', 'partial']);
const FAILURE_RELATIONS = new Set(['none', 'unrelated', 'related', 'unknown']);
const PATCH_RELATIONS = new Set(['equivalent', 'changed', 'unknown']);
const CHECK_STATUSES = new Set(['green', 'failed', 'not_run']);
const ARGUMENT_FLAGS = new Set([
  'risk-lane',
  'previous-status',
  'previous-failure-relevance',
  'authored-patch',
  'typecheck-status',
  'targeted-status',
  'pr-paths',
  'base-paths',
]);
const SHARED_ROOT_CONTRACTS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'sync-manifest.yaml',
  'biome.json',
]);
const SHARED_PREFIXES = ['.github/workflows/', 'cat-cafe-skills/merge-gate/', 'packages/shared/', 'sop-definitions/'];

function normalizePaths(paths) {
  if (!Array.isArray(paths)) return null;
  return paths.map((path) => String(path).replace(/^\.\//, '')).filter(Boolean);
}

function isSharedContract(path) {
  return [
    SHARED_ROOT_CONTRACTS.has(path),
    SHARED_PREFIXES.some((prefix) => path.startsWith(prefix)),
    /(^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(path),
    path === 'scripts/pre-merge-check.sh',
  ].some(Boolean);
}

export function assessBaseRelation({ prPaths, basePaths }) {
  const normalizedPrPaths = normalizePaths(prPaths);
  const normalizedBasePaths = normalizePaths(basePaths);
  if (![normalizedPrPaths, normalizedBasePaths].every(Array.isArray)) {
    return 'unknown';
  }
  if (normalizedPrPaths.length === 0) {
    return 'unknown';
  }

  const prPathSet = new Set(normalizedPrPaths);
  if (normalizedBasePaths.some((path) => prPathSet.has(path))) return 'related';
  if ([...normalizedPrPaths, ...normalizedBasePaths].some(isSharedContract)) {
    return 'unknown';
  }
  return 'unrelated';
}

function invalidValue(name, value, allowed) {
  return allowed.has(value) ? null : `${name}=${JSON.stringify(value)} is unknown`;
}

export function classifyGateRoute(input) {
  const baseRelation = assessBaseRelation(input);
  const fullReasons = fullRouteReasons(input, baseRelation);
  if (fullReasons) return fullResult(baseRelation, fullReasons);

  if (canReuseFullGreen(input)) {
    return {
      route: 'reuse',
      baseRelation,
      mergeReady: true,
      reusesFullGreen: true,
      requiredChecks: [],
      reasons: ['canonical full-green continuity is proven for the equivalent tree'],
    };
  }

  const requiredChecks = [
    input.typecheckStatus === 'green' ? null : 'cross-package-typecheck',
    input.targetedStatus === 'green' ? null : 'targeted-checks',
  ].filter(Boolean);

  return {
    route: 'targeted',
    baseRelation,
    mergeReady: requiredChecks.length === 0,
    reusesFullGreen: false,
    requiredChecks,
    reasons: [targetedReason(input.previousStatus)],
  };
}

function fullRouteReasons(input, baseRelation) {
  const invalid = [
    invalidValue('riskLane', input.riskLane, RISK_LANES),
    invalidValue('previousStatus', input.previousStatus, PREVIOUS_STATUSES),
    invalidValue('previousFailureRelevance', input.previousFailureRelevance, FAILURE_RELATIONS),
    invalidValue('authoredPatch', input.authoredPatch, PATCH_RELATIONS),
    invalidValue('typecheckStatus', input.typecheckStatus, CHECK_STATUSES),
    invalidValue('targetedStatus', input.targetedStatus, CHECK_STATUSES),
  ].filter(Boolean);
  if (invalid.length > 0) return invalid;
  if (input.riskLane === 'full') return ['the five-axis risk route requires full gate'];
  if (input.riskLane === 'unknown') return ['the five-axis risk route is unknown and fails closed'];
  if (input.authoredPatch === 'unknown') return ['authored patch continuity is unknown'];
  if (baseRelation === 'related') return ['the upstream base delta intersects the authored patch'];
  if (baseRelation === 'unknown') {
    return ['the upstream base delta touches a shared contract or cannot be proven unrelated'];
  }
  if (!['none', 'green'].includes(input.previousStatus) && input.previousFailureRelevance !== 'unrelated') {
    return ['the previous non-green failure is related or cannot be proven unrelated'];
  }
  return null;
}

function canReuseFullGreen(input) {
  return [
    input.previousStatus === 'green',
    input.previousFailureRelevance === 'none',
    input.authoredPatch === 'equivalent',
    input.typecheckStatus === 'green',
    input.targetedStatus === 'green',
  ].every(Boolean);
}

function targetedReason(previousStatus) {
  if (!['none', 'green'].includes(previousStatus)) {
    return 'an incomplete unrelated full-gate receipt invalidates reuse but does not upgrade the risk route';
  }
  return previousStatus === 'green'
    ? 'full-green continuity is incomplete, so targeted evidence must be refreshed'
    : 'no reusable full-green receipt exists';
}

function fullResult(baseRelation, reasons) {
  return {
    route: 'full',
    baseRelation,
    mergeReady: false,
    reusesFullGreen: false,
    requiredChecks: ['canonical-full-gate'],
    reasons,
  };
}

function recordArgument(values, flag, value) {
  if (!flag?.startsWith('--')) {
    const received = flag === undefined ? '<end>' : flag;
    throw new Error(`expected --name value pairs, received ${received}`);
  }
  if (value === undefined) throw new Error(`missing value for ${flag}`);
  const name = flag.slice(2);
  if (!ARGUMENT_FLAGS.has(name)) throw new Error(`unknown flag ${flag}`);
  if (Object.hasOwn(values, name)) throw new Error(`duplicate flag ${flag}`);
  values[name] = value;
}

function parseArguments(argv) {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;
  const values = {};
  for (let index = 0; index < normalizedArgv.length; index += 2) {
    recordArgument(values, normalizedArgv[index], normalizedArgv[index + 1]);
  }
  for (const name of ARGUMENT_FLAGS) {
    if (!Object.hasOwn(values, name)) throw new Error(`missing required flag --${name}`);
  }
  return {
    riskLane: values['risk-lane'],
    previousStatus: values['previous-status'],
    previousFailureRelevance: values['previous-failure-relevance'],
    authoredPatch: values['authored-patch'],
    typecheckStatus: values['typecheck-status'],
    targetedStatus: values['targeted-status'],
    prPaths: values['pr-paths'].split(',').filter(Boolean),
    basePaths: values['base-paths'].split(',').filter(Boolean),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = classifyGateRoute(parseArguments(process.argv.slice(2)));
    console.log(`[gate-route] route=${result.route} mergeReady=${result.mergeReady}`);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`[gate-route] ${error.message}`);
    process.exitCode = 2;
  }
}
