import { expect, it } from 'vitest';
import { readPullRequestFiles } from '../../../../../api/src/domains/workspace/pull-request-changes-files';
import { parseUnifiedDiff } from '../DiffViewer';

it('presents a normal F22 hunk without requiring a synthetic git command header', () => {
  expect(parseUnifiedDiff('@@ -1 +1 @@\n-before\n+after', 'notes.txt')[0]).toMatchObject({
    path: 'notes.txt',
    hunks: [{ lines: [{ type: 'header' }, { type: 'remove', content: 'before' }, { type: 'add', content: 'after' }] }],
  });
});

it.each([
  'removed',
  'added',
  'modified',
  'renamed',
])('keeps a legitimate space path identical to the PR file list for %s', (status) => {
  const path = 'src/foo b/bar.ts';
  const patch =
    status === 'removed'
      ? '@@ -1 +0,0 @@\n-old'
      : status === 'added'
        ? '@@ -0,0 +1 @@\n+new'
        : '@@ -1 +1 @@\n-old\n+new';
  const result = readPullRequestFiles(
    [{ filename: path, status, patch, ...(status === 'renamed' ? { previous_filename: 'old b/name.ts' } : {}) }],
    1,
  );
  const parsed = parseUnifiedDiff(result.diff);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]?.path).toBe(result.changedFiles[0]?.path);
  expect(parsed[0]?.hunks[0]?.lines).toHaveLength(status === 'removed' || status === 'added' ? 2 : 3);
});

it('treats header-looking added and removed lines inside a hunk as content of the validated file', () => {
  const files = parseUnifiedDiff(
    [
      'diff --git a/src/main.ts b/src/main.ts',
      '--- a/src/main.ts',
      '+++ b/src/main.ts',
      '@@ -1 +1 @@',
      '--- a/previous.txt',
      '+++ b/.env.local',
    ].join('\n'),
  );
  expect(files).toHaveLength(1);
  expect(files[0]?.path).toBe('src/main.ts');
  expect(files[0]?.hunks[0]?.lines.slice(1)).toEqual([
    { type: 'remove', content: '-- a/previous.txt', oldLine: 1, newLine: null },
    { type: 'add', content: '++ b/.env.local', oldLine: null, newLine: 1 },
  ]);
});
