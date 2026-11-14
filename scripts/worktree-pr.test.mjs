import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPrTruth, worktreePrBinding } from './lib/worktree-pr.mjs';

const source = 'pr:fixture/repo#42';
const head = 'a'.repeat(40);
const old = 'b'.repeat(40);
const metadata = {
  base: { ref: 'main', repo: { full_name: 'fixture/repo' } },
  state: 'closed',
  merged: true,
  head: { sha: head },
  merge_commit_sha: 'c'.repeat(40),
  commits: 2,
  html_url: 'https://github.com/fixture/repo/pull/42',
};
test('PR responsibility uses explicit local provenance, rejecting stale or corrupt owner intent', () => {
  const origin = { threadId: 'thread_original', sourceRef: source, role: 'author', userId: 'user' };
  const lifecycle = { owner: 'codex61-sol', origin };
  assert.equal(worktreePrBinding(lifecycle, head).sourceRef, source);
  assert.equal(
    worktreePrBinding({ ...lifecycle, prSource: 'pr:fixture/repo#99' }, head).sourceRef,
    'pr:fixture/repo#99',
    'an explicit bind preserves but supersedes the original birth source',
  );
  const retention = {
    owner: lifecycle.owner,
    sourceRef: source,
    head,
    reason: 'original review',
    recordedAt: '2026-11-01T00:00:00Z',
    until: '2026-11-02T00:00:00Z',
  };
  const retained = { ...lifecycle, origin: { ...origin, sourceRef: 'task:work:original' }, retention };
  assert.equal(worktreePrBinding(retained, head).sourceRef, source, 'expired exact intent remains discoverable');
  for (const broken of [
    { ...retained, retention: { ...retention, owner: 'sonnet' } },
    { ...retained, retention: { ...retention, head: old } },
    { ...retained, retention: { ...retention, sourceRef: 42 } },
    { ...lifecycle, origin: { ...origin, role: 'invalid' } },
    { ...lifecycle, prSource: '' },
  ]) {
    const result = worktreePrBinding(broken, head);
    assert.equal(result.sourceRef, undefined);
    assert.match(result.reason, /provenance/);
  }
});

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
