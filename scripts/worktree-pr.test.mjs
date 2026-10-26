import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPrTruth } from './lib/worktree-pr.mjs';

const source = 'pr:fixture/repo#42';
const head = 'a'.repeat(40);
const old = 'b'.repeat(40);
const metadata = {
  base: { repo: { full_name: 'fixture/repo' } },
  state: 'closed',
  merged: true,
  head: { sha: head },
  merge_commit_sha: 'c'.repeat(40),
  commits: 2,
  html_url: 'https://github.com/fixture/repo/pull/42',
};
test('PR truth requires complete paginated commit membership and exact repository', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return args.includes('--paginate') ? `${old}\n${head}\n` : JSON.stringify(metadata);
  };
  assert.deepEqual(readPrTruth(source, run).commits, [old, head]);
  assert(calls.some((args) => args.includes('--paginate')));
  assert.throws(
    () => readPrTruth(source, (args) => (args.includes('--paginate') ? `${head}\n` : JSON.stringify(metadata))),
    /incomplete/,
  );
  assert.throws(
    () =>
      readPrTruth(source, (args) =>
        args.includes('--paginate')
          ? `${old}\n${head}`
          : JSON.stringify({ ...metadata, base: { repo: { full_name: 'foreign/repo' } } }),
      ),
    /identity/,
  );
  for (const input of ['--all', 'pr:owner/repo#0', 'pr:owner/repo#42;touch x'])
    assert.throws(
      () =>
        readPrTruth(input, () => {
          throw new Error('must not execute');
        }),
      /expected pr:/,
    );
});
