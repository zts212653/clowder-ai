/**
 * Test 1: checkSharedStatePreflight() integration tests
 *
 * Uses a real temp git repo with controlled state to test all branches.
 * No mocking needed — tests against actual git behavior.
 *
 * Covers:
 * A: upstream exists, has unpushed shared-state → { ok: false, unpushedFiles }
 * B: no upstream, no origin/<branch>, merge-base fallback → detected
 * C: uncommitted shared-state → { ok: false, uncommittedFiles }
 * D: all clean → { ok: true }
 * E: git not available → { ok: true } (fail-open)
 * F: non-shared-state files ignored
 * G: no upstream + no origin + no merge-base → { ok: true } (fail-open)
 * H: non-main branch, unpushed → { ok: true } (skip unpushed, enforced at merge-gate)
 * I: non-main branch, uncommitted → { ok: false } (uncommitted still detected)
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let checkSharedStatePreflight;

/** Create a temp git repo, optionally with a bare remote for push/fetch. */
function createTempRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), `ss-test-${name}-`));
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "test"', { cwd: dir, stdio: 'ignore' });
  // Initial commit so HEAD exists
  writeFileSync(join(dir, 'README.md'), '# test');
  execSync('git add README.md && git commit -m "init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

/** Create a bare remote and link to it from the repo. */
function addBareRemote(repoDir) {
  const bare = mkdtempSync(join(tmpdir(), 'ss-test-bare-'));
  execSync('git init --bare -b main', { cwd: bare, stdio: 'ignore' });
  execSync(`git remote add origin ${bare}`, { cwd: repoDir, stdio: 'ignore' });
  execSync('git push -u origin main', { cwd: repoDir, stdio: 'ignore' });
  return bare;
}

const tempDirs = [];

describe('checkSharedStatePreflight (integration)', () => {
  before(async () => {
    const mod = await import('../dist/config/shared-state-preflight.js');
    checkSharedStatePreflight = mod.checkSharedStatePreflight;
  });

  after(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it('detects unpushed shared-state files via upstream', () => {
    const repo = createTempRepo('unpushed');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    // Commit BACKLOG.md but don't push
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs/ROADMAP.md'), '# Backlog');
    execSync('git add docs/ROADMAP.md && git commit -m "add backlog"', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.equal(result.ok, false, 'should detect unpushed shared-state');
    assert.deepEqual(result.unpushedFiles, ['docs/ROADMAP.md']);
    assert.equal(result.uncommittedFiles, undefined);
  });

  it('detects uncommitted shared-state files (staged but not committed)', () => {
    const repo = createTempRepo('uncommitted');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    // Stage cat-template.json but don't commit — git diff --cached catches this
    writeFileSync(join(repo, 'cat-template.json'), '{}');
    execSync('git add cat-template.json', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.equal(result.ok, false, 'should detect staged shared-state');
    assert.deepEqual(result.uncommittedFiles, ['cat-template.json']);
    assert.equal(result.unpushedFiles, undefined);
  });

  it('detects staged shared-state files as uncommitted', () => {
    const repo = createTempRepo('staged');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    // Stage BACKLOG.md but don't commit
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs/ROADMAP.md'), '# Backlog');
    execSync('git add docs/ROADMAP.md', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.equal(result.ok, false, 'should detect staged shared-state');
    assert.ok(result.uncommittedFiles?.includes('docs/ROADMAP.md'));
  });

  it('detects both unpushed and uncommitted simultaneously', () => {
    const repo = createTempRepo('both');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    // Commit BACKLOG.md but don't push
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs/ROADMAP.md'), '# Backlog');
    execSync('git add docs/ROADMAP.md && git commit -m "add backlog"', { cwd: repo, stdio: 'ignore' });

    // Also have staged (uncommitted) cat-template.json
    writeFileSync(join(repo, 'cat-template.json'), '{}');
    execSync('git add cat-template.json', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.equal(result.ok, false);
    assert.deepEqual(result.unpushedFiles, ['docs/ROADMAP.md']);
    assert.deepEqual(result.uncommittedFiles, ['cat-template.json']);
  });

  it('returns ok:true when everything is clean', () => {
    const repo = createTempRepo('clean');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    // All pushed, nothing dirty
    const result = checkSharedStatePreflight(repo);
    assert.deepEqual(result, { ok: true });
  });

  it('ignores non-shared-state files in unpushed diff', () => {
    const repo = createTempRepo('nonshared');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    // Commit a non-shared file but don't push
    writeFileSync(join(repo, 'src-index.ts'), 'console.log("hi")');
    execSync('git add src-index.ts && git commit -m "add src"', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.deepEqual(result, { ok: true }, 'should ignore non-shared-state files');
  });

  it('returns ok:true when git is not available (non-git directory)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-test-nogit-'));
    tempDirs.push(dir);

    const result = checkSharedStatePreflight(dir);
    assert.deepEqual(result, { ok: true }, 'should fail-open when git is unavailable');
  });

  it('skips unpushed check on non-main branches (worktree / feature branch)', () => {
    const repo = createTempRepo('feature-skip');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    // Create a feature branch with committed shared-state — unpushed should be skipped
    execSync('git checkout -b feat/test-branch', { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'cat-template.json'), '{}');
    execSync('git add cat-template.json && git commit -m "add config"', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.deepEqual(result, { ok: true }, 'feature branch should skip unpushed check');
  });

  it('still detects uncommitted shared-state on non-main branches', () => {
    const repo = createTempRepo('feature-uncommitted');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    // Create a feature branch with staged (uncommitted) shared-state — should warn
    execSync('git checkout -b feat/dirty-worktree', { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'cat-config.json'), '{}');
    execSync('git add cat-config.json', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.equal(result.ok, false, 'uncommitted shared-state on feature branch should still be detected');
    assert.deepEqual(result.uncommittedFiles, ['cat-config.json']);
    assert.equal(result.unpushedFiles, undefined, 'unpushed should not be checked on feature branch');
  });

  it('skips unpushed check on brand-new branches without remote', () => {
    const repo = createTempRepo('brand-new-skip');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    execSync('git checkout -b feat/brand-new', { cwd: repo, stdio: 'ignore' });
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs/ROADMAP.md'), '# New');
    execSync('git add docs/ROADMAP.md && git commit -m "add backlog on new branch"', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.deepEqual(result, { ok: true }, 'brand-new feature branch should skip unpushed check');
  });

  it('returns ok:true when local is only behind upstream (no local unpushed commits)', () => {
    // Codex cloud review P1: git diff --name-only upstream..HEAD is a tree diff,
    // so when local is behind upstream it falsely reports upstream-only files.
    // Fix: check rev-list ahead count first; if ahead=0, skip diff.
    const repo = createTempRepo('behind-only');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    // Simulate another clone pushing a shared-state file
    const cloneA = mkdtempSync(join(tmpdir(), 'ss-test-cloneA-'));
    tempDirs.push(cloneA);
    execSync(`git clone ${bare} .`, { cwd: cloneA, stdio: 'ignore' });
    execSync('git config user.email "a@test.com"', { cwd: cloneA, stdio: 'ignore' });
    execSync('git config user.name "A"', { cwd: cloneA, stdio: 'ignore' });
    mkdirSync(join(cloneA, 'docs'), { recursive: true });
    writeFileSync(join(cloneA, 'docs/ROADMAP.md'), '# Backlog from A');
    execSync('git add docs/ROADMAP.md && git commit -m "A adds backlog" && git push', { cwd: cloneA, stdio: 'ignore' });

    // Original repo fetches but doesn't merge — HEAD is behind upstream
    execSync('git fetch origin', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.deepEqual(result, { ok: true }, 'behind-only should NOT report unpushed files');
  });

  it('ignores upstream-only shared-state drift when branch is both ahead and behind', () => {
    const repo = createTempRepo('diverged');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    // Remote adds shared-state drift after local clone point.
    const cloneA = mkdtempSync(join(tmpdir(), 'ss-test-diverged-remote-'));
    tempDirs.push(cloneA);
    execSync(`git clone ${bare} .`, { cwd: cloneA, stdio: 'ignore' });
    execSync('git config user.email "a@test.com"', { cwd: cloneA, stdio: 'ignore' });
    execSync('git config user.name "A"', { cwd: cloneA, stdio: 'ignore' });
    mkdirSync(join(cloneA, 'docs'), { recursive: true });
    writeFileSync(join(cloneA, 'docs/ROADMAP.md'), '# remote shared-state drift');
    execSync('git add docs/ROADMAP.md && git commit -m "remote backlog drift" && git push', {
      cwd: cloneA,
      stdio: 'ignore',
    });

    // Local repo makes an unrelated commit and fetches remote, producing ahead+behind.
    writeFileSync(join(repo, 'notes.txt'), 'local only');
    execSync('git add notes.txt && git commit -m "local unrelated change"', { cwd: repo, stdio: 'ignore' });
    execSync('git fetch origin', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.deepEqual(result, { ok: true }, 'diverged branch should ignore shared-state files changed only on upstream');
  });

  it('returns ok:true when no upstream + no origin/<branch> + no merge-base (fail-open)', () => {
    // Create a completely isolated repo with no remote at all
    const repo = createTempRepo('isolated');
    tempDirs.push(repo);

    // Stay on main — no remote means fail-open for the unpushed check
    writeFileSync(join(repo, 'cat-template.json'), '{}');
    execSync('git add cat-template.json && git commit -m "add config"', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    // Fail-open: no remote to compare against
    assert.deepEqual(result, { ok: true }, 'should fail-open when no remote available');
  });
});
