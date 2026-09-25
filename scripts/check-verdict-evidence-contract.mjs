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

// Duplicate verdictId detection. Directory names are unique on the filesystem,
// but lifecycle-root.json verdictId must also be unique across all bundles
// (a malformed generator could write the same verdictId into two different directories).
// Domain+window collision is NOT checked here: friction legitimately emits
// aggregate + child bundles for the same {domainId, startMs, endMs};
// the publisher pipeline owns domain-specific collision semantics.
const seenVerdictIds = new Map();

for (const entry of entries) {
  const bundleDir = join(bundlesDir, entry.name);
  const lifecycleRootPath = join(bundleDir, 'lifecycle-root.json');

  // Historical bundles without lifecycle-root.json are tolerated
  if (!existsSync(lifecycleRootPath)) continue;

  let root;
  try {
    root = JSON.parse(readFileSync(lifecycleRootPath, 'utf8'));
  } catch (err) {
    fail('LIFECYCLE_ROOT_INVALID', `${entry.name}/lifecycle-root.json is not valid JSON: ${err.message}`);
  }

  // Identity check: verdictId must match bundle directory name
  if (typeof root.verdictId !== 'string' || !root.verdictId) {
    fail('LIFECYCLE_ROOT_INVALID', `${entry.name}/lifecycle-root.json missing verdictId`);
  }
  if (root.verdictId !== entry.name) {
    fail(
      'LIFECYCLE_ROOT_IDENTITY_MISMATCH',
      `${entry.name}/lifecycle-root.json verdictId '${root.verdictId}' does not match directory '${entry.name}'`,
    );
  }

  // Full structural validation (canonical schema fields)
  validateLifecycleRoot(root, entry.name);

  // Snapshot structural + window extraction
  const snapshotPath = join(bundleDir, 'snapshot.json');
  let snapshotWindow = null;
  if (existsSync(snapshotPath)) {
    let snap;
    try {
      snap = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    } catch (err) {
      fail('SNAPSHOT_INVALID', `${entry.name}/snapshot.json is not valid JSON: ${err.message}`);
    }
    // Snapshot must have window.{startMs, endMs}
    if (typeof snap.window !== 'object' || snap.window === null) {
      fail('SNAPSHOT_INVALID', `${entry.name}/snapshot.json missing required 'window' object`);
    }
    if (typeof snap.window.startMs !== 'number') {
      fail('SNAPSHOT_INVALID', `${entry.name}/snapshot.json window.startMs must be a number`);
    }
    if (typeof snap.window.endMs !== 'number') {
      fail('SNAPSHOT_INVALID', `${entry.name}/snapshot.json window.endMs must be a number`);
    }
    snapshotWindow = { startMs: snap.window.startMs, endMs: snap.window.endMs };
  }

  // Duplicate verdictId detection (cross-directory identity collision)
  if (seenVerdictIds.has(root.verdictId)) {
    fail(
      'verdict_window_duplicated_in_candidate',
      `verdictId '${root.verdictId}' declared in multiple bundle directories: ` +
        `'${seenVerdictIds.get(root.verdictId)}' and '${entry.name}'`,
    );
  }
  seenVerdictIds.set(root.verdictId, entry.name);
}
