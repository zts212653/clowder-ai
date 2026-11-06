import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

let sharedMod;
let workspaceSecurityMod;
let workspacePathResolutionMod;

before(async () => {
  sharedMod = await import('../../shared/dist/utils/workspace-paths.js');
  workspaceSecurityMod = await import('../dist/domains/workspace/workspace-security.js');
  workspacePathResolutionMod = await import('../dist/domains/workspace/workspace-path-resolution.js');
});

describe('workspace path compatibility helpers', () => {
  it('accepts Windows drive-letter absolute paths', () => {
    assert.equal(sharedMod.isAbsoluteFilesystemPath('D:\\code\\clowder-ai'), true);
  });

  it('rejects relative Windows-looking paths', () => {
    assert.equal(sharedMod.isAbsoluteFilesystemPath('code\\clowder-ai'), false);
  });

  it('normalizes Windows separators to POSIX separators', () => {
    assert.equal(sharedMod.normalizeWorkspaceRelativePath('packages\\web\\src\\App.tsx'), 'packages/web/src/App.tsx');
  });

  it('preserves POSIX relative paths', () => {
    assert.equal(sharedMod.normalizeWorkspaceRelativePath('packages/web/src/App.tsx'), 'packages/web/src/App.tsx');
  });

  it('leaves dot paths untouched', () => {
    assert.equal(sharedMod.normalizeWorkspaceRelativePath('.'), '.');
  });

  it('keeps denylist checks working for normalized POSIX workspace paths', () => {
    assert.equal(workspaceSecurityMod.isDenylisted('secrets/nested/token.txt'), true);
    assert.equal(workspaceSecurityMod.isDenylisted('.git/hooks/pre-commit'), true);
    assert.equal(workspaceSecurityMod.isDenylisted('packages/api/src/routes/workspace.ts'), false);
  });

  it('resolves a Windows drive link written with a leading slash', { skip: process.platform !== 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-drive-link-'));
    try {
      await writeFile(join(root, 'doc.md'), '# doc\n');
      const href = `/${root.replaceAll('\\', '/').replace(/^\//, '')}/doc.md`;
      const target = await workspacePathResolutionMod.resolveWorkspaceAbsolutePath(href, undefined, [
        { id: 'drive-wt', root, branch: 'main', head: 'abc123' },
      ]);
      assert.deepEqual(target, { worktreeId: 'drive-wt', path: 'doc.md', kind: 'file' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('only strips the extra slash on Windows', () => {
    assert.equal(workspacePathResolutionMod.normalizeWindowsDriveLinkPath('/D:/code/x.md', 'win32'), 'D:/code/x.md');
    assert.equal(workspacePathResolutionMod.normalizeWindowsDriveLinkPath('/D:/code/x.md', 'linux'), '/D:/code/x.md');
  });
});
