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
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let checkSharedStatePreflight;

function createTempRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), `ss-test-${name}-`));
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "test"', { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), '# test');
  execSync('git add README.md && git commit -m "init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

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

    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs/BACKLOG.md'), '# Backlog');
    execSync('git add docs/BACKLOG.md && git commit -m "add backlog"', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.equal(result.ok, false, 'should detect unpushed shared-state');
    assert.deepEqual(result.unpushedFiles, ['docs/BACKLOG.md']);
    assert.equal(result.uncommittedFiles, undefined);
  });

  it('detects uncommitted shared-state files (staged but not committed)', () => {
    const repo = createTempRepo('uncommitted');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    writeFileSync(join(repo, 'cat-config.json'), '{}');
    execSync('git add cat-config.json', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.equal(result.ok, false, 'should detect staged shared-state');
    assert.deepEqual(result.uncommittedFiles, ['cat-config.json']);
    assert.equal(result.unpushedFiles, undefined);
  });

  it('detects staged shared-state files as uncommitted', () => {
    const repo = createTempRepo('staged');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs/BACKLOG.md'), '# Backlog');
    execSync('git add docs/BACKLOG.md', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.equal(result.ok, false, 'should detect staged shared-state');
    assert.ok(result.uncommittedFiles?.includes('docs/BACKLOG.md'));
  });

  it('detects both unpushed and uncommitted simultaneously', () => {
    const repo = createTempRepo('both');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs/BACKLOG.md'), '# Backlog');
    execSync('git add docs/BACKLOG.md && git commit -m "add backlog"', { cwd: repo, stdio: 'ignore' });

    writeFileSync(join(repo, 'cat-config.json'), '{}');
    execSync('git add cat-config.json', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.equal(result.ok, false);
    assert.deepEqual(result.unpushedFiles, ['docs/BACKLOG.md']);
    assert.deepEqual(result.uncommittedFiles, ['cat-config.json']);
  });

  it('returns ok:true when everything is clean', () => {
    const repo = createTempRepo('clean');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    const result = checkSharedStatePreflight(repo);
    assert.deepEqual(result, { ok: true });
  });

  it('ignores non-shared-state files in unpushed diff', () => {
    const repo = createTempRepo('nonshared');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

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

  it('falls back to origin/<branch> when no upstream tracking (new branch)', () => {
    const repo = createTempRepo('noupstream');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    execSync('git checkout -b feat/test-branch', { cwd: repo, stdio: 'ignore' });
    execSync('git push -u origin feat/test-branch', { cwd: repo, stdio: 'ignore' });
    execSync('git branch --unset-upstream', { cwd: repo, stdio: 'ignore' });

    writeFileSync(join(repo, 'cat-config.json'), '{}');
    execSync('git add cat-config.json && git commit -m "add config"', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.equal(result.ok, false);
    assert.deepEqual(result.unpushedFiles, ['cat-config.json']);
  });

  it('falls back to merge-base when origin/<branch> does not exist (brand new branch)', () => {
    const repo = createTempRepo('mergebase');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    execSync('git checkout -b feat/brand-new', { cwd: repo, stdio: 'ignore' });

    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs/BACKLOG.md'), '# New');
    execSync('git add docs/BACKLOG.md && git commit -m "add backlog on new branch"', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.equal(result.ok, false, 'should detect via merge-base fallback');
    assert.deepEqual(result.unpushedFiles, ['docs/BACKLOG.md']);
  });

  it('returns ok:true when local is only behind upstream (no local unpushed commits)', () => {
    const repo = createTempRepo('behind-only');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    const cloneA = mkdtempSync(join(tmpdir(), 'ss-test-cloneA-'));
    tempDirs.push(cloneA);
    execSync(`git clone ${bare} .`, { cwd: cloneA, stdio: 'ignore' });
    execSync('git config user.email "a@test.com"', { cwd: cloneA, stdio: 'ignore' });
    execSync('git config user.name "A"', { cwd: cloneA, stdio: 'ignore' });
    mkdirSync(join(cloneA, 'docs'), { recursive: true });
    writeFileSync(join(cloneA, 'docs/BACKLOG.md'), '# Backlog from A');
    execSync('git add docs/BACKLOG.md && git commit -m "A adds backlog" && git push', { cwd: cloneA, stdio: 'ignore' });

    execSync('git fetch origin', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.deepEqual(result, { ok: true }, 'behind-only should NOT report unpushed files');
  });

  it('returns ok:true when no upstream + no origin/<branch> + no merge-base (fail-open)', () => {
    const repo = createTempRepo('isolated');
    tempDirs.push(repo);

    execSync('git checkout -b feat/orphan', { cwd: repo, stdio: 'ignore' });

    writeFileSync(join(repo, 'cat-config.json'), '{}');
    execSync('git add cat-config.json && git commit -m "add config"', { cwd: repo, stdio: 'ignore' });

    const result = checkSharedStatePreflight(repo);
    assert.deepEqual(result, { ok: true }, 'should fail-open when no merge-base available');
  });
});
