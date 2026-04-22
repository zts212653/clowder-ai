import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

let sharedMod;
let workspaceSecurityMod;

before(async () => {
  sharedMod = await import('../../shared/dist/utils/workspace-paths.js');
  workspaceSecurityMod = await import('../dist/domains/workspace/workspace-security.js');
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
});
