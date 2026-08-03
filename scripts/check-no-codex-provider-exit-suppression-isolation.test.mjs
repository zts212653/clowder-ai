#!/usr/bin/env node
/**
 * F212 Phase H post-close hotfix — canary isolation contract + git-grep flag
 * pairing invariants (Sol coordination 2026-07-10 + Sol R2 2026-07-13 split).
 *
 * The isolation guarantee is that test canaries live in `os.tmpdir()` fixtures
 * and never touch the real worktree's providers directory. Sibling files:
 *   • check-no-provider-canary-residue.test.mjs — Ver B independent guard tests
 *   • -structural.test.mjs                       — anti-regression gates
 *                                                  against the removed shared-
 *                                                  directory helper
 *
 * Split from a 439-line parent per Sol R2 P1-2 (AGENTS.md 350-line hard cap).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  boundedSpawn,
  createProvidersWatcher,
  makeIsolatedFixture,
  REAL_REPO_ROOT,
  runGuard,
} from './check-no-codex-provider-exit-suppression/test-scaffold.mjs';

const PROVIDERS_DIR = 'packages/api/src/domains/cats/services/agents/providers';

describe('check-no-codex-provider-exit-suppression: canary isolation contract', () => {
  it('structural invariant: fixture repoRoot is inside os.tmpdir()', () => {
    const fx = makeIsolatedFixture();
    try {
      const realTmp = resolve(tmpdir());
      const realFixture = resolve(fx.repoRoot);
      assert.ok(
        realFixture.startsWith(`${realTmp}/`) || realFixture.startsWith(`${realTmp}\\`),
        `fixture repoRoot MUST be inside os.tmpdir() — got ${realFixture}, tmpdir=${realTmp}`,
      );
      assert.ok(
        existsSync(join(fx.repoRoot, PROVIDERS_DIR)),
        `fixture must have minimal providers/ tree at ${PROVIDERS_DIR}`,
      );
    } finally {
      fx.cleanup();
    }
  });

  it('Sol contract #1: ignored historical copy does NOT trigger the guard', () => {
    const fx = makeIsolatedFixture();
    try {
      writeFileSync(join(fx.repoRoot, '.gitignore'), '.review-worktrees/\n.cat-cafe/\n');
      const reviewSandbox = join(fx.repoRoot, '.review-worktrees/pr-2529-review', PROVIDERS_DIR);
      mkdirSync(reviewSandbox, { recursive: true });
      writeFileSync(
        join(reviewSandbox, 'CodexAgentService.ts'),
        'let sawSubstantiveOutput = false;\n' +
          'function hasNonSuppressibleCodexExitOneDiagnostics() { return false; }\n' +
          '// "suppressing as Codex 0.98+ quirk"\n',
      );
      const { exitCode, stdout } = runGuard({ repoRoot: fx.repoRoot });
      assert.equal(
        exitCode,
        0,
        `guard must ignore .gitignore'd historical copy — got exit ${exitCode}, stdout=${stdout.slice(0, 300)}`,
      );
    } finally {
      fx.cleanup();
    }
  });

  it('Sol contract #2: non-ignored untracked provider canary MUST trigger the guard', () => {
    const fx = makeIsolatedFixture();
    try {
      writeFileSync(
        join(fx.repoRoot, PROVIDERS_DIR, 'canary-live.ts'),
        'let sawSubstantiveOutput = true;\nvoid sawSubstantiveOutput;\n',
      );
      const { exitCode, stderr } = runGuard({ repoRoot: fx.repoRoot });
      assert.equal(exitCode, 1, 'untracked provider canary must be caught by --untracked');
      assert.ok(
        stderr.includes('sawSubstantiveOutput'),
        `stderr must name the forbidden token; got: ${stderr.slice(0, 300)}`,
      );
      assert.ok(stderr.includes('canary-live.ts'), `stderr must show the offending path; got: ${stderr.slice(0, 300)}`);
    } finally {
      fx.cleanup();
    }
  });

  it('Sol contract #3: fixture with only .gitignore-covered historical text is clean', () => {
    const fx = makeIsolatedFixture();
    try {
      writeFileSync(join(fx.repoRoot, '.gitignore'), '.cat-cafe/\n');
      const exportsDir = join(fx.repoRoot, '.cat-cafe/thread-exports/repo');
      mkdirSync(exportsDir, { recursive: true });
      writeFileSync(
        join(exportsDir, 'thread-fixture.md'),
        '# Historical A2A\n\n' +
          '`sawSubstantiveOutput` used to gate here.\n' +
          '`hasNonSuppressibleCodexExitOneDiagnostics()` helper existed.\n' +
          'Log message: `suppressing as Codex 0.98+ quirk`.\n',
      );
      const { exitCode } = runGuard({ repoRoot: fx.repoRoot });
      assert.equal(exitCode, 0, 'ignored thread-exports text must not trip the guard');
    } finally {
      fx.cleanup();
    }
  });

  it('Sol contract #4 (stricter, actually concurrent): two overlapping guard child processes — stderr/hit paths only contain own canary', async () => {
    // Sol R3 P2 correction: async spawn now goes through boundedSpawn which
    // adds timeout, error handler, and kill fallback so a hung child cannot
    // hang the entire `pnpm check` run.
    const fxA = makeIsolatedFixture();
    const fxB = makeIsolatedFixture();
    try {
      writeFileSync(
        join(fxA.repoRoot, PROVIDERS_DIR, 'canary-fixture-A.ts'),
        'let sawSubstantiveOutput = true;\nvoid sawSubstantiveOutput;\n',
      );
      writeFileSync(
        join(fxB.repoRoot, PROVIDERS_DIR, 'canary-fixture-B.ts'),
        'function hasNonSuppressibleCodexExitOneDiagnostics() { return false; }\n',
      );
      const guardScript = join(REAL_REPO_ROOT, 'scripts', 'check-no-codex-provider-exit-suppression.mjs');
      const [runA, runB] = await Promise.all([
        boundedSpawn({
          script: guardScript,
          args: ['--repo-root', fxA.repoRoot],
          cwd: fxA.repoRoot,
          timeoutMs: 30_000,
        }),
        boundedSpawn({
          script: guardScript,
          args: ['--repo-root', fxB.repoRoot],
          cwd: fxB.repoRoot,
          timeoutMs: 30_000,
        }),
      ]);
      assert.equal(runA.timedOut, false, 'fixture A child must not time out');
      assert.equal(runB.timedOut, false, 'fixture B child must not time out');
      assert.equal(runA.error, null, `fixture A child spawn error: ${runA.error}`);
      assert.equal(runB.error, null, `fixture B child spawn error: ${runB.error}`);
      assert.equal(runA.exitCode, 1, 'fixture A guard must catch its own canary');
      assert.equal(runB.exitCode, 1, 'fixture B guard must catch its own canary');
      assert.ok(runA.stderr.includes('canary-fixture-A.ts'), 'A stderr must name A canary');
      assert.ok(
        !runA.stderr.includes('canary-fixture-B.ts'),
        `A stderr MUST NOT contain B canary — cross-pollution! got: ${runA.stderr.slice(0, 400)}`,
      );
      assert.ok(runB.stderr.includes('canary-fixture-B.ts'), 'B stderr must name B canary');
      assert.ok(
        !runB.stderr.includes('canary-fixture-A.ts'),
        `B stderr MUST NOT contain A canary — cross-pollution! got: ${runB.stderr.slice(0, 400)}`,
      );
    } finally {
      fxA.cleanup();
      fxB.cleanup();
    }
  });

  it('structural invariant #6: runtime watcher observes NO /canary/i in real providers/ during the literal+AST suites (supplementary — deterministic gate lives in -structural.test.mjs)', async () => {
    // Sol R2 P1-1 NODE_TEST_CONTEXT strip is preserved: the child otherwise
    // silently skips all files as recursive test-runner invocation.
    //
    // Sol R4 P1 correction: the watcher is a PROBABILISTIC observer. A 5ms
    // polling loop reliably catches writes that persist >>5ms (Sol's own probe:
    // 10/10 on 50ms holds), but cannot prove absence of sub-millisecond
    // write+unlink races (Sol's probe: 2/40 on immediate write+unlink). The
    // DETERMINISTIC guard against real-tree writes lives in
    // `-structural.test.mjs` (Sol R4 P1 deterministic gate #A/#B — no
    // REAL_REPO_ROOT reference + no empty runGuard() call). This test is a
    // supplementary telemetry probe against the long-lived transient failure
    // mode (write → run guard → finally unlink), backed by the positive
    // control test below that proves the observer is actually alive.
    const literalTest = join(REAL_REPO_ROOT, 'scripts', 'check-no-codex-provider-exit-suppression-literal.test.mjs');
    const astTest = join(REAL_REPO_ROOT, 'scripts', 'check-no-codex-provider-exit-suppression-ast.test.mjs');
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const seen = new Set();
    const providersDir = join(REAL_REPO_ROOT, PROVIDERS_DIR);
    const watcher = createProvidersWatcher(providersDir, seen, 5);
    let result;
    try {
      result = await boundedSpawn({
        script: '--test',
        args: [literalTest, astTest],
        cwd: REAL_REPO_ROOT,
        env: childEnv,
        timeoutMs: 120_000,
      });
    } finally {
      clearInterval(watcher);
    }
    assert.equal(result.timedOut, false, 'literal+ast child must not time out');
    assert.equal(result.error, null, `literal+ast child spawn error: ${result.error}`);
    assert.equal(
      result.exitCode,
      0,
      `literal + ast suite must pass in child process; got status ${result.exitCode}, stderr=${result.stderr?.slice(0, 400)}`,
    );
    const testsMatch = result.stdout.match(/tests\s+(\d+)/);
    const passMatch = result.stdout.match(/pass\s+(\d+)/);
    const failMatch = result.stdout.match(/fail\s+(\d+)/);
    assert.ok(testsMatch, `child stdout must report a "tests N" line; got: ${result.stdout.slice(0, 500)}`);
    const testCount = Number(testsMatch[1]);
    const passCount = passMatch ? Number(passMatch[1]) : 0;
    const failCount = failMatch ? Number(failMatch[1]) : 0;
    assert.ok(
      testCount >= 20,
      `child suite ran too few tests (probable NODE_TEST_CONTEXT recursion skip) — got ${testCount}, expected >=20`,
    );
    assert.equal(failCount, 0, `child suite must have zero failures — got ${failCount}`);
    assert.equal(passCount, testCount, `all child tests must pass — got pass=${passCount}, tests=${testCount}`);
    // Sol R3 P1 assertion, now scoped by Sol R4 P1 tradeoff: watcher must see
    // zero transient basename appearances during the suite lifetime. Positive
    // control below proves the observer is alive; deterministic gate in
    // -structural.test.mjs proves sub-millisecond writes cannot happen because
    // the migrated suites don't reference REAL_REPO_ROOT at all.
    assert.deepEqual(
      [...seen],
      [],
      `runtime watcher observed transient /canary/i basename(s) in real providers/ during the child lifetime: ${[...seen].join(', ')}`,
    );
  });

  it('Sol R4 P1 positive control: watcher observes a seeded transient canary in an injectable providers/ dir', async () => {
    // Sol R4 P1: without a positive control the watcher assertion in #6 is
    // trivially satisfied by a dead observer (setInterval callback never fires,
    // walkBasenames always returns []). This test proves the observer is alive
    // by injecting a canary into an isolated fixture, holding it long enough
    // for the 5ms polling interval to definitely sample, then removing it —
    // and asserting the watcher captured the transient existence.
    const fx = makeIsolatedFixture();
    try {
      const dir = join(fx.repoRoot, PROVIDERS_DIR);
      const seen = new Set();
      const watcher = createProvidersWatcher(dir, seen, 5);
      try {
        const canaryPath = join(dir, 'Codex-canary-positive-control.ts');
        writeFileSync(canaryPath, '// R4 positive control seed\n');
        // >>5ms so at least one polling interval samples the seeded canary.
        // Use several intervals to make the test robust to scheduler jitter.
        await new Promise((r) => setTimeout(r, 80));
        unlinkSync(canaryPath);
      } finally {
        clearInterval(watcher);
      }
      assert.ok(
        seen.has('Codex-canary-positive-control.ts'),
        'watcher observer is dead — 80ms held transient canary was NOT observed. Fix the observer before trusting structural #6.',
      );
    } finally {
      fx.cleanup();
    }
  });
});

describe('check-no-codex-provider-exit-suppression: git-grep flag pairing invariants', () => {
  it('literal-guard scan is fail-CLOSED when repoRoot is not a git repo', () => {
    const nonGitRoot = join(tmpdir(), `no-git-${Date.now()}-${Math.floor(process.uptime() * 1e6)}`);
    mkdirSync(nonGitRoot, { recursive: true });
    mkdirSync(join(nonGitRoot, PROVIDERS_DIR), { recursive: true });
    try {
      const { exitCode, stderr } = runGuard({ repoRoot: nonGitRoot });
      assert.notEqual(exitCode, 0, 'non-git-repo must not pass silently');
      assert.ok(
        /git|repo|not a git/i.test(stderr),
        `stderr must mention git-repo failure; got: ${stderr.slice(0, 300)}`,
      );
    } finally {
      rmSync(nonGitRoot, { recursive: true, force: true });
    }
  });

  it('Cloud R2 + R3 P2: untracked generated-cache dirs at ANY DEPTH (.cache/, .turbo/, build/) do NOT false-red the guard', () => {
    // Cloud codex R2 P2 (2026-07-13): `--exclude-standard` only honours
    // `.gitignore` / `.git/info/exclude` / core.excludesFile. Generated caches
    // that a developer or CI has UNTRACKED but not gitignored (root
    // `.gitignore` in this repo lists `.next/` / `node_modules/` / `dist/` but
    // NOT `.cache/` / `.turbo/` / `build/`) would otherwise be swept by
    // `--untracked` and false-red the guard.
    //
    // Cloud codex R3 P2 (2026-07-13): pathspec `glob` wildcards do NOT match
    // `/`, so `build/**` only excludes root `build/`; nested paths like
    // `packages/api/build/leak.ts` or `packages/web/.turbo/leak.ts` still leak.
    // Fix: use `**/PATH/**` any-depth pattern. This test parameterises across
    // BOTH root-level AND nested-under-packages/ paths to lock the fix in.
    const seedPaths = [
      '.cache/root-leak.ts',
      '.turbo/root-leak.ts',
      'build/root-leak.ts',
      'packages/api/.cache/nested-leak.ts',
      'packages/api/.turbo/nested-leak.ts',
      'packages/api/build/nested-leak.ts',
      'packages/web/.cache/deep-leak.ts',
      'packages/web/.turbo/deep-leak.ts',
      'packages/web/build/deep-leak.ts',
    ];
    for (const rel of seedPaths) {
      const fx = makeIsolatedFixture();
      try {
        const full = join(fx.repoRoot, rel);
        mkdirSync(join(full, '..'), { recursive: true });
        // Seed a forbidden token as untracked in the cache dir. If any of the
        // pathspec excludes drops or reverts to a non-any-depth form, this
        // fires with a violation naming the token.
        writeFileSync(
          full,
          '// Cloud R2 + R3 P2 regression seed: untracked cache at this depth must not false-red guard\n' +
            'let sawSubstantiveOutput = true;\nvoid sawSubstantiveOutput;\n',
        );
        const { exitCode, stderr } = runGuard({ repoRoot: fx.repoRoot });
        assert.equal(
          exitCode,
          0,
          `guard must ignore untracked forbidden token at ${rel} (generated-cache dir, any depth); got exit ${exitCode}, stderr=${stderr?.slice(0, 300)}`,
        );
      } finally {
        fx.cleanup();
      }
    }
  });
});
