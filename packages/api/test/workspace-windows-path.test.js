import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { describe, it } from 'node:test';

describe('workspace worktrees repoRoot validation (Windows compat)', () => {
  // The route handler uses isAbsolute() to validate repoRoot.
  // Previously it used startsWith('/') which rejected Windows paths.

  it('accepts Unix absolute path', () => {
    assert.ok(isAbsolute('/home/user/project'));
  });

  it('accepts Windows absolute path with backslash', () => {
    assert.ok(isAbsolute('C:\\Personal\\AIProjects\\test-project'));
  });

  it('accepts Windows absolute path with forward slash', () => {
    assert.ok(isAbsolute('C:/Personal/AIProjects/test-project'));
  });

  it('accepts UNC path', () => {
    assert.ok(isAbsolute('\\\\server\\share\\folder'));
  });

  it('rejects relative path', () => {
    assert.ok(!isAbsolute('relative/path'));
  });

  it('rejects dot-relative path', () => {
    assert.ok(!isAbsolute('./src/index.ts'));
  });

  it('rejects parent-relative path', () => {
    assert.ok(!isAbsolute('../etc/passwd'));
  });
});
