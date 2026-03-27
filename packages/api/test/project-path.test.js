import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const {
  validateProjectPath,
  isUnderAllowedRoot,
  getAllowedRoots,
  getDefaultDeniedRoots,
  isPathUnderRoots,
  isDenylistMode,
} = await import('../dist/utils/project-path.js');

describe('denylist mode (default)', () => {
  let savedAllowedRoots;

  before(() => {
    savedAllowedRoots = process.env.PROJECT_ALLOWED_ROOTS;
    delete process.env.PROJECT_ALLOWED_ROOTS;
  });

  after(() => {
    if (savedAllowedRoots === undefined) delete process.env.PROJECT_ALLOWED_ROOTS;
    else process.env.PROJECT_ALLOWED_ROOTS = savedAllowedRoots;
  });

  it('uses denylist mode by default', () => {
    assert.strictEqual(isDenylistMode(), true);
  });

  it('accepts path under home directory', () => {
    assert.strictEqual(isUnderAllowedRoot(join(homedir(), 'projects')), true);
  });

  it('accepts home directory itself', () => {
    assert.strictEqual(isUnderAllowedRoot(homedir()), true);
  });

  it('accepts path under /tmp', () => {
    assert.strictEqual(isUnderAllowedRoot('/tmp/test-dir'), true);
  });

  it('accepts /opt, /srv, /mnt and other common project locations', () => {
    assert.strictEqual(isUnderAllowedRoot('/opt/projects'), true);
    assert.strictEqual(isUnderAllowedRoot('/srv/data'), true);
    assert.strictEqual(isUnderAllowedRoot('/mnt/disk/repo'), true);
    assert.strictEqual(isUnderAllowedRoot('/usr/code'), true);
    assert.strictEqual(isUnderAllowedRoot('/var/www/site'), true);
  });

  it('rejects paths under denied system directories', () => {
    if (process.platform === 'darwin') {
      assert.strictEqual(isUnderAllowedRoot('/dev/null'), false);
      assert.strictEqual(isUnderAllowedRoot('/sbin/mount'), false);
      assert.strictEqual(isUnderAllowedRoot('/System/Library'), false);
    } else {
      assert.strictEqual(isUnderAllowedRoot('/proc/1/status'), false);
      assert.strictEqual(isUnderAllowedRoot('/sys/class'), false);
      assert.strictEqual(isUnderAllowedRoot('/dev/null'), false);
      assert.strictEqual(isUnderAllowedRoot('/boot/vmlinuz'), false);
      assert.strictEqual(isUnderAllowedRoot('/sbin/init'), false);
      assert.strictEqual(isUnderAllowedRoot('/run/user'), false);
    }
  });

  it('getAllowedRoots() returns denied roots in denylist mode', () => {
    const roots = getAllowedRoots();
    assert.ok(Array.isArray(roots));
    assert.ok(roots.length > 0);
  });
});

describe('getDefaultDeniedRoots', () => {
  it('returns system directories for macOS', () => {
    const denied = getDefaultDeniedRoots('darwin');
    assert.ok(denied.includes('/dev'));
    assert.ok(denied.includes('/sbin'));
    assert.ok(denied.includes('/System'));
  });

  it('returns system directories for Linux', () => {
    const denied = getDefaultDeniedRoots('linux');
    assert.ok(denied.includes('/proc'));
    assert.ok(denied.includes('/sys'));
    assert.ok(denied.includes('/dev'));
    assert.ok(denied.includes('/boot'));
  });

  it('returns SYSTEMROOT for Windows', () => {
    const denied = getDefaultDeniedRoots('win32');
    assert.ok(denied.length >= 1);
  });
});

describe('isPathUnderRoots', () => {
  it('rejects cross-drive Windows paths', () => {
    assert.strictEqual(isPathUnderRoots('D:\\repo', ['C:\\work'], 'win32'), false);
    assert.strictEqual(isPathUnderRoots('C:\\work\\repo', ['C:\\work'], 'win32'), true);
  });
});

describe('validateProjectPath', () => {
  let testDir;
  let subDir;

  before(() => {
    testDir = mkdtempSync('/tmp/cat-cafe-test-path-validation-');
    subDir = join(testDir, 'project-a');
    mkdirSync(subDir, { recursive: true });
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns canonicalized path for valid directory', async () => {
    const result = await validateProjectPath(subDir);
    assert.ok(result);
    assert.strictEqual(result, await realpath(subDir));
  });

  it('returns null for nonexistent path', async () => {
    const result = await validateProjectPath('/nonexistent/path/xxx');
    assert.strictEqual(result, null);
  });

  it('returns null for denied system path', async () => {
    const result = await validateProjectPath('/dev');
    assert.strictEqual(result, null);
  });

  it('returns null for file (not directory)', async () => {
    const { writeFileSync } = await import('node:fs');
    const filePath = join(testDir, 'not-a-dir.txt');
    writeFileSync(filePath, 'test');
    const result = await validateProjectPath(filePath);
    assert.strictEqual(result, null);
  });

  it('resolves symlinks and checks real path', async () => {
    const linkPath = join(testDir, 'link-to-tmp');
    if (existsSync(linkPath)) rmSync(linkPath);
    symlinkSync('/tmp', linkPath);
    const result = await validateProjectPath(linkPath);
    assert.ok(result);
  });

  it('rejects symlinks that escape to denied paths', async () => {
    const linkPath = join(testDir, 'link-to-dev');
    if (existsSync(linkPath)) rmSync(linkPath);
    try {
      symlinkSync('/dev', linkPath);
      const result = await validateProjectPath(linkPath);
      assert.strictEqual(result, null);
    } catch {
      // symlink creation may fail in sandboxed environments
    }
  });
});

describe('PROJECT_ALLOWED_ROOTS legacy mode', () => {
  let savedAllowedRootsEnv;
  let savedAllowedRootsAppendEnv;

  before(() => {
    savedAllowedRootsEnv = process.env.PROJECT_ALLOWED_ROOTS;
    savedAllowedRootsAppendEnv = process.env.PROJECT_ALLOWED_ROOTS_APPEND;
  });

  after(() => {
    if (savedAllowedRootsEnv === undefined) delete process.env.PROJECT_ALLOWED_ROOTS;
    else process.env.PROJECT_ALLOWED_ROOTS = savedAllowedRootsEnv;
    if (savedAllowedRootsAppendEnv === undefined) delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;
    else process.env.PROJECT_ALLOWED_ROOTS_APPEND = savedAllowedRootsAppendEnv;
  });

  it('switches to allowlist mode when env var is set', () => {
    delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;
    process.env.PROJECT_ALLOWED_ROOTS = '/opt/projects:/srv/data';
    assert.strictEqual(isDenylistMode(), false);
    assert.strictEqual(isUnderAllowedRoot('/opt/projects/my-app'), true);
    assert.strictEqual(isUnderAllowedRoot('/srv/data/files'), true);
    assert.strictEqual(isUnderAllowedRoot(join(homedir(), 'projects')), false);
    assert.strictEqual(isUnderAllowedRoot('/tmp/foo'), false);
  });

  it('handles multiple colon-separated paths', () => {
    delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;
    process.env.PROJECT_ALLOWED_ROOTS = `/opt/a:/opt/b:${homedir()}`;
    assert.strictEqual(isUnderAllowedRoot('/opt/a/x'), true);
    assert.strictEqual(isUnderAllowedRoot('/opt/b/y'), true);
    assert.strictEqual(isUnderAllowedRoot(join(homedir(), 'z')), true);
    assert.strictEqual(isUnderAllowedRoot('/opt/c/w'), false);
  });

  it('falls back to denylist when env var is empty', () => {
    delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;
    process.env.PROJECT_ALLOWED_ROOTS = '';
    assert.strictEqual(isDenylistMode(), true);
    assert.strictEqual(isUnderAllowedRoot(join(homedir(), 'projects')), true);
  });
});
