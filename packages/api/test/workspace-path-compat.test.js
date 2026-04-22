import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAbsoluteFilesystemPath, normalizeWorkspaceRelativePath } from '../../shared/src/utils/workspace-paths.ts';
import { isDenylisted } from '../src/domains/workspace/workspace-security.ts';

describe('workspace path compatibility helpers', () => {
  it('accepts Windows drive-letter absolute paths', () => {
    assert.equal(isAbsoluteFilesystemPath('D:\\code\\clowder-ai'), true);
  });

  it('rejects relative Windows-looking paths', () => {
    assert.equal(isAbsoluteFilesystemPath('code\\clowder-ai'), false);
  });

  it('normalizes Windows separators to POSIX separators', () => {
    assert.equal(normalizeWorkspaceRelativePath('packages\\web\\src\\App.tsx'), 'packages/web/src/App.tsx');
  });

  it('preserves POSIX relative paths', () => {
    assert.equal(normalizeWorkspaceRelativePath('packages/web/src/App.tsx'), 'packages/web/src/App.tsx');
  });

  it('leaves dot paths untouched', () => {
    assert.equal(normalizeWorkspaceRelativePath('.'), '.');
  });

  it('keeps denylist checks working for normalized POSIX workspace paths', () => {
    assert.equal(isDenylisted('secrets/nested/token.txt'), true);
    assert.equal(isDenylisted('.git/hooks/pre-commit'), true);
    assert.equal(isDenylisted('packages/api/src/routes/workspace.ts'), false);
  });
});
