import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * F239 Phase A — `sync-skills.sh` default project-level + `--user` opt-in
 *
 * ADR-025 第 3 条：用户级目录不默认承载官方 skills；`pnpm sync:skills --user` opt-in。
 *
 * Verification strategy:
 * - Override $HOME to an empty tmp dir (no pre-existing symlinks
 *   that could short-circuit sync_link's "already correct → skip" branch).
 * - Run sync-skills.sh in --dry-run mode (no side effects on real ~).
 * - A test-local git wrapper intercepts `git worktree list` to report only
 *   the main repo worktree, avoiding the 65-worktree scan that took 30s+/run
 *   (砚砚 FYI 2026-06-22: 228s total, gate SIGTERM). The production script
 *   contains no test-specific code. Tests only verify HOME-level behavior
 *   (Part 2), not worktree iteration — Part 1 coverage is via static analysis.
 * - Default mode: dry-run stdout must NOT contain any HOME-level skill paths.
 * - --user mode: dry-run stdout must contain HOME paths for all 4 providers.
 */

const PROJECT_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SCRIPT = join(PROJECT_ROOT, 'scripts', 'sync-skills.sh');
const PROVIDERS = ['.claude', '.codex', '.gemini', '.kimi'];

// Resolve the real git binary path — the test git wrapper delegates
// non-worktree-list commands to the real binary via this absolute path.
const REAL_GIT = spawnSync('which', ['git'], { encoding: 'utf-8' }).stdout.trim();

function runScript(args, tmpHome, gitWrapperDir) {
  return spawnSync('bash', [SCRIPT, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: tmpHome,
      NO_COLOR: '1',
      // Prepend test git wrapper dir so `git worktree list` returns only the
      // main repo worktree. This avoids the 65-worktree scan (30s+/run) while
      // keeping the production script free of test-specific env vars (P1 fix
      // per 砚砚 review of PR #2513). All other git subcommands (rev-parse,
      // -C, etc.) pass through to the real binary.
      PATH: `${gitWrapperDir}:${process.env.PATH}`,
      _SYNC_SKILLS_TEST_REPO: PROJECT_ROOT,
    },
    timeout: 30_000, // 1 worktree ≈ 1-2s; 30s is generous
    maxBuffer: 10 * 1024 * 1024,
  });
}

describe('sync-skills.sh --user opt-in (F239 Phase A, ADR-025)', () => {
  let tmpHome;
  let gitWrapperDir;
  /** @type {ReturnType<typeof runScript>} */ let defaultResult;
  /** @type {ReturnType<typeof runScript>} */ let userResult;
  /** @type {ReturnType<typeof runScript>} */ let userSwapResult;

  before(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'f239-sync-skills-test-'));

    // Git wrapper: intercepts `git worktree list` to report only the main repo,
    // avoiding the 65-worktree scan (30s+/run). All other git subcommands pass
    // through to the real binary unchanged. This keeps the production script
    // free of test-specific env vars — the cap lives entirely in the test
    // harness (P1 fix per 砚砚 review of PR #2513).
    //
    // The script's per-worktree logic (classify_provider_dir, parent-escape
    // guard, main-sync skip, stale-entry skip) still runs for the main
    // worktree; multi-worktree interaction testing is out of scope for this
    // suite which focuses on HOME-level (Part 2) behavior.
    gitWrapperDir = join(tmpHome, 'bin');
    mkdirSync(gitWrapperDir);
    writeFileSync(
      join(gitWrapperDir, 'git'),
      [
        '#!/bin/bash',
        '# F239 test wrapper: report only main repo worktree to skip 65-wt scan',
        'if [[ "$1" == "worktree" && "$2" == "list" ]]; then',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: bash variable, not JS template
        '  printf "worktree %s\\n\\n" "${_SYNC_SKILLS_TEST_REPO}"',
        '  exit 0',
        'fi',
        `exec "${REAL_GIT}" "$@"`,
      ].join('\n'),
      { mode: 0o755 },
    );

    // Run each unique invocation once; individual tests assert against cached results.
    // 3 runs × ~1-2s (1 worktree via wrapper) instead of 6 runs × 30s+.
    defaultResult = runScript(['--dry-run'], tmpHome, gitWrapperDir);
    userResult = runScript(['--user', '--dry-run'], tmpHome, gitWrapperDir);
    userSwapResult = runScript(['--dry-run', '--user'], tmpHome, gitWrapperDir);
  });

  after(() => {
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('default mode (no --user)', () => {
    it('runs successfully in dry-run mode', () => {
      assert.equal(defaultResult.status, 0, `script failed: stderr=${defaultResult.stderr}`);
    });

    it('does not target HOME-level skill paths for any provider', () => {
      assert.equal(defaultResult.status, 0, `script failed: stderr=${defaultResult.stderr}`);
      for (const provider of PROVIDERS) {
        const homePath = `${tmpHome}/${provider}/skills`;
        assert.ok(
          !defaultResult.stdout.includes(homePath),
          `default mode must NOT target HOME path ${homePath}; ` +
            `found in dry-run output (excerpt: ${defaultResult.stdout.slice(0, 800)})`,
        );
      }
    });

    it('prints awareness hint mentioning --user opt-in path', () => {
      assert.ok(
        /--user/i.test(defaultResult.stdout),
        `default mode should mention --user opt-in for HOME-level mount; output: ${defaultResult.stdout.slice(0, 800)}`,
      );
    });
  });

  describe('--user mode (opt-in HOME-level mount)', () => {
    it('runs successfully in dry-run mode', () => {
      assert.equal(userResult.status, 0, `script failed: stderr=${userResult.stderr}`);
    });

    it('targets HOME-level skill paths for all 4 providers', () => {
      assert.equal(userResult.status, 0, `script failed: stderr=${userResult.stderr}`);
      for (const provider of PROVIDERS) {
        const homePath = `${tmpHome}/${provider}/skills`;
        assert.ok(
          userResult.stdout.includes(homePath),
          `--user mode must target HOME path ${homePath}; ` +
            `not found in dry-run output (excerpt: ${userResult.stdout.slice(0, 800)})`,
        );
      }
    });

    it('accepts --dry-run --user flag order swap', () => {
      assert.equal(userSwapResult.status, 0, `script failed: stderr=${userSwapResult.stderr}`);
      for (const provider of PROVIDERS) {
        const homePath = `${tmpHome}/${provider}/skills`;
        assert.ok(
          userSwapResult.stdout.includes(homePath),
          `flag order --dry-run --user must still target HOME path ${homePath}`,
        );
      }
    });
  });

  /**
   * AC-A1 (per spec): "项目级 .{claude,codex,gemini,kimi}/skills/ 正常更新".
   *
   * Static analysis verifies the Part 1 worktree loop iterates over all 4
   * providers. This guards against regressing back to the historical 1-provider
   * behavior (only `.claude/skills`) which left codex/gemini/kimi project-level
   * mounts missing (138 missing per `check-skills-mount.sh` baseline, found by
   * 砚砚 review of fcc849d03).
   *
   * Runtime check (dry-run token absence) would be flaky because already-correct
   * symlinks short-circuit silently. Static analysis is stable across repeated
   * runs and works under any worktree fs state.
   */
  describe('project-level coverage (F239 AC-A1)', () => {
    it('does not pipe git worktree list into early-exit consumers under pipefail', async () => {
      const content = await readFile(SCRIPT, 'utf-8');
      assert.doesNotMatch(
        content,
        /git\s+worktree\s+list[^\n|]*\|\s*(head|grep)\b/,
        'sync-skills.sh must not pipe git worktree list into head/grep under `set -o pipefail`; CI can surface SIGPIPE as exit 141',
      );
    });

    it('Part 1 worktree loop iterates over all 4 providers', async () => {
      const content = await readFile(SCRIPT, 'utf-8');
      // Extract Part 1 block between section delimiters.
      const part1Match = content.match(/# ─── Part 1[\s\S]*?# ─── Part 2/);
      assert.ok(
        part1Match,
        'sync-skills.sh must keep "Part 1" / "Part 2" section delimiters so this guard can locate the worktree loop',
      );
      const part1 = part1Match[0];

      // Must contain a `for provider in <names>` loop body that names all 4 providers.
      const forLoopMatch = part1.match(/for\s+provider\s+in\s+([a-z][a-z\s]*?)\s*;\s*do/);
      assert.ok(forLoopMatch, 'Part 1 must contain `for provider in <providers>; do` loop (AC-A1: 项目级 4 providers)');
      const providers = forLoopMatch[1].trim().split(/\s+/);
      for (const p of ['claude', 'codex', 'gemini', 'kimi']) {
        assert.ok(
          providers.includes(p),
          `for-provider loop must include "${p}" (found: ${providers.join(',')}) — AC-A1 项目级 4 providers`,
        );
      }

      // The loop body must use ${provider} expansion to construct provider paths
      // (otherwise the for-loop is decorative and only one provider gets synced).
      assert.ok(
        part1.includes('${provider}'),
        'Part 1 for-loop body must use ${provider} expansion to construct provider paths',
      );
    });

    it('CONTRIBUTING.md documents 4-provider project-level mount', async () => {
      const contribPath = join(PROJECT_ROOT, 'CONTRIBUTING.md');
      const content = await readFile(contribPath, 'utf-8');
      // Doc must reference all 4 providers when describing project-level mount.
      // Guards against doc/impl drift (砚砚 finding root cause).
      for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
        assert.ok(
          content.includes(provider),
          `CONTRIBUTING.md must mention ${provider} in project-level mount section`,
        );
      }
    });
  });
});
