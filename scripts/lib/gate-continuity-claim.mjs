import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  computeGateFingerprint,
  gateFingerprintFromComponents,
  hasBlockingGateEvidence,
  readGateRun,
} from './gate-terminal-receipt.mjs';
import { gateRunHasScope } from './gate-verification-scope.mjs';
import { stablePatchId } from './git-patch-id.mjs';

export const CONTINUITY_POLICY = 'gate-owner-c2-v3';
export const CONTINUITY_CHECKS = Object.freeze([
  'risk-matched-targeted-evidence',
  'cross-package-typecheck',
  'docs-validation',
]);
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const CLAIM_ID = /^[a-f0-9]{64}$/u;

function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}

function exactCommit(repoRoot, value) {
  if (!OID.test(value ?? '') || git(repoRoot, ['rev-parse', '--verify', `${value}^{commit}`]).trim() !== value)
    throw new Error('continuity requires exact available commit identities');
  return value;
}

function treeEntries(repoRoot, tree) {
  if (!OID.test(tree ?? '')) throw new Error('continuity tree identity is invalid');
  return git(repoRoot, ['ls-tree', '-r', '-z', '--full-tree', tree])
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const tab = row.indexOf('\t');
      const [mode, type, oid] = row.slice(0, tab).split(' ');
      if (tab < 0 || !OID.test(oid ?? '')) throw new Error('invalid frozen tree entry');
      return { path: row.slice(tab + 1), mode, type, oid };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function assertC2Assertion(assertion, delta) {
  if (
    !assertion ||
    ['actor', 'sourceRef', 'rationale'].some((key) => typeof assertion[key] !== 'string' || !assertion[key].trim())
  )
    throw new Error('continuity requires an explicit gate-owner C2 actor, sourceRef and rationale');
  const paths = assertion.inertPaths;
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    paths.some(
      (file) =>
        typeof file !== 'string' ||
        !/^docs\/(?:plans\/[a-zA-Z0-9_/.-]+\.md|evidence\/[a-zA-Z0-9_/.-]+\.(?:md|png|jpe?g|webp))$/u.test(file) ||
        file.split('/').some((part) => !part || part === '.' || part === '..'),
    )
  )
    throw new Error('C2 accepts only exact delivery-document file paths, never roots or globs');
  if (new Set(paths).size !== paths.length || JSON.stringify([...paths].sort()) !== JSON.stringify(delta))
    throw new Error('C2 inert paths must exactly cover the machine-computed base delta');
  return {
    actor: assertion.actor,
    sourceRef: assertion.sourceRef,
    rationale: assertion.rationale,
    inertPaths: [...paths].sort(),
  };
}

function documentDelta(repoRoot, oldEntries, newEntries, paths) {
  const oldMap = new Map(oldEntries.map((entry) => [entry.path, entry]));
  const newMap = new Map(newEntries.map((entry) => [entry.path, entry]));
  return paths.map((filePath) => {
    const before = oldMap.get(filePath) ?? null;
    const after = newMap.get(filePath) ?? null;
    if (!before && !after) throw new Error('C2 path has no frozen blob');
    for (const entry of [before, after].filter(Boolean)) {
      if (
        entry.type !== 'blob' ||
        !['100644', '100755'].includes(entry.mode) ||
        git(repoRoot, ['cat-file', '-t', entry.oid]).trim() !== 'blob'
      )
        throw new Error('C2 paths must be available regular-file blobs; symlinks and gitlinks are forbidden');
    }
    return { path: filePath, before, after };
  });
}

function sourceRun(repoRoot, databasePath, runId) {
  const run = readGateRun(databasePath, runId);
  if (
    !run ||
    run.state !== 'terminal' ||
    run.terminalStatus !== 'green' ||
    run.reuseEligible === false ||
    !gateRunHasScope(run, 'merge') ||
    run.result?.route !== 'full'
  )
    throw new Error('continuity source must be a non-invalidated terminal full-green run');
  const { headSha, baseSha, treeSha, patchId } = run.result;
  exactCommit(repoRoot, headSha);
  exactCommit(repoRoot, baseSha);
  if (!patchId || git(repoRoot, ['rev-parse', `${headSha}^{tree}`]).trim() !== treeSha)
    throw new Error('continuity source has incomplete or inconsistent frozen identities');
  git(repoRoot, ['merge-base', '--is-ancestor', baseSha, headSha]);
  return run;
}

function originGit(repoRoot, args) {
  try {
    return git(repoRoot, args).trim();
  } catch {
    throw new Error('GATE_CONTINUITY_ORIGIN_UNAVAILABLE: origin query failed');
  }
}

function originDigest(repoRoot) {
  return gateFingerprintFromComponents({ originUrl: originGit(repoRoot, ['remote', 'get-url', 'origin']) });
}

function isIntegrationIdentity(integration) {
  return (
    integration &&
    Object.keys(integration).length === 4 &&
    integration.remote === 'origin' &&
    integration.ref === 'refs/heads/main' &&
    OID.test(integration.sha ?? '') &&
    CLAIM_ID.test(integration.urlDigest ?? '')
  );
}

function assertIntegrationBinding(repoRoot, integration, baseSha) {
  if (
    !isIntegrationIdentity(integration) ||
    integration.sha !== baseSha ||
    integration.urlDigest !== originDigest(repoRoot)
  )
    throw new Error('continuity canonical integration cut binding changed');
}

// Observe the live remote directly, without trusting a possibly stale local
// tracking ref or mutating the shared FETCH_HEAD used by other worktrees.
export function createGateContinuityClaim(args) {
  const urlDigest = originDigest(args.repoRoot);
  const advertised = originGit(args.repoRoot, ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']);
  const [sha, ref, ...extra] = advertised.split(/\s+/u);
  if (!OID.test(sha ?? '') || ref !== 'refs/heads/main' || extra.length || sha !== args.baseSha)
    throw new Error('base must equal the observed canonical integration cut at origin/main');
  return buildGateContinuityClaim(args, { remote: 'origin', ref, urlDigest, sha });
}

// C2 is an explicit gate-owner assertion, NOT machine proof that a process did
// not read a document. The machine binds its exact scope to immutable inputs;
// only the separate C3/merge authority can accept the still-owed checks.
function buildGateContinuityClaim(
  { repoRoot, databasePath, runId, baseSha, assertion, invocationArgs = [] },
  integration,
) {
  assertIntegrationBinding(repoRoot, integration, baseSha);
  const previous = sourceRun(repoRoot, databasePath, runId);
  exactCommit(repoRoot, baseSha);
  const headSha = git(repoRoot, ['rev-parse', 'HEAD']).trim();
  git(repoRoot, ['merge-base', '--is-ancestor', previous.result.baseSha, baseSha]);
  git(repoRoot, ['merge-base', '--is-ancestor', baseSha, headSha]);
  const delta = git(repoRoot, ['diff', '--no-renames', '--name-only', '-z', `${previous.result.baseSha}..${baseSha}`])
    .split('\0')
    .filter(Boolean)
    .sort();
  const c2 = assertC2Assertion(assertion, delta);
  const authoredPaths = git(repoRoot, ['diff', '--no-renames', '--name-only', '-z', `${baseSha}...HEAD`]).split('\0');
  if (delta.some((file) => authoredPaths.includes(file)))
    throw new Error('C2 base delta intersects the authored patch');
  const patchId = stablePatchId(repoRoot, baseSha);
  if (!patchId || patchId !== previous.result.patchId) throw new Error('continuity authored patch changed');
  const { fingerprint, components } = computeGateFingerprint(repoRoot, invocationArgs);
  if (gateFingerprintFromComponents({ ...components, tree: previous.result.treeSha }) !== previous.fingerprint)
    throw new Error('continuity runner/config/lock/toolchain/invocation identity changed');
  if (hasBlockingGateEvidence(databasePath, fingerprint))
    throw new Error('current exact inputs already have active, non-green or invalidated gate evidence');
  const oldEntries = treeEntries(repoRoot, previous.result.treeSha);
  const newEntries = treeEntries(repoRoot, components.tree);
  const inert = new Set(delta);
  const oldDigest = gateFingerprintFromComponents(oldEntries.filter((entry) => !inert.has(entry.path)));
  const newDigest = gateFingerprintFromComponents(newEntries.filter((entry) => !inert.has(entry.path)));
  if (oldDigest !== newDigest) throw new Error('non-inert frozen inputs changed');
  if (
    git(repoRoot, ['rev-parse', 'HEAD']).trim() !== headSha ||
    git(repoRoot, ['status', '--porcelain', '--untracked-files=all']).trim()
  )
    throw new Error('continuity inputs changed while binding the claim');
  sourceRun(repoRoot, databasePath, runId);
  const packet = {
    schemaVersion: 3,
    policy: CONTINUITY_POLICY,
    integration,
    authority: 'gate-owner-C2-assertion-not-machine-input-closure',
    c2,
    source: {
      runId: previous.runId,
      fingerprint: previous.fingerprint,
      baseSha: previous.result.baseSha,
      headSha: previous.result.headSha,
      treeSha: previous.result.treeSha,
      patchId,
    },
    target: { baseSha, headSha, treeSha: components.tree, fingerprint },
    invocationArgs,
    nonInertDigest: oldDigest,
    delta: documentDelta(repoRoot, oldEntries, newEntries, delta),
    requiredChecks: [...CONTINUITY_CHECKS],
  };
  return { ...packet, claimHash: gateFingerprintFromComponents(packet) };
}

function claimPath(databasePath, claimHash) {
  if (!CLAIM_ID.test(claimHash ?? '')) throw new Error('invalid continuity claim id');
  return path.join(path.dirname(path.resolve(databasePath)), 'cat-cafe-gate-continuity-claims', `${claimHash}.json`);
}

export function readGateContinuityClaim(databasePath, claimHash) {
  const file = claimPath(databasePath, claimHash);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('invalid continuity claim artifact');
  let decoded;
  try {
    decoded = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('continuity claim artifact is unreadable');
  }
  const { claimHash: storedHash, ...packet } = decoded;
  if (
    storedHash !== claimHash ||
    gateFingerprintFromComponents(packet) !== claimHash ||
    packet.schemaVersion !== 3 ||
    packet.policy !== CONTINUITY_POLICY ||
    !isIntegrationIdentity(packet.integration) ||
    !OID.test(packet.target?.baseSha ?? '')
  )
    throw new Error('continuity claim hash/policy identity mismatch');
  return { ...packet, claimHash };
}

export function writeGateContinuityClaim(databasePath, claim) {
  const file = claimPath(databasePath, claim.claimHash);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file)) readGateContinuityClaim(databasePath, claim.claimHash);
  else writeFileSync(file, `${JSON.stringify(claim)}\n`, { flag: 'wx', mode: 0o600 });
  return file;
}

export function validateGateContinuityClaim({ repoRoot, databasePath, claimHash, baseSha, invocationArgs = [] }) {
  const claim = readGateContinuityClaim(databasePath, claimHash);
  if (claim.target.baseSha !== baseSha) throw new Error('continuity claim belongs to a different base');
  const current = buildGateContinuityClaim(
    {
      repoRoot,
      databasePath,
      runId: claim.source?.runId,
      baseSha,
      assertion: claim.c2,
      invocationArgs,
    },
    claim.integration,
  );
  if (current.claimHash !== claimHash) throw new Error('continuity claim is stale for the current exact inputs');
  return current;
}
