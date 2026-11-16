import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { toWorkspaceChangedFile } = await import('../dist/routes/workspace-diff.js');
const { createGitStatusParser } = await import('../dist/domains/workspace/git-status.js');

function parseChunks(...chunks) {
  const files = [];
  const parser = createGitStatusParser((entry) => files.push(toWorkspaceChangedFile(entry)));
  for (const chunk of chunks) parser.write(chunk);
  parser.finish();
  return files;
}

describe('streamed workspace status framing', () => {
  test('preserves the leading status column and filenames split across chunks', () => {
    assert.deepEqual(parseChunks(' M packages/api/fi', 'rst.ts\0M  second.tsx\0?? docs/new.md\0'), [
      { status: 'M', path: 'packages/api/first.ts' },
      { status: 'M', path: 'second.tsx' },
      { status: '??', path: 'docs/new.md' },
    ]);
  });

  test('consumes rename sources separately and preserves literal arrows and newlines', () => {
    assert.deepEqual(parseChunks('R  新 -> 名\n.txt\0old', '.txt\0?? next -> name.txt\0'), [
      { status: 'R', path: '新 -> 名\n.txt' },
      { status: '??', path: 'next -> name.txt' },
    ]);
  });

  test('does not silently accept incomplete records or a missing rename source', () => {
    assert.throws(() => parseChunks('?? partial'), /Incomplete/);
    assert.throws(() => parseChunks('R  renamed.txt\0'), /Incomplete/);
  });
});
