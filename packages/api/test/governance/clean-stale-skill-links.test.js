import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * F239 Phase B — `clean-stale-skill-links.sh`
 *
 * ADR-025 第 8 条："旧用户级 symlinks → 清理提示（不自动删除）".
 *
 * Verification strategy:
 * - Build tmp HOME with mixed entries under .{provider}/skills/:
 *   (a) stale: symlink → tmp cat-cafe-skills/ (target is "managed")
 *   (b) user-owned: symlink → /some/other/path (not managed)
 *   (c) non-symlink: real file/dir
 * - Run script in --dry-run (default) → no entries removed; output lists (a) only.
 * - Run script in --apply → only (a) removed; (b) and (c) untouched.
 * - --help prints usage.
 */

const PROJECT_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SCRIPT = join(PROJECT_ROOT, 'scripts', 'clean-stale-skill-links.sh');
const PROVIDERS = ['claude', 'codex', 'gemini', 'kimi'];

function runScript(args, env = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, ...env, NO_COLOR: '1' },
    timeout: 30_000,
  });
}

function setupFixture(tmpRoot) {
  // Tmp HOME-like layout: tmpRoot/.{provider}/skills/{stale,user-owned,real-file}
  const skillsSrc = join(tmpRoot, 'cat-cafe-skills-src');
  mkdirSync(skillsSrc, { recursive: true });
  // Create 2 fake skill source dirs that "managed" links can point to.
  mkdirSync(join(skillsSrc, 'fake-skill-a'), { recursive: true });
  mkdirSync(join(skillsSrc, 'fake-skill-b'), { recursive: true });

  // A non-managed external target (where user-owned link points)
  const externalTarget = join(tmpRoot, 'external-skills');
  mkdirSync(join(externalTarget, 'user-own-skill'), { recursive: true });

  for (const provider of PROVIDERS) {
    const dir = join(tmpRoot, `.${provider}`, 'skills');
    mkdirSync(dir, { recursive: true });
    // (a) stale managed link
    symlinkSync(join(skillsSrc, 'fake-skill-a'), join(dir, 'fake-skill-a'));
    symlinkSync(join(skillsSrc, 'fake-skill-b'), join(dir, 'fake-skill-b'));
    // (b) user-owned symlink to external path
    symlinkSync(join(externalTarget, 'user-own-skill'), join(dir, 'user-own-skill'));
    // (c) real file (not a symlink — user-created note/script)
    writeFileSync(join(dir, 'my-real-note.md'), 'user file\n');
  }

  return { skillsSrc, externalTarget };
}

function countSymlinks(dir) {
  if (!existsSync(dir)) return { stale: 0, userOwned: 0, realFile: 0 };
  const items = readdirSync(dir);
  let stale = 0;
  let userOwned = 0;
  let realFile = 0;
  for (const name of items) {
    const p = join(dir, name);
    const lst = lstatSync(p);
    if (!lst.isSymbolicLink()) {
      realFile += 1;
      continue;
    }
    const target = readlinkSync(p);
    if (target.includes('cat-cafe-skills-src')) stale += 1;
    else userOwned += 1;
  }
  return { stale, userOwned, realFile };
}

describe('clean-stale-skill-links.sh (F239 Phase B, ADR-025 第 8 条)', () => {
  let tmpRoot;
  let skillsSrc;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'f239b-test-'));
    ({ skillsSrc } = setupFixture(tmpRoot));
  });

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('--help', () => {
    it('prints usage and exits 0', () => {
      const r = runScript(['--help']);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /usage|Usage/i);
      assert.match(r.stdout, /--dry-run/);
      assert.match(r.stdout, /--apply/);
    });
  });

  describe('default --dry-run mode', () => {
    it('lists stale candidates but does NOT remove anything', () => {
      const r = runScript([], {
        HOME: tmpRoot,
        CLEAN_STALE_SKILLS_SRC: skillsSrc,
      });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      // Each provider had 2 stale links → 8 total stale candidates listed
      for (const provider of PROVIDERS) {
        const dir = join(tmpRoot, `.${provider}`, 'skills');
        const counts = countSymlinks(dir);
        // Nothing removed: stale preserved, user-owned preserved, real file preserved
        assert.equal(counts.stale, 2, `${dir}: stale should still be 2, got ${counts.stale}`);
        assert.equal(counts.userOwned, 1, `${dir}: user-owned should still be 1, got ${counts.userOwned}`);
        assert.equal(counts.realFile, 1, `${dir}: real file should still be 1, got ${counts.realFile}`);
      }
      // Output mentions candidates
      assert.match(r.stdout, /fake-skill-a/);
      assert.match(r.stdout, /fake-skill-b/);
      // Output mentions count summary
      assert.match(r.stdout, /\b8\b/);
    });

    it('exits 0 even if there are no stale links', () => {
      const emptyHome = mkdtempSync(join(tmpdir(), 'f239b-empty-'));
      try {
        const r = runScript([], { HOME: emptyHome, CLEAN_STALE_SKILLS_SRC: skillsSrc });
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      } finally {
        rmSync(emptyHome, { recursive: true, force: true });
      }
    });
  });

  describe('--apply mode', () => {
    it('removes ONLY managed stale links; preserves user-owned + real files', () => {
      const r = runScript(['--apply'], {
        HOME: tmpRoot,
        CLEAN_STALE_SKILLS_SRC: skillsSrc,
      });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      for (const provider of PROVIDERS) {
        const dir = join(tmpRoot, `.${provider}`, 'skills');
        const counts = countSymlinks(dir);
        assert.equal(counts.stale, 0, `${dir}: stale should be removed, found ${counts.stale}`);
        assert.equal(counts.userOwned, 1, `${dir}: user-owned must be preserved, found ${counts.userOwned}`);
        assert.equal(counts.realFile, 1, `${dir}: real file must be preserved, found ${counts.realFile}`);
      }
      // Output mentions removal count summary
      assert.match(r.stdout, /\b8\b/);
    });

    it('is a no-op on second invocation (idempotent)', () => {
      runScript(['--apply'], { HOME: tmpRoot, CLEAN_STALE_SKILLS_SRC: skillsSrc });
      const r = runScript(['--apply'], { HOME: tmpRoot, CLEAN_STALE_SKILLS_SRC: skillsSrc });
      assert.equal(r.status, 0, `second-run stderr: ${r.stderr}`);
      for (const provider of PROVIDERS) {
        const dir = join(tmpRoot, `.${provider}`, 'skills');
        const counts = countSymlinks(dir);
        assert.equal(counts.stale, 0);
        assert.equal(counts.userOwned, 1);
        assert.equal(counts.realFile, 1);
      }
    });

    it('rejects unknown flags with non-zero exit', () => {
      const r = runScript(['--bogus'], { HOME: tmpRoot, CLEAN_STALE_SKILLS_SRC: skillsSrc });
      assert.notEqual(r.status, 0, 'unknown flag must error');
    });
  });

  /**
   * 砚砚 P1 round 1 regression (PR #2328 review 4511203963):
   * Relative dangling user-owned symlink under set -e caused the scan to
   * abort mid-loop. Fix: avoid `cd ...` chain when resolving targets; use
   * string concat + canon_path graceful fallback. A dangling symlink must
   * be treated as preserved user-owned and the scan must continue.
   */
  describe('regression: relative dangling user-owned symlinks (砚砚 P1)', () => {
    it('does not abort scan when a dangling relative symlink is present', () => {
      // Add a dangling relative symlink to fixture
      const claudeDir = join(tmpRoot, '.claude', 'skills');
      symlinkSync('../../this-target-does-not-exist/x', join(claudeDir, 'dangling-user-link'));

      const r = runScript([], { HOME: tmpRoot, CLEAN_STALE_SKILLS_SRC: skillsSrc });
      assert.equal(r.status, 0, `dry-run must succeed even with dangling symlink: stderr=${r.stderr}`);
      // Scan must have run to completion — Candidates summary printed
      assert.match(r.stdout, /Candidates/, 'scan must reach Candidates summary (not abort mid-loop)');
      // Dangling user-owned link counted as preserved, not removed candidate
      assert.equal(lstatSync(join(claudeDir, 'dangling-user-link')).isSymbolicLink(), true);
      // The managed stale links should still be detected
      assert.match(r.stdout, /fake-skill-a/);
    });

    it('--apply mode also tolerates dangling symlinks and preserves them', () => {
      const claudeDir = join(tmpRoot, '.claude', 'skills');
      symlinkSync('../../this-target-does-not-exist/x', join(claudeDir, 'dangling-user-link'));

      const r = runScript(['--apply'], { HOME: tmpRoot, CLEAN_STALE_SKILLS_SRC: skillsSrc });
      assert.equal(r.status, 0, `--apply must succeed even with dangling symlink: stderr=${r.stderr}`);
      // Dangling user-owned link preserved
      assert.equal(
        lstatSync(join(claudeDir, 'dangling-user-link')).isSymbolicLink(),
        true,
        'dangling user-owned link must be preserved, not removed',
      );
      // Managed stale links should be removed
      const counts = countSymlinks(claudeDir);
      assert.equal(counts.stale, 0, 'managed stale removed');
    });
  });

  /**
   * Cloud P2 round 2 regression (PR #2328 thread PRRT_kwDORM_spM6KFSAt):
   * cleanup script must scan worktree-local source too. setup.sh hint can
   * report stale links targeting worktree-local cat-cafe-skills/ from a
   * linked worktree, but pre-fix cleanup only matched against main-repo
   * source → "found N, --apply removes 0" mismatch.
   */
  describe('regression: multi-source detection matches setup.sh (cloud P2 round 2)', () => {
    it('static analysis: script accepts a secondary worktree-local source', async () => {
      const content = await readFile(SCRIPT, 'utf-8');
      // Multi-source variables must exist
      assert.match(
        content,
        /SKILLS_SRC_EXTRA/,
        'cleanup script must track SKILLS_SRC_EXTRA candidate (worktree-local source)',
      );
      // Match logic must check the extra source when set
      assert.match(
        content,
        /SKILLS_SRC_EXTRA_REAL/,
        'cleanup script must canonicalize + match against SKILLS_SRC_EXTRA_REAL',
      );
    });
  });

  describe('package.json registration', () => {
    it('exposes `clean:stale-skill-links` script', async () => {
      const content = await readFile(join(PROJECT_ROOT, 'package.json'), 'utf-8');
      const pkg = JSON.parse(content);
      assert.ok(
        pkg.scripts && pkg.scripts['clean:stale-skill-links'],
        'package.json must register `clean:stale-skill-links` script',
      );
      assert.match(
        pkg.scripts['clean:stale-skill-links'],
        /clean-stale-skill-links\.sh/,
        'script must invoke scripts/clean-stale-skill-links.sh',
      );
    });
  });

  describe('setup.sh integration (AC-B5)', () => {
    it('setup.sh references stale skill links detection at end', async () => {
      const content = await readFile(join(PROJECT_ROOT, 'scripts', 'setup.sh'), 'utf-8');
      assert.ok(
        content.includes('clean-stale-skill-links') || content.includes('clean:stale-skill-links'),
        'setup.sh must reference clean-stale-skill-links (detection hint)',
      );
      assert.ok(
        !content.includes('pnpm clean:stale-skill-links --apply') &&
          !content.includes('bash scripts/clean-stale-skill-links.sh --apply'),
        'setup.sh must NOT auto-run --apply (ADR-025: 不自动删除)',
      );
    });

    // Cloud P2 round 2 regression (PR #2328 thread PRRT_kwDORM_spM6KFO_I):
    // setup.sh must detect main-repo source (via `git worktree list`) — legacy
    // HOME symlinks were created by sync-skills.sh using MAIN_REPO, so when
    // setup runs from a linked worktree, scanning only `pwd/cat-cafe-skills`
    // misses them and the hint is silent even though stale links exist.
    it('setup.sh detects main-repo source via git worktree list (not only pwd)', async () => {
      const content = await readFile(join(PROJECT_ROOT, 'scripts', 'setup.sh'), 'utf-8');
      // Must call `git worktree list` to discover MAIN_REPO
      assert.match(
        content,
        /git\s+worktree\s+list/,
        'setup.sh stale link detection must use `git worktree list` for MAIN_REPO discovery',
      );
      // Must define a main-source variable (e.g. SKILLS_SRC_MAIN) and match against it
      assert.match(
        content,
        /SKILLS_SRC_MAIN/,
        'setup.sh must track SKILLS_SRC_MAIN (main-repo source) as a candidate match',
      );
    });
  });
});
