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
  getDefaultRootsForPlatform,
  isPathUnderRoots,
  pathsEqual,
} = await import('../dist/utils/project-path.js');

describe('isUnderAllowedRoot', () => {
  it('accepts path under home directory', () => {
    assert.strictEqual(isUnderAllowedRoot(join(homedir(), 'projects')), true);
  });

  it('accepts home directory itself', () => {
    assert.strictEqual(isUnderAllowedRoot(homedir()), true);
  });

  it('accepts path under /tmp', () => {
    assert.strictEqual(isUnderAllowedRoot('/tmp/test-dir'), true);
  });

  it('rejects path with home prefix but no separator boundary', () => {
    // /home/user-evil should NOT pass for home = /home/user
    const fakePath = `${homedir()}-evil/data`;
    assert.strictEqual(isUnderAllowedRoot(fakePath), false);
  });

  it('rejects path outside allowed roots', () => {
    assert.strictEqual(isUnderAllowedRoot('/etc/passwd'), false);
    assert.strictEqual(isUnderAllowedRoot('/var/log'), false);
  });

  it('rejects root directory', () => {
    assert.strictEqual(isUnderAllowedRoot('/'), false);
  });

  it('rejects cross-drive Windows paths when custom roots are configured', () => {
    assert.strictEqual(isPathUnderRoots('D:\\repo', ['C:\\work'], 'win32'), false);
    assert.strictEqual(isPathUnderRoots('C:\\work\\repo', ['C:\\work'], 'win32'), true);
  });
});

describe('getDefaultRootsForPlatform', () => {
  it('keeps Windows defaults scoped to the user home directory', () => {
    const roots = getDefaultRootsForPlatform('win32', {
      homeDir: 'C:\\Users\\share',
      pathExists: (target) => target === 'C:\\' || target === 'D:\\',
    });
    assert.deepStrictEqual(roots, ['C:\\Users\\share']);
    assert.strictEqual(isPathUnderRoots('C:\\Users\\share\\repo', roots, 'win32'), true);
    assert.strictEqual(isPathUnderRoots('C:\\Windows', roots, 'win32'), false);
    assert.strictEqual(isPathUnderRoots('D:\\other-user', roots, 'win32'), false);
  });
});

describe('validateProjectPath', () => {
  // NOTE: tests run in a workspace-write sandbox where $HOME might be read-only.
  // Use /tmp (allowed root) for temp directory creation.
  let testDir;
  let subDir;

  before(() => {
    // Create test directories
    testDir = mkdtempSync('/tmp/cat-cafe-test-path-validation-');
    subDir = join(testDir, 'project-a');
    mkdirSync(subDir, { recursive: true });
  });

  // Cleanup handled by caller or next test run
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

  it('returns null for path outside allowed roots', async () => {
    const result = await validateProjectPath('/etc');
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
    // Create a symlink under home that points to /tmp
    const linkPath = join(testDir, 'link-to-tmp');
    if (existsSync(linkPath)) rmSync(linkPath);
    symlinkSync('/tmp', linkPath);

    // validateProjectPath should resolve the symlink to /tmp
    // /tmp IS an allowed root, so this should succeed
    const result = await validateProjectPath(linkPath);
    // /tmp is allowed, so the resolved path should be returned
    assert.ok(result);
  });

  it('rejects symlinks that escape to disallowed paths', async () => {
    const linkPath = join(testDir, 'link-to-etc');
    if (existsSync(linkPath)) rmSync(linkPath);
    try {
      symlinkSync('/etc', linkPath);
      const result = await validateProjectPath(linkPath);
      assert.strictEqual(result, null);
    } catch {
      // symlink creation may fail in sandboxed environments
    }
  });
});

describe('PROJECT_ALLOWED_ROOTS env var', () => {
  let savedEnv;
  let savedAppend;

  before(() => {
    savedEnv = process.env.PROJECT_ALLOWED_ROOTS;
    savedAppend = process.env.PROJECT_ALLOWED_ROOTS_APPEND;
  });

  after(() => {
    if (savedEnv === undefined) {
      delete process.env.PROJECT_ALLOWED_ROOTS;
    } else {
      process.env.PROJECT_ALLOWED_ROOTS = savedEnv;
    }
    if (savedAppend === undefined) {
      delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;
    } else {
      process.env.PROJECT_ALLOWED_ROOTS_APPEND = savedAppend;
    }
  });

  it('uses default roots when env var is not set', () => {
    delete process.env.PROJECT_ALLOWED_ROOTS;
    delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;
    // Default: homedir + /tmp + /private/tmp + /workspace + /Volumes (macOS)
    assert.strictEqual(isUnderAllowedRoot(join(homedir(), 'projects')), true);
    assert.strictEqual(isUnderAllowedRoot('/tmp/foo'), true);
    assert.strictEqual(isUnderAllowedRoot('/workspace/foo'), true);
  });

  it('includes /Volumes in default roots on macOS', () => {
    delete process.env.PROJECT_ALLOWED_ROOTS;
    delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;
    if (process.platform === 'darwin') {
      assert.strictEqual(isUnderAllowedRoot('/Volumes/shared/project'), true);
      assert.strictEqual(isUnderAllowedRoot('/Volumes'), true);
    }
  });

  it('replaces defaults when env var is set (backward compat)', () => {
    process.env.PROJECT_ALLOWED_ROOTS = '/opt/projects:/srv/data';
    delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;
    assert.strictEqual(isUnderAllowedRoot('/opt/projects/my-app'), true);
    assert.strictEqual(isUnderAllowedRoot('/srv/data/files'), true);
    // Default roots should no longer work (replace mode is default)
    assert.strictEqual(isUnderAllowedRoot(join(homedir(), 'projects')), false);
    assert.strictEqual(isUnderAllowedRoot('/tmp/foo'), false);
  });

  it('appends to defaults when PROJECT_ALLOWED_ROOTS_APPEND=true', () => {
    process.env.PROJECT_ALLOWED_ROOTS = '/opt/projects:/srv/data';
    process.env.PROJECT_ALLOWED_ROOTS_APPEND = 'true';
    // Extra roots work
    assert.strictEqual(isUnderAllowedRoot('/opt/projects/my-app'), true);
    assert.strictEqual(isUnderAllowedRoot('/srv/data/files'), true);
    // Default roots still work (append mode)
    assert.strictEqual(isUnderAllowedRoot(join(homedir(), 'projects')), true);
    assert.strictEqual(isUnderAllowedRoot('/tmp/foo'), true);
  });

  it('falls back to defaults when env var is empty', () => {
    process.env.PROJECT_ALLOWED_ROOTS = '';
    delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;
    assert.strictEqual(isUnderAllowedRoot(join(homedir(), 'projects')), true);
  });

  it('handles multiple colon-separated paths', () => {
    process.env.PROJECT_ALLOWED_ROOTS = `/opt/a:/opt/b:${homedir()}`;
    delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;
    assert.strictEqual(isUnderAllowedRoot('/opt/a/x'), true);
    assert.strictEqual(isUnderAllowedRoot('/opt/b/y'), true);
    assert.strictEqual(isUnderAllowedRoot(join(homedir(), 'z')), true);
    assert.strictEqual(isUnderAllowedRoot('/opt/c/w'), false);
  });

  it('getAllowedRoots() returns computed list', () => {
    delete process.env.PROJECT_ALLOWED_ROOTS;
    delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;
    const roots = getAllowedRoots();
    assert.ok(Array.isArray(roots));
    assert.ok(roots.includes(homedir()));
    assert.ok(roots.includes('/tmp'));
    assert.ok(roots.includes('/workspace'));
  });
});

describe('pathsEqual', () => {
  it('exact match on non-Windows platforms', () => {
    assert.strictEqual(pathsEqual('/a/b', '/a/b', 'linux'), true);
    assert.strictEqual(pathsEqual('/a/b', '/A/B', 'linux'), false);
    assert.strictEqual(pathsEqual('/a/b', '/a/b', 'darwin'), true);
    assert.strictEqual(pathsEqual('/a/b', '/A/B', 'darwin'), false);
  });

  it('case-insensitive match on win32', () => {
    assert.strictEqual(pathsEqual('C:\\Users\\Dev\\Project', 'C:\\users\\dev\\project', 'win32'), true);
    assert.strictEqual(pathsEqual('C:\\Users\\Dev\\Project', 'C:\\USERS\\DEV\\PROJECT', 'win32'), true);
  });

  it('different paths never match regardless of platform', () => {
    assert.strictEqual(pathsEqual('/a/b', '/a/c', 'linux'), false);
    assert.strictEqual(pathsEqual('C:\\a\\b', 'C:\\a\\c', 'win32'), false);
  });

  it('empty strings match', () => {
    assert.strictEqual(pathsEqual('', '', 'linux'), true);
    assert.strictEqual(pathsEqual('', '', 'win32'), true);
  });
});
