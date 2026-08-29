#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { checkCapabilityTipsForRepo } from './check-capability-tips.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, '..');
const INVENTORY_PATH = 'packages/web/src/lib/capability-tips.seed.json';
const TIP_SOURCE_FIELDS = ['sourceRef', 'structureSource', 'bodySource'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isSourceRef(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    typeof value.anchor === 'string' &&
    value.anchor.length > 0
  );
}

function sourceRefKey(value) {
  return isSourceRef(value) ? `${value.path}\u0000${value.anchor}` : null;
}

function readGitFile(repoRoot, ref, relativePath) {
  try {
    return execFileSync('git', ['show', `${ref}:${relativePath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function workingTreeReferenceStatus(repoRoot, sourceRef) {
  const path = resolve(repoRoot, sourceRef.path);
  if (!existsSync(path)) return 'missing path';
  return readFileSync(path, 'utf8').includes(sourceRef.anchor) ? 'ok' : 'missing anchor';
}

function gitReferenceStatus(repoRoot, baseRef, sourceRef) {
  const content = readGitFile(repoRoot, baseRef, sourceRef.path);
  if (content === null) return 'missing path';
  return content.includes(sourceRef.anchor) ? 'ok' : 'missing anchor';
}

export function extractRootScriptPathRefs(command) {
  const refs = new Set();
  const matcher = /(?:^|[\s"'=])((?:\.\/)?scripts\/[A-Za-z0-9_./@+-]+)/g;
  for (const match of command.matchAll(matcher)) {
    const ref = match[1].replace(/^\.\//, '');
    if (/[*?[\]{}]/.test(ref)) continue;
    refs.add(ref);
  }
  return [...refs].sort();
}

export function checkPublicPackageScriptClosure(repoRoot = defaultRepoRoot) {
  const packagePath = resolve(repoRoot, 'package.json');
  if (!existsSync(packagePath)) {
    return { ok: false, errors: ['package.json: missing exported root package metadata'] };
  }

  let packageJson;
  try {
    packageJson = readJson(packagePath);
  } catch (error) {
    return { ok: false, errors: [`package.json: invalid JSON (${error.message})`] };
  }

  const errors = [];
  for (const [scriptName, command] of Object.entries(packageJson.scripts ?? {})) {
    if (typeof command !== 'string') continue;
    for (const relativePath of extractRootScriptPathRefs(command)) {
      const absolutePath = resolve(repoRoot, relativePath);
      const pathFromRoot = relative(repoRoot, absolutePath);
      if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
        errors.push(`package.json:${scriptName} -> outside export root ${relativePath}`);
      } else if (!existsSync(absolutePath)) {
        errors.push(`package.json:${scriptName} -> missing ${relativePath}`);
      }
    }
  }
  errors.sort();
  return { ok: errors.length === 0, errors };
}

function loadCapabilityTipInventories(repoRoot, baseRef) {
  try {
    const inventoryPath = resolve(repoRoot, INVENTORY_PATH);
    if (!existsSync(inventoryPath)) {
      return { error: `${INVENTORY_PATH}: missing candidate inventory` };
    }
    const candidateTips = readJson(inventoryPath);
    const baselineRaw = readGitFile(repoRoot, baseRef, INVENTORY_PATH);
    if (baselineRaw === null) {
      return { error: `${INVENTORY_PATH}: unavailable at baseline ${baseRef}` };
    }
    const baselineTips = JSON.parse(baselineRaw);
    if (!Array.isArray(candidateTips) || !Array.isArray(baselineTips)) {
      return { error: `${INVENTORY_PATH}: inventory must be an array` };
    }
    return { candidateTips, baselineTips };
  } catch (error) {
    return { error: `${INVENTORY_PATH}: invalid inventory (${error.message})` };
  }
}

function tipReferenceRegressionErrors(repoRoot, baseRef, tip, baselineTip) {
  if (!tip || typeof tip !== 'object' || typeof tip.id !== 'string') return [];
  return TIP_SOURCE_FIELDS.flatMap((field) => {
    const sourceRef = tip[field];
    if (!isSourceRef(sourceRef)) return [];
    const candidateStatus = workingTreeReferenceStatus(repoRoot, sourceRef);
    if (candidateStatus === 'ok') return [];

    const baselineRef = baselineTip?.[field];
    const unchangedBaselineWarning =
      sourceRefKey(baselineRef) === sourceRefKey(sourceRef) &&
      gitReferenceStatus(repoRoot, baseRef, baselineRef) === candidateStatus;
    if (unchangedBaselineWarning) return [];

    return [
      `${tip.id}: ${field} newly points to ${candidateStatus} ${sourceRef.path}` +
        (candidateStatus === 'missing anchor' ? `#${sourceRef.anchor}` : ''),
    ];
  });
}

export function checkCapabilityTipReferenceRegressions(repoRoot = defaultRepoRoot, options = {}) {
  const baseRef = options.baseRef ?? 'HEAD';
  const inventories = loadCapabilityTipInventories(repoRoot, baseRef);
  if (inventories.error) return { ok: false, errors: [inventories.error] };

  const baselineById = new Map(
    inventories.baselineTips
      .filter((tip) => tip && typeof tip === 'object' && typeof tip.id === 'string')
      .map((tip) => [tip.id, tip]),
  );
  const errors = inventories.candidateTips.flatMap((tip) =>
    tipReferenceRegressionErrors(repoRoot, baseRef, tip, baselineById.get(tip?.id)),
  );

  errors.sort();
  return { ok: errors.length === 0, errors };
}

export function checkSyncPublicPreflight(repoRoot = defaultRepoRoot, options = {}) {
  const packageClosure = checkPublicPackageScriptClosure(repoRoot);
  const tipReferenceRegressions = checkCapabilityTipReferenceRegressions(repoRoot, options);
  const capabilityTips = checkCapabilityTipsForRepo(repoRoot, {
    changedFiles: options.changedFiles ?? [],
    baseRef: options.baseRef ?? 'HEAD',
  });
  const errors = [...packageClosure.errors, ...tipReferenceRegressions.errors, ...capabilityTips.errors];
  const warnings = capabilityTips.warnings ?? [];
  return { ok: errors.length === 0, errors, warnings };
}

function parseArgs(argv) {
  let repoRoot = defaultRepoRoot;
  let baseRef = 'HEAD';
  const changedFiles = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo-root' && argv[index + 1]) {
      repoRoot = resolve(argv[index + 1]);
      index += 1;
    } else if (arg === '--base-ref' && argv[index + 1]) {
      baseRef = argv[index + 1];
      index += 1;
    } else if (arg === '--changed-file' && argv[index + 1]) {
      changedFiles.push(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }
  return { repoRoot, baseRef, changedFiles };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`FAIL sync public preflight: ${error.message}`);
    process.exit(2);
  }

  const startedAt = Date.now();
  const result = checkSyncPublicPreflight(args.repoRoot, args);
  for (const warning of result.warnings) console.error(`WARN sync public preflight: ${warning}`);
  if (!result.ok) {
    console.error(`FAIL sync public preflight: ${result.errors.length} issue(s)`);
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`PASS sync public preflight (${Date.now() - startedAt}ms)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
