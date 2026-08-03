import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('workspace-security', () => {
  let mod;
  let testRoot;

  beforeEach(async () => {
    mod = await import('../dist/domains/workspace/workspace-security.js');
    // Create a temp directory to simulate a workspace root
    testRoot = join(tmpdir(), `ws-test-${Date.now()}`);
    await mkdir(join(testRoot, 'src'), { recursive: true });
    await mkdir(join(testRoot, 'certs'), { recursive: true });
    await writeFile(join(testRoot, 'src', 'index.ts'), 'console.log("hi")');
    await writeFile(join(testRoot, '.env'), 'SECRET=123');
    await writeFile(join(testRoot, '.env.local'), 'SECRET=456');
    await writeFile(join(testRoot, 'certs', 'server.pem'), 'CERT');
  });

  // -- Traversal --

  it('resolves valid relative path within root', async () => {
    const result = await mod.resolveWorkspacePath(testRoot, 'src/index.ts');
    assert.ok(result.startsWith(testRoot));
    assert.ok(result.endsWith('src/index.ts'));
  });

  it('rejects ../ traversal', async () => {
    await assert.rejects(
      () => mod.resolveWorkspacePath(testRoot, '../etc/passwd'),
      (err) => err.code === 'TRAVERSAL',
    );
  });

  it('rejects absolute path outside root', async () => {
    await assert.rejects(
      () => mod.resolveWorkspacePath(testRoot, '/etc/passwd'),
      (err) => err.code === 'TRAVERSAL',
    );
  });

  it('rejects URL-encoded traversal', async () => {
    await assert.rejects(
      () => mod.resolveWorkspacePath(testRoot, '%2e%2e%2fetc/passwd'),
      (err) => err.code === 'TRAVERSAL',
    );
  });

  // -- Denylist --

  it('rejects .env file', async () => {
    await assert.rejects(
      () => mod.resolveWorkspacePath(testRoot, '.env'),
      (err) => err.code === 'DENIED',
    );
  });

  it('rejects .env.local file', async () => {
    await assert.rejects(
      () => mod.resolveWorkspacePath(testRoot, '.env.local'),
      (err) => err.code === 'DENIED',
    );
  });

  it('rejects .git directory access', async () => {
    await assert.rejects(
      () => mod.resolveWorkspacePath(testRoot, '.git/config'),
      (err) => err.code === 'DENIED',
    );
  });

  it('rejects *.pem files', async () => {
    await assert.rejects(
      () => mod.resolveWorkspacePath(testRoot, 'certs/server.pem'),
      (err) => err.code === 'DENIED',
    );
  });

  it('rejects secrets directory', async () => {
    await assert.rejects(
      () => mod.resolveWorkspacePath(testRoot, 'secrets/api-key.json'),
      (err) => err.code === 'DENIED',
    );
  });

  // -- Symlink escape --

  it('rejects symlink that escapes root', async () => {
    const linkPath = join(testRoot, 'src', 'escape-link');
    try {
      await symlink('/etc', linkPath);
      await assert.rejects(
        () => mod.resolveWorkspacePath(testRoot, 'src/escape-link'),
        (err) => err.code === 'TRAVERSAL',
      );
    } finally {
      await rm(linkPath, { force: true });
    }
  });

  // P1: directory symlink escape (intermediate symlink dir, not just final segment)
  it('rejects path traversing through a directory symlink that escapes root', async () => {
    const linkDir = join(testRoot, 'src', 'escape-dir');
    try {
      await symlink('/etc', linkDir);
      await assert.rejects(
        () => mod.resolveWorkspacePath(testRoot, 'src/escape-dir/passwd'),
        (err) => err.code === 'TRAVERSAL',
      );
    } finally {
      await rm(linkDir, { force: true });
    }
  });

  // -- isDenylisted (P2: search result filtering) --

  it('isDenylisted blocks .env files', () => {
    assert.ok(mod.isDenylisted('.env'));
    assert.ok(mod.isDenylisted('.env.local'));
    assert.ok(mod.isDenylisted('.env.production'));
  });

  it('isDenylisted blocks sensitive file patterns', () => {
    assert.ok(mod.isDenylisted('certs/server.pem'));
    assert.ok(mod.isDenylisted('keys/deploy.key'));
    assert.ok(mod.isDenylisted('id_rsa'));
    assert.ok(mod.isDenylisted('id_rsa.pub'));
  });

  it('isDenylisted blocks secrets directory', () => {
    assert.ok(mod.isDenylisted('secrets/api-key.json'));
    assert.ok(mod.isDenylisted('secrets/db-password.txt'));
  });

  it('isDenylisted blocks .git directory', () => {
    assert.ok(mod.isDenylisted('.git/config'));
    assert.ok(mod.isDenylisted('.git/HEAD'));
  });

  it('isDenylisted blocks normalized POSIX paths on every host platform', () => {
    assert.ok(mod.isDenylisted('secrets/nested/token.txt'));
    assert.ok(mod.isDenylisted('.git/hooks/pre-commit'));
  });

  it('isDenylisted allows safe paths', () => {
    assert.ok(!mod.isDenylisted('src/index.ts'));
    assert.ok(!mod.isDenylisted('packages/api/src/routes/workspace.ts'));
    assert.ok(!mod.isDenylisted('docs/README.md'));
  });

  // -- Worktree listing --

  it('listWorktrees falls back to a startup-style project root when cwd is not a git checkout', async () => {
    const publicRoot = join(tmpdir(), `public-export-${Date.now()}`);
    await mkdir(join(publicRoot, 'cat-cafe-skills'), { recursive: true });
    await writeFile(join(publicRoot, 'cat-cafe-skills', 'manifest.yaml'), 'skills: {}\n');

    try {
      const entries = await mod.listWorktrees(publicRoot);
      assert.deepEqual(entries, [
        {
          id: basename(publicRoot).replace(/[^a-zA-Z0-9_-]/g, '_'),
          root: publicRoot,
          branch: 'exported',
          head: 'nogit',
        },
      ]);
    } finally {
      await rm(publicRoot, { recursive: true, force: true });
    }
  });

  it('listWorktrees reads bare repositories instead of treating them as exported roots', async () => {
    const bareRoot = join(tmpdir(), `bare-worktree-list-${Date.now()}.git`);
    await execFileAsync('git', ['init', '--bare', bareRoot]);

    try {
      const entries = await mod.listWorktrees(bareRoot);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].branch, 'HEAD');
      assert.equal(entries[0].head, '');
      assert.notEqual(entries[0].branch, 'exported');
      assert.notEqual(entries[0].head, 'nogit');
    } finally {
      await rm(bareRoot, { recursive: true, force: true });
    }
  });

  it('listWorktrees recognizes localized git non-repository errors', async () => {
    const publicRoot = join(tmpdir(), `public-export-localized-${Date.now()}`);
    const binDir = join(tmpdir(), `fake-git-${Date.now()}`);
    const originalPath = process.env.PATH;
    await mkdir(join(publicRoot, 'cat-cafe-skills'), { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(join(publicRoot, 'cat-cafe-skills', 'manifest.yaml'), 'skills: {}\n');
    await writeFile(
      join(binDir, 'git'),
      '#!/bin/sh\nprintf "致命错误：不是 git 仓库（或者任何父目录）：.git\\n" >&2\nexit 128\n',
    );
    await chmod(join(binDir, 'git'), 0o755);
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;

    try {
      const entries = await mod.listWorktrees(publicRoot);
      assert.deepEqual(entries, [
        {
          id: basename(publicRoot).replace(/[^a-zA-Z0-9_-]/g, '_'),
          root: publicRoot,
          branch: 'exported',
          head: 'nogit',
        },
      ]);
    } finally {
      process.env.PATH = originalPath;
      await rm(publicRoot, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it('listWorktrees does not hide localized git failures inside a real checkout', async () => {
    const checkoutRoot = join(tmpdir(), `checkout-localized-${Date.now()}`);
    const binDir = join(tmpdir(), `fake-git-real-${Date.now()}`);
    const originalPath = process.env.PATH;
    await mkdir(join(checkoutRoot, '.git'), { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, 'git'),
      [
        '#!/bin/sh',
        'if [ "$1" = "rev-parse" ]; then',
        '  printf "true\\n"',
        '  exit 0',
        'fi',
        'printf "致命错误：.git 权限被拒绝\\n" >&2',
        'exit 128',
        '',
      ].join('\n'),
    );
    await chmod(join(binDir, 'git'), 0o755);
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;

    try {
      await assert.rejects(() => mod.listWorktrees(checkoutRoot), /权限被拒绝/);
    } finally {
      process.env.PATH = originalPath;
      await rm(checkoutRoot, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it('listWorktrees does not hide localized git failures inside a bare repository', async () => {
    const bareRoot = join(tmpdir(), `bare-localized-${Date.now()}.git`);
    const binDir = join(tmpdir(), `fake-git-bare-${Date.now()}`);
    const originalPath = process.env.PATH;
    await mkdir(join(bareRoot, 'objects'), { recursive: true });
    await mkdir(join(bareRoot, 'refs'), { recursive: true });
    await writeFile(join(bareRoot, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(bareRoot, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, 'git'),
      [
        '#!/bin/sh',
        'if [ "$1" = "rev-parse" ] && [ "$2" = "--is-inside-work-tree" ]; then',
        '  printf "false\\n"',
        '  exit 0',
        'fi',
        'if [ "$1" = "rev-parse" ] && [ "$2" = "--is-bare-repository" ]; then',
        '  printf "致命错误：bare config 权限被拒绝\\n" >&2',
        '  exit 128',
        'fi',
        'printf "unexpected git call\\n" >&2',
        'exit 128',
        '',
      ].join('\n'),
    );
    await chmod(join(binDir, 'git'), 0o755);
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;

    try {
      await assert.rejects(() => mod.listWorktrees(bareRoot), /权限被拒绝/);
    } finally {
      process.env.PATH = originalPath;
      await rm(bareRoot, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it('getWorktreeRoot can resolve registry aliases when cwd is not a git checkout', async () => {
    const publicRoot = join(tmpdir(), `public-registry-${Date.now()}`);
    await mkdir(join(publicRoot, 'cat-cafe-skills'), { recursive: true });
    await writeFile(join(publicRoot, 'cat-cafe-skills', 'manifest.yaml'), 'skills: {}\n');
    mod.registerWorktrees([{ id: 'registered-public-root', root: publicRoot, branch: 'test', head: 'abc123' }]);

    try {
      assert.equal(await mod.getWorktreeRoot('registered-public-root', publicRoot), publicRoot);
    } finally {
      await rm(publicRoot, { recursive: true, force: true });
    }
  });

  it('listWorktrees returns at least one entry', async () => {
    const entries = await mod.listWorktrees();
    assert.ok(entries.length >= 1);
    assert.ok(entries[0].id);
    assert.ok(entries[0].root);
    assert.ok(entries[0].branch);
  });

  it('getWorktreeRoot throws for unknown ID', async () => {
    await assert.rejects(
      () => mod.getWorktreeRoot('nonexistent-worktree-id-12345'),
      (err) => err.code === 'NOT_FOUND',
    );
  });

  // -- resolveWorktreeIdByPath (F089 Phase 3a) --

  it('resolveWorktreeIdByPath returns canonical id for known worktree root', async () => {
    const entries = await mod.listWorktrees();
    assert.ok(entries.length > 0, 'should have at least one worktree');
    const first = entries[0];
    const resolvedId = await mod.resolveWorktreeIdByPath(first.root);
    assert.strictEqual(resolvedId, first.id);
  });

  it('resolveWorktreeIdByPath throws NOT_FOUND for unknown path', async () => {
    await assert.rejects(
      () => mod.resolveWorktreeIdByPath('/nonexistent/path/xyzzy'),
      (err) => err.code === 'NOT_FOUND',
    );
  });

  it('resolveWorktreeIdByPath handles all worktree entries consistently', async () => {
    const entries = await mod.listWorktrees();
    for (const entry of entries) {
      const resolvedId = await mod.resolveWorktreeIdByPath(entry.root);
      assert.strictEqual(resolvedId, entry.id, `mismatch for root=${entry.root}`);
    }
  });
});
