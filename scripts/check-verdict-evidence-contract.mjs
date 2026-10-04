#!/usr/bin/env node

/**
 * F192 / F248 verdict evidence contract guard (post-commit).
 *
 * Called by verdict-publish-contract-runner.ts when sourceRef === 'HEAD'
 * (after generator + commit, before push). Validates structural integrity
 * of generated evidence artifacts in the candidate worktree.
 *
 * Checks:
 *   1. Lifecycle-root identity: verdictId must match bundle directory name.
 *   2. Lifecycle-root required fields: validates the mandatory fields per
 *      schema version (v1/v2/v3), equivalent to LifecycleRootArtifactSchema.
 *   3. Snapshot structural: window.{startMs, endMs} must be present numbers.
 *   4. Duplicate verdictId detection: no two bundles may share the same
 *      verdictId (identity collision guard; domain/window collision semantics
 *      are domain-specific — e.g. friction emits aggregate + child bundles
 *      with the same domain/window — and are handled by the publisher pipeline).
 *
 * Historical bundles that predate lifecycle-root.json are tolerated
 * (they only have attribution.json + provenance.json + snapshot.json).
 *
 * Error codes written to stderr; non-zero exit on failure.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    'candidate-root': { type: 'string' },
    'api-dist-root': { type: 'string' },
    'git-root': { type: 'string' },
  },
  strict: true,
});

const candidateRoot = args['candidate-root'];
if (!candidateRoot) {
  fail('ARGS_MISSING', '--candidate-root is required');
}

function fail(code, detail) {
  process.stderr.write(`${code}: ${detail}\n`);
  process.exit(1);
}

// --- domainId format: must match ^eval:[a-z0-9][a-z0-9-]*$ ---
const DOMAIN_ID_RE = /^eval:[a-z0-9][a-z0-9-]*$/;

// --- Verdict enum (canonical LifecycleRootArtifactSchema) ---
const VALID_VERDICTS = new Set(['delete_sunset', 'build', 'fix', 'keep_observe']);

/**
 * Validate lifecycle-root required fields per schema version.
 * Mirrors LifecycleRootArtifactSchema (v1/v2/v3) without Zod imports.
 */
function validateLifecycleRoot(root, bundleName) {
  const pfx = `${bundleName}/lifecycle-root.json`;

  // --- Base fields (all versions) ---
  requireString(root, 'verdictId', pfx);
  requireString(root, 'domainId', pfx);
  if (!DOMAIN_ID_RE.test(root.domainId)) {
    fail('LIFECYCLE_ROOT_INVALID', `${pfx} domainId '${root.domainId}' does not match eval:xxx format`);
  }
  requireString(root, 'createdAt', pfx);
  requireString(root, 'verdict', pfx);
  if (!VALID_VERDICTS.has(root.verdict)) {
    fail('LIFECYCLE_ROOT_INVALID', `${pfx} verdict '${root.verdict}' is not one of: ${[...VALID_VERDICTS].join(', ')}`);
  }
  requireObject(root, 'harnessUnderEval', pfx);
  const hue = root.harnessUnderEval;
  requireString(hue, 'featureId', `${pfx}.harnessUnderEval`);
  requireString(hue, 'componentId', `${pfx}.harnessUnderEval`);
  requireString(hue, 'name', `${pfx}.harnessUnderEval`);

  requireObject(root, 'ownerAsk', pfx);
  const oa = root.ownerAsk;
  requireString(oa, 'targetFeatureId', `${pfx}.ownerAsk`);
  requireString(oa, 'targetOwnerCatId', `${pfx}.ownerAsk`);
  requireString(oa, 'requestedAction', `${pfx}.ownerAsk`);

  requireObject(root, 'acceptanceReevalPlan', pfx);
  const arp = root.acceptanceReevalPlan;
  requireString(arp, 'nextEvalAt', `${pfx}.acceptanceReevalPlan`);
  requireString(arp, 'closureCondition', `${pfx}.acceptanceReevalPlan`);

  // --- Schema version ---
  if (typeof root.schemaVersion !== 'number') {
    fail('LIFECYCLE_ROOT_INVALID', `${pfx} missing schemaVersion`);
  }
  if (![1, 2, 3].includes(root.schemaVersion)) {
    fail('LIFECYCLE_ROOT_INVALID', `${pfx} schemaVersion ${root.schemaVersion} is not 1, 2, or 3`);
  }

  // --- V2+ fields ---
  if (root.schemaVersion >= 2) {
    requireString(root, 'caseId', pfx);
    requireString(root, 'findingKey', pfx);
  }

  // --- V3 fields ---
  if (root.schemaVersion >= 3) {
    requireObject(root, 'findingBinding', pfx);
    requireObject(root, 'repairTarget', pfx);
  }
}

function requireString(obj, key, pfx) {
  if (typeof obj[key] !== 'string' || !obj[key].trim()) {
    fail('LIFECYCLE_ROOT_INVALID', `${pfx} missing or empty required string field '${key}'`);
  }
}

function requireObject(obj, key, pfx) {
  if (typeof obj[key] !== 'object' || obj[key] === null || Array.isArray(obj[key])) {
    fail('LIFECYCLE_ROOT_INVALID', `${pfx} missing or invalid required object field '${key}'`);
  }
}

const bundlesDir = join(candidateRoot, 'docs/harness-feedback/bundles');
if (!existsSync(bundlesDir)) {
  // No bundles directory = nothing to validate (fresh repo bootstrap)
  process.exit(0);
}

const entries = readdirSync(bundlesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name));

// Domain+window collision: within-candidate, same {domainId, startMs, endMs}
// is only allowed for friction families (v3 children sharing a parent's window).
// Non-friction duplicates = collision error (matches git-worktree-publisher.ts:213-222).
const windowMap = new Map(); // key → first verdictId

for (const entry of entries) {
  const bundleDir = join(bundlesDir, entry.name);
  const lifecycleRootPath = join(bundleDir, 'lifecycle-root.json');
  if (!existsSync(lifecycleRootPath)) continue;

  let root;
  try {
    root = JSON.parse(readFileSync(lifecycleRootPath, 'utf8'));
  } catch (err) {
    fail('LIFECYCLE_ROOT_INVALID', `${entry.name}/lifecycle-root.json is not valid JSON: ${err.message}`);
  }

  if (typeof root.verdictId !== 'string' || !root.verdictId) {
    fail('LIFECYCLE_ROOT_INVALID', `${entry.name}/lifecycle-root.json missing verdictId`);
  }
  if (root.verdictId !== entry.name) {
    fail(
      'LIFECYCLE_ROOT_IDENTITY_MISMATCH',
      `${entry.name}/lifecycle-root.json verdictId '${root.verdictId}' does not match directory '${entry.name}'`,
    );
  }

  validateLifecycleRoot(root, entry.name);

  // Snapshot is required when lifecycle-root.json exists
  const snapshotPath = join(bundleDir, 'snapshot.json');
  if (!existsSync(snapshotPath)) {
    fail('SNAPSHOT_MISSING', `${entry.name}/snapshot.json is required when lifecycle-root.json exists`);
  }
  let snap;
  try {
    snap = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  } catch (err) {
    fail('SNAPSHOT_INVALID', `${entry.name}/snapshot.json is not valid JSON: ${err.message}`);
  }
  if (typeof snap.window !== 'object' || snap.window === null) {
    fail('SNAPSHOT_INVALID', `${entry.name}/snapshot.json missing required 'window' object`);
  }
  if (typeof snap.window.startMs !== 'number') {
    fail('SNAPSHOT_INVALID', `${entry.name}/snapshot.json window.startMs must be a number`);
  }
  if (typeof snap.window.endMs !== 'number') {
    fail('SNAPSHOT_INVALID', `${entry.name}/snapshot.json window.endMs must be a number`);
  }

  // Provenance: required when lifecycle-root exists (fail-closed, not warn-only)
  const provPath = join(bundleDir, 'provenance.json');
  if (!existsSync(provPath)) {
    fail('PROVENANCE_MISSING', `${entry.name}/provenance.json is required when lifecycle-root.json exists`);
  }
  try {
    const prov = JSON.parse(readFileSync(provPath, 'utf8'));
    if (typeof prov !== 'object' || prov === null || Array.isArray(prov)) {
      fail('PROVENANCE_INVALID', `${entry.name}/provenance.json must be a JSON object`);
    }
    if (Object.keys(prov).length === 0) {
      fail('PROVENANCE_EMPTY', `${entry.name}/provenance.json is an empty object — provenance must have content`);
    }
  } catch (err) {
    fail('PROVENANCE_INVALID', `${entry.name}/provenance.json is not valid JSON: ${err.message}`);
  }

  // Domain+window collision detection
  const windowKey = `${root.domainId}:${snap.window.startMs}:${snap.window.endMs}`;
  // Schema-v3 friction child: must be eval:friction domain with canonical
  // FindingBindingV1 (artifactSha256 = 64-char lowercase hex) proving a real
  // binding to a finding artifact. parentVerdictId is in the finding artifact,
  // not the lifecycle root — structural presence of a valid binding hash is the
  // root-level signal that this is a legitimate friction child.
  const isFrictionChild =
    root.schemaVersion >= 3 &&
    root.domainId === 'eval:friction' &&
    typeof root.findingBinding === 'object' &&
    root.findingBinding !== null &&
    typeof root.findingBinding.artifactSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(root.findingBinding.artifactSha256) &&
    typeof root.repairTarget === 'object' &&
    root.repairTarget !== null;
  if (windowMap.has(windowKey)) {
    const existing = windowMap.get(windowKey);
    // Allow if both are in the same friction family (either is a v3 child)
    if (!existing.isFrictionChild && !isFrictionChild) {
      fail(
        'WINDOW_COLLISION',
        `bundles '${existing.verdictId}' and '${entry.name}' have the same domain+window ` +
          `(${windowKey}) and neither is a friction child — duplicate publication`,
      );
    }
  } else {
    windowMap.set(windowKey, { verdictId: entry.name, isFrictionChild });
  }
}
