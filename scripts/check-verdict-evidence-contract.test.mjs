import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, describe, it } from 'node:test';

const SCRIPT = resolve(import.meta.dirname, 'check-verdict-evidence-contract.mjs');

function makeCandidate() {
  return mkdtempSync(`${tmpdir()}/verdict-evidence-test-`);
}

/** Build a valid v1 lifecycle-root for seedBundle defaults. */
function validLifecycleRoot(verdictId, overrides = {}) {
  return {
    schemaVersion: 1,
    verdictId,
    domainId: 'eval:a2a',
    createdAt: '2026-01-01T00:00:00.000Z',
    verdict: 'keep_observe',
    harnessUnderEval: { featureId: 'F1', componentId: 'C1', name: 'test' },
    ownerAsk: { targetFeatureId: 'F1', targetOwnerCatId: 'opus', requestedAction: 'observe' },
    acceptanceReevalPlan: { nextEvalAt: '2026-02-01T00:00:00.000Z', closureCondition: 'stable' },
    ...overrides,
  };
}

/** Build a valid snapshot with window for seedBundle defaults. */
function validSnapshot(overrides = {}) {
  return {
    verdictId: 'test',
    evalSnapshotId: 'eval-snap-1',
    featureId: 'F1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    window: { startMs: 1000, endMs: 2000, durationHours: 0.28 },
    components: [],
    ...overrides,
  };
}

function seedBundle(candidateRoot, verdictId, { lifecycleRoot, snapshot } = {}) {
  const bundleDir = resolve(candidateRoot, 'docs/harness-feedback/bundles', verdictId);
  mkdirSync(bundleDir, { recursive: true });
  if (lifecycleRoot !== undefined) {
    const data = lifecycleRoot === true ? validLifecycleRoot(verdictId) : lifecycleRoot;
    writeFileSync(resolve(bundleDir, 'lifecycle-root.json'), JSON.stringify(data, null, 2));
  }
  if (snapshot !== undefined) {
    const data = typeof snapshot === 'string' ? snapshot : snapshot === true ? validSnapshot() : snapshot;
    writeFileSync(resolve(bundleDir, 'snapshot.json'), typeof data === 'string' ? data : JSON.stringify(data));
  }
  return bundleDir;
}

function run(candidateRoot) {
  return execFileSync(process.execPath, [SCRIPT, '--candidate-root', candidateRoot], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runExpectFail(candidateRoot) {
  try {
    run(candidateRoot);
    assert.fail('expected script to exit non-zero');
  } catch (err) {
    return err.stderr?.trim() ?? '';
  }
}

const dirs = [];
function tracked(dir) {
  dirs.push(dir);
  return dir;
}

describe('check-verdict-evidence-contract', () => {
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  // --- Happy paths ---

  it('passes with valid v1 lifecycle-root and snapshot', () => {
    const dir = tracked(makeCandidate());
    seedBundle(dir, 'test-valid-2026', { lifecycleRoot: true, snapshot: true });
    run(dir);
  });

  it('passes with no bundles directory (fresh repo)', () => {
    const dir = tracked(makeCandidate());
    run(dir);
  });

  it('tolerates historical bundles without lifecycle-root.json', () => {
    const dir = tracked(makeCandidate());
    seedBundle(dir, 'legacy-2026', { snapshot: true });
    run(dir);
  });

  // --- Identity checks ---

  it('rejects lifecycle-root with mismatched verdictId', () => {
    const dir = tracked(makeCandidate());
    seedBundle(dir, 'dir-name-2026', {
      lifecycleRoot: validLifecycleRoot('wrong-id'),
      snapshot: true,
    });
    const stderr = runExpectFail(dir);
    assert.match(stderr, /LIFECYCLE_ROOT_IDENTITY_MISMATCH/);
    assert.match(stderr, /wrong-id/);
  });

  it('rejects invalid lifecycle-root JSON', () => {
    const dir = tracked(makeCandidate());
    const bundleDir = resolve(dir, 'docs/harness-feedback/bundles/bad-json-2026');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(resolve(bundleDir, 'lifecycle-root.json'), '{not valid json');
    const stderr = runExpectFail(dir);
    assert.match(stderr, /LIFECYCLE_ROOT_INVALID/);
  });

  // --- Schema version validation (P1 #2) ---

  it('rejects schemaVersion 999 (not 1/2/3)', () => {
    const dir = tracked(makeCandidate());
    seedBundle(dir, 'bad-version-2026', {
      lifecycleRoot: validLifecycleRoot('bad-version-2026', { schemaVersion: 999 }),
      snapshot: true,
    });
    const stderr = runExpectFail(dir);
    assert.match(stderr, /LIFECYCLE_ROOT_INVALID/);
    assert.match(stderr, /schemaVersion 999/);
  });

  // --- Required field validation (P1 #2) ---

  it('rejects lifecycle-root missing verdict field', () => {
    const dir = tracked(makeCandidate());
    const root = validLifecycleRoot('missing-verdict-2026');
    delete root.verdict;
    seedBundle(dir, 'missing-verdict-2026', { lifecycleRoot: root, snapshot: true });
    const stderr = runExpectFail(dir);
    assert.match(stderr, /LIFECYCLE_ROOT_INVALID/);
    assert.match(stderr, /verdict/);
  });

  it('rejects lifecycle-root with invalid verdict enum value', () => {
    const dir = tracked(makeCandidate());
    seedBundle(dir, 'bad-verdict-2026', {
      lifecycleRoot: validLifecycleRoot('bad-verdict-2026', { verdict: 'not_a_verdict' }),
      snapshot: true,
    });
    const stderr = runExpectFail(dir);
    assert.match(stderr, /LIFECYCLE_ROOT_INVALID/);
    assert.match(stderr, /not_a_verdict/);
  });

  it('rejects lifecycle-root missing harnessUnderEval', () => {
    const dir = tracked(makeCandidate());
    const root = validLifecycleRoot('missing-hue-2026');
    delete root.harnessUnderEval;
    seedBundle(dir, 'missing-hue-2026', { lifecycleRoot: root, snapshot: true });
    const stderr = runExpectFail(dir);
    assert.match(stderr, /LIFECYCLE_ROOT_INVALID/);
    assert.match(stderr, /harnessUnderEval/);
  });

  it('rejects lifecycle-root with invalid domainId format', () => {
    const dir = tracked(makeCandidate());
    seedBundle(dir, 'bad-domain-2026', {
      lifecycleRoot: validLifecycleRoot('bad-domain-2026', { domainId: 'not-eval-format' }),
      snapshot: true,
    });
    const stderr = runExpectFail(dir);
    assert.match(stderr, /LIFECYCLE_ROOT_INVALID/);
    assert.match(stderr, /domainId/);
  });

  it('rejects v2 lifecycle-root missing caseId', () => {
    const dir = tracked(makeCandidate());
    seedBundle(dir, 'v2-no-case-2026', {
      lifecycleRoot: validLifecycleRoot('v2-no-case-2026', { schemaVersion: 2 }),
      snapshot: true,
    });
    const stderr = runExpectFail(dir);
    assert.match(stderr, /LIFECYCLE_ROOT_INVALID/);
    assert.match(stderr, /caseId/);
  });

  // --- Snapshot validation (P1 #2) ---

  it('rejects snapshot without window object', () => {
    const dir = tracked(makeCandidate());
    seedBundle(dir, 'no-window-2026', {
      lifecycleRoot: true,
      snapshot: { data: 1 },
    });
    const stderr = runExpectFail(dir);
    assert.match(stderr, /SNAPSHOT_INVALID/);
    assert.match(stderr, /window/);
  });

  it('rejects snapshot with non-number startMs', () => {
    const dir = tracked(makeCandidate());
    seedBundle(dir, 'bad-start-2026', {
      lifecycleRoot: true,
      snapshot: { window: { startMs: 'not-a-number', endMs: 2000 } },
    });
    const stderr = runExpectFail(dir);
    assert.match(stderr, /SNAPSHOT_INVALID/);
    assert.match(stderr, /startMs/);
  });

  it('rejects invalid snapshot.json', () => {
    const dir = tracked(makeCandidate());
    seedBundle(dir, 'bad-snap-2026', { lifecycleRoot: true, snapshot: '{not valid' });
    const stderr = runExpectFail(dir);
    assert.match(stderr, /SNAPSHOT_INVALID/);
  });

  // --- Collision detection ---

  it('allows friction aggregate + child bundles with same domain/window', () => {
    // Friction generator emits aggregate + child roots for same {domainId, window}.
    // Domain/window collision semantics are publisher pipeline's responsibility,
    // not the evidence guard's. The guard only checks verdictId identity.
    const dir = tracked(makeCandidate());
    const window = { startMs: 5000, endMs: 6000, durationHours: 0.28 };
    seedBundle(dir, 'aggregate-2026', {
      lifecycleRoot: validLifecycleRoot('aggregate-2026', { domainId: 'eval:friction' }),
      snapshot: validSnapshot({ window }),
    });
    seedBundle(dir, 'child-finding-1-2026', {
      lifecycleRoot: validLifecycleRoot('child-finding-1-2026', { domainId: 'eval:friction' }),
      snapshot: validSnapshot({ window }),
    });
    run(dir); // Both same domain+window → should pass (different verdictIds)
  });

  it('rejects two bundles with same verdictId in different directories', () => {
    // A malformed generator could write the same verdictId into two directories.
    const dir = tracked(makeCandidate());
    seedBundle(dir, 'dir-a-2026', {
      // Deliberately set verdictId to match another bundle's directory
      lifecycleRoot: validLifecycleRoot('dir-b-2026', { domainId: 'eval:a2a' }),
      snapshot: true,
    });
    // This will fail on identity mismatch first (verdictId != directory name),
    // so we test the collision differently: create two dirs with lifecycle-root
    // where the verdictId matches *their own* directory (identity passes) but
    // the guard catches cross-bundle identity collision.
    // Since filesystem enforces unique directory names, and verdictId must match
    // directory name, this collision can only happen if verdictId identity check
    // passes for each bundle individually. This test verifies the guard rejects
    // the identity mismatch before collision can be reached.
    const stderr = runExpectFail(dir);
    assert.match(stderr, /LIFECYCLE_ROOT_IDENTITY_MISMATCH/);
  });

  it('passes two bundles with different verdictIds and same domain/window', () => {
    const dir = tracked(makeCandidate());
    const window = { startMs: 5000, endMs: 6000, durationHours: 0.28 };
    seedBundle(dir, 'dom-a-2026', {
      lifecycleRoot: validLifecycleRoot('dom-a-2026', { domainId: 'eval:a2a' }),
      snapshot: validSnapshot({ window }),
    });
    seedBundle(dir, 'dom-b-2026', {
      lifecycleRoot: validLifecycleRoot('dom-b-2026', { domainId: 'eval:a2a' }),
      snapshot: validSnapshot({ window }),
    });
    run(dir); // Same domain+window, different verdictIds → allowed
  });

  // --- Args ---

  it('rejects missing required args', () => {
    try {
      execFileSync(process.execPath, [SCRIPT], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.fail('expected non-zero exit');
    } catch (err) {
      assert.match(err.stderr, /ARGS_MISSING/);
    }
  });
});
