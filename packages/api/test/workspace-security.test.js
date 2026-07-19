import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

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

  it('rejects .cat-cafe directory (project config storage)', async () => {
    await assert.rejects(
      () => mod.resolveWorkspacePath(testRoot, '.cat-cafe/credentials.json'),
      (err) => err.code === 'DENIED',
    );
    await assert.rejects(
      () => mod.resolveWorkspacePath(testRoot, '.cat-cafe/cat-catalog.json'),
      (err) => err.code === 'DENIED',
    );
  });

  it('allows data directory at any path (not a reserved namespace)', async () => {
    // Root-level data/ and nested src/data/ are normal project content.
    // Runtime stores belong under .cat-cafe/ (already denied).
    await mkdir(join(testRoot, 'data'), { recursive: true });
    await writeFile(join(testRoot, 'data', 'fixture.json'), '{}');
    const result = await mod.resolveWorkspacePath(testRoot, 'data/fixture.json');
    assert.ok(result.endsWith('data/fixture.json'));
  });

  it('allows nested data directories (src/data/)', async () => {
    await mkdir(join(testRoot, 'src', 'data'), { recursive: true });
    await writeFile(join(testRoot, 'src', 'data', 'input.json'), '{}');
    const result = await mod.resolveWorkspacePath(testRoot, 'src/data/input.json');
    assert.ok(result.endsWith('src/data/input.json'));
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

  it('isDenylisted blocks .cat-cafe config storage', () => {
    assert.ok(mod.isDenylisted('.cat-cafe/credentials.json'));
    assert.ok(mod.isDenylisted('.cat-cafe/cat-catalog.json'));
    assert.ok(mod.isDenylisted('.cat-cafe/linked-roots.json'));
  });

  it('isDenylisted allows data directory (not reserved)', () => {
    assert.ok(!mod.isDenylisted('data/sqlite.db'));
    assert.ok(!mod.isDenylisted('data/evidence/index.json'));
    assert.ok(!mod.isDenylisted('src/data/fixture.json'));
    assert.ok(!mod.isDenylisted('packages/foo/data/input.json'));
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

  it('isDenylisted blocks mixed-case filename variants (case-insensitive FS bypass)', () => {
    assert.ok(mod.isDenylisted('.ENV'));
    assert.ok(mod.isDenylisted('.Env.Local'));
    assert.ok(mod.isDenylisted('certs/SERVER.PEM'));
    assert.ok(mod.isDenylisted('ID_RSA'));
    assert.ok(mod.isDenylisted('keys/Deploy.Key'));
    assert.ok(mod.isDenylisted('.CAT-CAFE/config.json'));
    assert.ok(mod.isDenylisted('.Git/HEAD'));
    assert.ok(mod.isDenylisted('Secrets/token.txt'));
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
