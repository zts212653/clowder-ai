/**
 * Shared test scaffold for the split guard tests (Sol R8 P1-B + post-close
 * hotfix 2026-07-13 canary isolation).
 *
 * Contains:
 *   • `REAL_REPO_ROOT` — the actual worktree root the tests are running in.
 *   • `runGuard(options)` — spawnSync the main orchestrator script; accepts
 *     an optional `repoRoot` to redirect the scan (Sol contract: injectable
 *     repoRoot, no shared production writes).
 *   • `makeIsolatedFixture()` — mkdtempSync + git init + minimal providers/
 *     tree. Sol contract: fixture repoRoot lives inside `os.tmpdir()` so a
 *     hard-kill between write and cleanup pollutes only OS temp space (which
 *     the OS reclaims), never a git worktree or the shared providers/ dir.
 *   • The legacy `withCanary(sharedPath, ...)` helper is REMOVED (not
 *     deprecated). Any test that needs a canary MUST use `makeIsolatedFixture`
 *     and write inside `fx.repoRoot`; the sync `finally` cleanup on a shared
 *     production path cannot survive process-level signal interruption.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REAL_REPO_ROOT = join(__dirname, '..', '..');
/** @deprecated legacy alias — new tests use REAL_REPO_ROOT. */
export const REPO_ROOT = REAL_REPO_ROOT;
const GUARD_SCRIPT = join(REAL_REPO_ROOT, 'scripts', 'check-no-codex-provider-exit-suppression.mjs');
const PROVIDERS_DIR = 'packages/api/src/domains/cats/services/agents/providers';

/**
 * Run the guard against a repo tree. Sol R5 P1 fail-CLOSED contract:
 * `repoRoot` MUST be a non-empty string. The previous `?? REAL_REPO_ROOT`
 * fallback was a real-tree escape hatch that let `runGuard()`, `runGuard({})`
 * or `runGuard({ repoRoot: undefined })` silently target the shared production
 * providers directory. The fallback is removed here so any caller who omits
 * repoRoot (or passes null / undefined / empty string) throws immediately —
 * failing loud instead of leaking a real-tree write. This is the real safety
 * edge; the -structural gate on the `REAL_REPO_ROOT` token is now a
 * convention guard against reintroducing the fallback shape at source level.
 */
export function runGuard(options) {
  if (options == null || typeof options !== 'object') {
    throw new TypeError(
      'runGuard requires an { repoRoot } options object. The shared-tree fallback was removed to prevent Bug 2 regressions. Use makeIsolatedFixture() to obtain a fixture repoRoot in os.tmpdir().',
    );
  }
  const { repoRoot } = options;
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError(
      `runGuard { repoRoot } must be a non-empty string. Got ${repoRoot === undefined ? 'undefined' : JSON.stringify(repoRoot)}. Use makeIsolatedFixture() to obtain a valid fixture root.`,
    );
  }
  const result = spawnSync('node', [GUARD_SCRIPT, '--repo-root', repoRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Build a disposable git repository inside `os.tmpdir()` containing the
 * minimal Codex-provider tree. Returns `{ repoRoot, cleanup }` — callers
 * MUST invoke `cleanup()` (best-effort; if a hard signal skips it, OS temp
 * reclamation still bounds the pollution domain).
 *
 * Contract (Sol final ACK 2026-07-13):
 *   • repoRoot is inside `os.tmpdir()` (never in any git worktree)
 *   • `git init` is run so `git grep` can operate
 *   • The minimal `packages/api/src/domains/cats/services/agents/providers/`
 *     directory exists (checks for target discovery satisfaction)
 *   • Nothing is added to git index by default — tests explicitly stage what
 *     they want, and the canary case validates `--untracked` behaviour by
 *     leaving canary files unstaged.
 */
export function makeIsolatedFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'f212-guard-fx-'));
  mkdirSync(join(repoRoot, PROVIDERS_DIR), { recursive: true });
  try {
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    execFileSync('git', ['config', 'user.email', 'f212-hotfix@test.local'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'F212 Hotfix Test'], { cwd: repoRoot });
    // Create a placeholder Codex file so the AST target-discovery gate passes
    // when the test does not exercise a discovery-failure path. Tests that
    // want to exercise missing-target explicitly can overwrite the fixture.
    writeFileSync(join(repoRoot, PROVIDERS_DIR, 'CodexAgentService.ts'), 'export function noop() { return 1; }\n');
  } catch (err) {
    rmSync(repoRoot, { recursive: true, force: true });
    throw err;
  }
  return {
    repoRoot,
    cleanup: () => {
      try {
        rmSync(repoRoot, { recursive: true, force: true });
      } catch {
        // Best-effort — OS temp reclamation is the safety net.
      }
    },
  };
}

// NOTE: `withCanary()` was removed (Cloud codex R1 P1 2026-07-13). It wrote
// to the caller's path, which callers always resolved to the shared production
// providers directory. When the sync `finally` cleanup was skipped by
// SIGKILL/SIGINT/OOM the file leaked. All tests were migrated to
// `makeIsolatedFixture()` + `writeFileSync(fx.repoRoot, ...)` — nothing should
// ever write to the real worktree's providers/ during the test suite again.
// The helper is intentionally NOT re-exported: any future caller must go
// through the isolated-fixture path structurally.

/**
 * Recursively list all basenames under `dir` in one snapshot. Used by the
 * runtime watcher and its positive control (Sol R4 P1).
 */
export function walkBasenames(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(entry.name);
    }
  }
  return out;
}

/**
 * Poll `dir` recursively at `intervalMs` and record any file whose basename
 * matches `/canary/i` into `seen`. Sol R4 P1: this is a probabilistic
 * observer, useful for catching writes that persist longer than one polling
 * interval; it CANNOT prove absence of sub-`intervalMs` transient writes. The
 * source-level structural gate in `-structural.test.mjs` is the deterministic
 * gate; this watcher is a supplementary telemetry probe.
 */
export function createProvidersWatcher(dir, seen, intervalMs) {
  return setInterval(() => {
    if (!existsSync(dir)) return;
    for (const base of walkBasenames(dir)) {
      if (/canary/i.test(base)) seen.add(base);
    }
  }, intervalMs);
}

/**
 * Sol R3 P2 correction: every async child must have timeout + error + cleanup.
 * Wraps `spawn` and resolves with `{ exitCode, stdout, stderr, timedOut, error }`.
 * On timeout the child receives SIGKILL and the promise resolves — never
 * rejects — so the caller can assert on `timedOut === false` and get a clear
 * failure instead of hanging `pnpm check` indefinitely.
 */
export function boundedSpawn({ script, args, cwd, env, timeoutMs = 30_000 }) {
  return new Promise((resolvePromise) => {
    const stderrChunks = [];
    const stdoutChunks = [];
    let timedOut = false;
    const child = spawn('node', [script, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    if (child.stdout) child.stdout.on('data', (d) => stdoutChunks.push(d.toString('utf8')));
    if (child.stderr) child.stderr.on('data', (d) => stderrChunks.push(d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: -1,
        error: err.message,
        timedOut,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code,
        error: null,
        timedOut,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
      });
    });
  });
}
