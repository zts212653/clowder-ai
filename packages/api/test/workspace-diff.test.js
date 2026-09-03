import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { parseWorkspaceChangedFiles } = await import('../dist/routes/workspace-diff.js');

describe('parseWorkspaceChangedFiles', () => {
  test('preserves the leading porcelain status column on the first changed file', () => {
    const changedFiles = parseWorkspaceChangedFiles(
      [' M packages/api/test/first.test.js', 'M  packages/web/src/second.tsx', '?? docs/new.md', ''].join('\n'),
    );

    assert.deepEqual(changedFiles, [
      { status: 'M', path: 'packages/api/test/first.test.js' },
      { status: 'M', path: 'packages/web/src/second.tsx' },
      { status: '??', path: 'docs/new.md' },
    ]);
  });

  test('normalizes rename output without changing ordinary filenames containing arrows', () => {
    assert.deepEqual(parseWorkspaceChangedFiles('R  old.ts -> new.ts\n M docs/name -> literal.md\n'), [
      { status: 'R', path: 'new.ts' },
      { status: 'M', path: 'docs/name -> literal.md' },
    ]);
  });
});
