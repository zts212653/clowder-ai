import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGateTerminalResult, deriveGateRoute } from '../classify-gate-route.mjs';
import {
  createGateContinuityClaim,
  readGateContinuityClaim,
  validateGateContinuityClaim,
  writeGateContinuityClaim,
} from './gate-continuity-claim.mjs';
import { fixture, INPUT, READERS, REPORT } from './gate-continuity-claim-fixture.mjs';
import { openGateResourcePool } from './gate-resource-db.mjs';
import { markGateStageGreen } from './gate-stage-receipts.mjs';
import {
  beginGateRun,
  gateFingerprintFromComponents,
  listGateRuns,
  readGateRun,
  settleGateRun,
} from './gate-terminal-receipt.mjs';

const CLI = fileURLToPath(new URL('../gate-continuity-claim.mjs', import.meta.url));

for (const reader of READERS) {
  test(`${reader[0]} stays full without an explicit C2 claim, including after a full-green run`, (t) => {
    if (reader[3] === 'python3' && spawnSync('python3', ['--version']).status !== 0) {
      t.skip('Python is unavailable; this optional real non-JS process probe cannot run');
      return;
    }
    const f = fixture(t, { reader });
    const baseSha = f.advance(() => f.write(INPUT, 'changed execution input'));
    const next = deriveGateRoute(f.args(baseSha));
    assert.equal(next.patchId, f.first.patchId);
    assert.equal(next.route, 'full');
    assert.equal(next.continuityClaim, null);
    assert.equal(existsSync(path.join(f.root, '.git', 'cat-cafe-gate-continuity-claims')), false);
  });
}

test('producer and consumer bind an explicit C2 assertion without rewriting the old full receipt', (t) => {
  const f = fixture(t);
  const baseSha = f.advance();
  const args = f.args(baseSha);
  const before = readGateRun(f.databasePath, f.run.runId);
  const claim = createGateContinuityClaim(args);
  assert.equal(createGateContinuityClaim(args).claimHash, claim.claimHash);
  const artifact = writeGateContinuityClaim(f.databasePath, claim);
  assert.equal(writeGateContinuityClaim(f.databasePath, claim), artifact);
  assert.equal(validateGateContinuityClaim({ ...args, claimHash: claim.claimHash }).claimHash, claim.claimHash);
  const next = deriveGateRoute({ ...args, continuityClaimId: claim.claimHash });
  assert.equal(next.route, 'targeted');
  assert.equal(next.mergeReady, false);
  assert.equal(next.reusesFullGreen, false);
  assert.equal(next.continuityClaim.claimHash, claim.claimHash);
  assert.match(next.continuityClaim.authority, /not-machine-input-closure/);
  assert.deepEqual(next.requiredChecks, [
    'risk-matched-targeted-evidence',
    'cross-package-typecheck',
    'docs-validation',
  ]);
  assert.deepEqual(readGateRun(f.databasePath, f.run.runId), before);
  assert.equal(listGateRuns(f.databasePath).length, 1);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(existsSync(path.join(f.root, '.gate-last-run')), false);
});

test('real CLI recomputes bindings and preserves original gate argv separately from claim controls', (t) => {
  const f = fixture(t);
  const baseSha = f.advance();
  const result = spawnSync(
    process.execPath,
    [
      CLI,
      'create',
      '--run-id',
      f.run.runId,
      '--base-sha',
      baseSha,
      '--actor',
      'gate-owner-test',
      '--source-ref',
      'thread_fixture#C2',
      '--rationale',
      'reviewed report',
      '--assert-inert-path',
      REPORT,
    ],
    { cwd: f.root, env: { ...process.env, CAT_CAFE_FULL_GATE_RESOURCE_DB_PATH: f.databasePath }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const { claimHash, claim } = JSON.parse(result.stdout);
  assert.deepEqual(claim.invocationArgs, []);
  const inspected = spawnSync(process.execPath, [CLI, 'inspect', '--claim-id', claimHash], {
    cwd: f.root,
    env: { ...process.env, CAT_CAFE_FULL_GATE_RESOURCE_DB_PATH: f.databasePath },
    encoding: 'utf8',
  });
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).claimHash, claimHash);
  const wrongArgs = deriveGateRoute({
    ...f.args(baseSha),
    invocationArgs: ['--risk', 'contract'],
    continuityClaimId: claimHash,
  });
  assert.equal(wrongArgs.route, 'full');
  assert.match(wrongArgs.continuityClaim.reason, /invocation/);
});

test('claims cannot omit base paths, use roots/globs, intersect the patch, or hide source renames', (t) => {
  const f = fixture(t);
  const baseSha = f.advance(() => {
    f.write(REPORT, 'new');
    f.write('docs/plans/report.md', 'new');
  });
  assert.throws(() => createGateContinuityClaim(f.args(baseSha)), /exactly cover/);
  for (const paths of [['docs/evidence/'], ['docs/evidence/*.png'], [REPORT, REPORT]])
    assert.throws(() => createGateContinuityClaim(f.args(baseSha, paths)));
  const sourceBase = f.advance(() => f.git('mv', 'packages/shared/contract.ts', 'docs/plans/retired.md'));
  assert.throws(
    () => createGateContinuityClaim(f.args(sourceBase, [REPORT, 'docs/plans/report.md', 'docs/plans/retired.md'])),
    /exactly cover/,
  );
});

test('regular added/deleted blobs are explicit tuples; symlinks cannot be declared inert', (t) => {
  const f = fixture(t);
  const added = 'docs/evidence/new.png';
  const baseSha = f.advance(() => {
    f.write(added, 'new');
    rmSync(path.join(f.root, REPORT));
  });
  const claim = createGateContinuityClaim(f.args(baseSha, [REPORT, added]));
  assert.equal(claim.delta.find((entry) => entry.path === added).before, null);
  assert.equal(claim.delta.find((entry) => entry.path === REPORT).after, null);
  const linkedBase = f.advance(() => symlinkSync('fixtures/input.md', path.join(f.root, REPORT)));
  assert.throws(() => createGateContinuityClaim(f.args(linkedBase, [REPORT, added])), /regular-file/);
});

test('non-inert digest rejects whitespace drift that stable patch-id alone does not distinguish', (t) => {
  const f = fixture(t);
  const baseSha = f.advance();
  f.write('packages/shared/contract.ts', 'export const value =  2;\n');
  f.commit('same patch-id, different source blob');
  assert.equal(deriveGateRoute(f.args(baseSha)).patchId, f.first.patchId);
  assert.throws(() => createGateContinuityClaim(f.args(baseSha)), /non-inert frozen inputs/);
});

test('C2 binds regular-file modes and refuses actual Git gitlink entries', (t) => {
  const f = fixture(t);
  const baseSha = f.advance(() => chmodSync(path.join(f.root, REPORT), 0o755));
  const claim = createGateContinuityClaim(f.args(baseSha));
  assert.equal(claim.delta[0].before.mode, '100644');
  assert.equal(claim.delta[0].after.mode, '100755');
  const link = 'docs/evidence/module.png';
  const linkedBase = f.advance(() => {
    mkdirSync(path.join(f.root, link), { recursive: true });
    f.git('update-index', '--add', '--cacheinfo', `160000,${f.git('rev-parse', 'HEAD')},${link}`);
  });
  mkdirSync(path.join(f.root, link), { recursive: true });
  assert.equal(f.git('status', '--porcelain'), '');
  assert.throws(() => createGateContinuityClaim(f.args(linkedBase, [REPORT, link])), /regular-file/);
});

test('a claim cannot override unknown policy or a current exact red', (t) => {
  const f = fixture(t);
  const baseSha = f.advance();
  const args = f.args(baseSha);
  const claim = createGateContinuityClaim(args);
  writeGateContinuityClaim(f.databasePath, claim);
  assert.equal(deriveGateRoute({ ...args, riskAxis: 'future-axis', continuityClaimId: claim.claimHash }).route, 'full');
  const current = deriveGateRoute(args);
  const run = beginGateRun({
    databasePath: f.databasePath,
    fingerprint: current.fingerprint,
    ownerIdentity: f.ownerIdentity,
    jobId: 'current-red',
  });
  settleGateRun({
    databasePath: f.databasePath,
    runId: run.runId,
    status: 'failed',
    requiredStages: [],
    result: createGateTerminalResult({ routeEvidence: current, status: 'failed' }),
  });
  assert.throws(() => validateGateContinuityClaim({ ...args, claimHash: claim.claimHash }), /current exact inputs/);
});

test('head-only drift, policy drift and tampered packet bytes make a claim stale', (t) => {
  const f = fixture(t);
  const baseSha = f.advance();
  const args = f.args(baseSha);
  const claim = createGateContinuityClaim(args);
  const artifact = writeGateContinuityClaim(f.databasePath, claim);
  f.git('commit', '--allow-empty', '-qm', 'same tree, different exact HEAD');
  assert.equal(deriveGateRoute({ ...args, continuityClaimId: claim.claimHash }).route, 'full');
  const { claimHash: _oldHash, ...packet } = claim;
  const changedPolicy = { ...packet, policy: 'future-policy' };
  const policyHash = gateFingerprintFromComponents(changedPolicy);
  writeGateContinuityClaim(f.databasePath, { ...changedPolicy, claimHash: policyHash });
  assert.throws(() => readGateContinuityClaim(f.databasePath, policyHash), /policy/);
  writeFileSync(artifact, JSON.stringify({ ...claim, nonInertDigest: 'forged' }));
  assert.throws(() => readGateContinuityClaim(f.databasePath, claim.claimHash), /hash/);
});

test('invalidated and non-full/non-green sources never authorize a claim', (t) => {
  for (const source of [{ status: 'failed' }, { route: 'targeted' }]) {
    const f = fixture(t, source);
    const baseSha = f.advance();
    assert.throws(() => createGateContinuityClaim(f.args(baseSha)), /terminal full-green/);
  }
  const f = fixture(t);
  const baseSha = f.advance();
  const args = f.args(baseSha);
  const claim = createGateContinuityClaim(args);
  writeGateContinuityClaim(f.databasePath, claim);
  beginGateRun({
    databasePath: f.databasePath,
    fingerprint: f.first.fingerprint,
    ownerIdentity: f.ownerIdentity,
    jobId: 'invalidate',
    recoveryBoundary: { pauseEpoch: 1, reconcileFrom: 0 },
  });
  assert.equal(deriveGateRoute({ ...args, continuityClaimId: claim.claimHash }).route, 'full');
});

for (const blockedStatus of ['active', 'failed', 'invalidated']) {
  test(`exact ${blockedStatus} evidence survives the history horizon at creation and consumption`, (t) => {
    const f = fixture(t);
    const baseSha = f.advance();
    const args = f.args(baseSha);
    const claim = createGateContinuityClaim(args);
    writeGateContinuityClaim(f.databasePath, claim);
    const now = Date.now();
    const run = beginGateRun({
      databasePath: f.databasePath,
      fingerprint: claim.target.fingerprint,
      ownerIdentity: f.ownerIdentity,
      jobId: 'target',
      now,
    });
    if (blockedStatus === 'invalidated')
      markGateStageGreen({
        databasePath: f.databasePath,
        runId: run.runId,
        stage: 'tsc',
        ownerIdentity: f.ownerIdentity,
        expectedFingerprint: claim.target.fingerprint,
      });
    if (blockedStatus !== 'active') {
      settleGateRun({
        databasePath: f.databasePath,
        runId: run.runId,
        status: blockedStatus === 'failed' ? 'failed' : 'green',
        requiredStages: ['tsc'],
        now: now + 1,
      });
    }
    const db = openGateResourcePool(f.databasePath);
    try {
      db.exec('BEGIN IMMEDIATE');
      if (blockedStatus === 'invalidated')
        db.prepare(`INSERT INTO gate_run_reuse_invalidations
        (run_id,fingerprint,terminal_at,pause_epoch,reconcile_from,invalidated_at,reason)
        VALUES (?,?,?,1,0,?,'post_pause')`).run(run.runId, claim.target.fingerprint, now + 1, now + 2);
      const insert = db.prepare(`INSERT INTO gate_runs
        (run_id,fingerprint,job_id,owner_pid,owner_started_at,state,terminal_status,created_at,heartbeat_at,terminal_at)
        VALUES (?,?,'noise',1,'private-fixture','terminal','failed',?,?,?)`);
      for (let i = 0; i < 205; i++)
        insert.run(`noise-${i}`, `unrelated-${i}`, now + 10 + i, now + 10 + i, now + 10 + i);
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    assert.equal(
      listGateRuns(f.databasePath).some((item) => item.runId === run.runId),
      false,
    );
    assert.throws(() => createGateContinuityClaim(args), /current exact inputs/);
    assert.throws(() => validateGateContinuityClaim({ ...args, claimHash: claim.claimHash }), /current exact inputs/);
    assert.equal(deriveGateRoute({ ...args, continuityClaimId: claim.claimHash }).route, 'full');
  });
}

test('producer establishes the live integration cut; later main advances do not thaw a claim', (t) => {
  const f = fixture(t);
  const baseSha = f.advance();
  const remote = path.join(f.root, '.git', 'canonical.git');
  f.git('init', '--bare', '-q', remote);
  f.git('remote', 'set-url', 'origin', remote);
  f.git('push', '-q', 'origin', 'main:main');
  const args = f.args(baseSha);
  const claim = createGateContinuityClaim(args);
  writeGateContinuityClaim(f.databasePath, claim);
  f.git('checkout', '-qb', 'upstream', 'main');
  f.write('packages/shared/upstream.ts', 'export const changed = true;\n');
  f.commit('related main advance');
  f.git('push', '-q', 'origin', 'upstream:main');
  f.git('update-ref', 'refs/remotes/origin/main', baseSha);
  f.git('checkout', '-q', 'candidate');
  assert.equal(f.git('rev-parse', 'main'), baseSha);
  assert.equal(f.git('rev-parse', 'origin/main'), baseSha);
  assert.throws(() => createGateContinuityClaim(args), /canonical integration cut/);
  assert.equal(deriveGateRoute({ ...args, continuityClaimId: claim.claimHash }).route, 'targeted');
  assert.deepEqual(claim.integration, {
    remote: 'origin',
    ref: 'refs/heads/main',
    urlDigest: gateFingerprintFromComponents({ originUrl: remote }),
    sha: baseSha,
  });
  renameSync(remote, `${remote}-offline`);
  assert.equal(deriveGateRoute({ ...args, continuityClaimId: claim.claimHash }).route, 'targeted');
  assert.throws(() => createGateContinuityClaim(args));
  f.git('remote', 'set-url', 'origin', path.join(f.root, 'unavailable.git'));
  assert.throws(() => createGateContinuityClaim(args));
  assert.equal(deriveGateRoute({ ...args, continuityClaimId: claim.claimHash }).route, 'full');
});

test('public help discloses source-only C2 consumption', () => {
  const result = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /source checkout only/i);
  assert.match(result.stdout, /public.*cannot consume/i);
});
