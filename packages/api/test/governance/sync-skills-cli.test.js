import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * F239 Phase A — `sync-skills.sh` default project-level + `--user` opt-in
 *
 * ADR-025 第 3 条：用户级目录不默认承载官方 skills；`pnpm sync:skills --user` opt-in。
 *
 * Verification strategy:
 * - Override $HOME to an empty tmp dir per test (no pre-existing symlinks
 *   that could short-circuit sync_link's "already correct → skip" branch).
 * - Run sync-skills.sh in --dry-run mode (no side effects on real ~).
 * - Default mode: dry-run stdout must NOT contain any "would create
 *   ${tmpHome}/.{provider}/skills/..." line — the HOME loop is gated off.
 * - --user mode: dry-run stdout must contain "would create" lines for
 *   all 4 providers (claude/codex/gemini/kimi) under ${tmpHome}.
 */

const PROJECT_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SCRIPT = join(PROJECT_ROOT, 'scripts', 'sync-skills.sh');
const PROVIDERS = ['.claude', '.codex', '.gemini', '.kimi'];

function runScript(args, tmpHome) {
  return spawnSync('bash', [SCRIPT, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, HOME: tmpHome, NO_COLOR: '1' },
    // 4 providers × N worktrees × ~46 skills produces thousands of sync_link calls;
    // each readlink/stat round-trip is small but adds up. Allow up to 120s in CI.
    timeout: 120_000,
    // dry-run output for all worktrees × 4 providers easily exceeds the default
    // 1 MiB buffer (~1.2 MiB observed locally with 43 worktrees); use 50 MiB.
    maxBuffer: 50 * 1024 * 1024,
  });
}

describe('sync-skills.sh --user opt-in (F239 Phase A, ADR-025)', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'f239-sync-skills-test-'));
  });

  afterEach(() => {
    if (tmpHome) {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  describe('default mode (no --user)', () => {
    it('runs successfully in dry-run mode', () => {
      const r = runScript(['--dry-run'], tmpHome);
      assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
    });

    it('does not target HOME-level skill paths for any provider', () => {
      const r = runScript(['--dry-run'], tmpHome);
      assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
      for (const provider of PROVIDERS) {
        const homePath = `${tmpHome}/${provider}/skills`;
        assert.ok(
          !r.stdout.includes(homePath),
          `default mode must NOT target HOME path ${homePath}; ` +
            `found in dry-run output (excerpt: ${r.stdout.slice(0, 800)})`,
        );
      }
    });

    it('prints awareness hint mentioning --user opt-in path', () => {
      const r = runScript(['--dry-run'], tmpHome);
      assert.ok(
        /--user/i.test(r.stdout),
        `default mode should mention --user opt-in for HOME-level mount; output: ${r.stdout.slice(0, 800)}`,
      );
    });
  });

  describe('--user mode (opt-in HOME-level mount)', () => {
    it('runs successfully in dry-run mode', () => {
      const r = runScript(['--user', '--dry-run'], tmpHome);
      assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
    });

    it('targets HOME-level skill paths for all 4 providers', () => {
      const r = runScript(['--user', '--dry-run'], tmpHome);
      assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
      for (const provider of PROVIDERS) {
        const homePath = `${tmpHome}/${provider}/skills`;
        assert.ok(
          r.stdout.includes(homePath),
          `--user mode must target HOME path ${homePath}; ` +
            `not found in dry-run output (excerpt: ${r.stdout.slice(0, 800)})`,
        );
      }
    });

    it('accepts --dry-run --user flag order swap', () => {
      const r = runScript(['--dry-run', '--user'], tmpHome);
      assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
      for (const provider of PROVIDERS) {
        const homePath = `${tmpHome}/${provider}/skills`;
        assert.ok(r.stdout.includes(homePath), `flag order --dry-run --user must still target HOME path ${homePath}`);
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
