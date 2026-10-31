import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVAL, approvedScope } from '../src/scripts/github-approved-source/approved-scope.js';
import { commentOverlapReader } from '../src/scripts/github-approved-source/comment-overlap.js';
import { readProviderOverlap } from '../src/scripts/github-approved-source/comment-window-provider.js';

const scope = approvedScope(APPROVAL.sourceRef, 'fixture:no-writer');
const repo = 'zts212653/clowder-ai';
const cursor = '2026-10-20T16:14:43Z';
const key = `${scope.keyPrefix}community:repo-comment:cursor:${repo}`;
const setKey = `${scope.keyPrefix}community:events:seen`;
const signal = new AbortController().signal;
test('provider metadata must exhaust every page and remain inside its exact repository/time window', async () => {
  const row = (id: number) => ({ id, updated_at: cursor, issue_url: `https://api.github.com/repos/${repo}/issues/42` });
  const pages: number[] = [];
  const ids = await readProviderOverlap(repo, cursor, signal, async (r, since, page) => {
    assert.equal(r, repo);
    assert.equal(since, '2026-10-20T16:14:42.000Z');
    pages.push(page);
    return page === 1 ? Array.from({ length: 100 }, (_, i) => row(i + 1)) : [row(101)];
  });
  assert.equal(ids.length, 101);
  assert.deepEqual(pages, [1, 2]);
  await assert.rejects(
    readProviderOverlap(repo, cursor, signal, async (_, __, page) =>
      Array.from({ length: 100 }, (_, i) => row((page - 1) * 100 + i + 1)),
    ),
    /incomplete/,
  );
  for (const bad of [
    { ...row(1), body: 'do not read' },
    { ...row(1), issue_url: 'https://api.github.com/repos/other/repo/issues/42' },
    { ...row(1), updated_at: '2020-01-01T00:00:00Z' },
  ])
    await assert.rejects(readProviderOverlap(repo, cursor, signal, async () => [bad]));
  await assert.rejects(
    readProviderOverlap(repo, cursor, signal, async () => [row(1), row(1)]),
    /changed/,
  );
});
test('large historical seen set retains exactly the complete current provider overlap and its original census', async () => {
  const old = Array.from({ length: 1500 }, (_, i) => `comment:${repo}#42:${i + 1}`);
  let fetches = 0;
  const project = commentOverlapReader(
    { read: async (command) => (command === 'GET' ? cursor : ['0', old]) },
    scope,
    signal,
    async (r, since) => {
      assert.equal(r, repo);
      assert.equal(since, cursor);
      fetches++;
      return [`comment:${repo}#42:1500`, `comment:${repo}#42:1501`];
    },
  );
  assert.equal(await project.reader.read('GET', key), cursor);
  assert.deepEqual(await project.reader.read('SSCAN', setKey, '0', 'MATCH', `comment:${repo}#*`, 'COUNT', '256'), [
    '0',
    [`comment:${repo}#42:1500`],
  ]);
  const [census] = project.census();
  assert.equal(census?.originalSeenIds.length, 1500);
  assert.deepEqual(census?.retainedOverlapIds, [`comment:${repo}#42:1500`]);
  assert.equal(fetches, 1);
});
test('empty pages and later cursor preserve all membership; failed provider coverage cannot be called empty', async () => {
  let page = 0;
  const project = commentOverlapReader(
    {
      read: async (command) =>
        command === 'GET' ? cursor : page++ === 0 ? ['73', []] : ['0', [`comment:${repo}#42:7`]],
    },
    scope,
    signal,
    async () => [`comment:${repo}#42:7`],
  );
  await project.reader.read('GET', key);
  assert.deepEqual(await project.reader.read('SSCAN', setKey, '0', 'MATCH', `comment:${repo}#*`, 'COUNT', '256'), [
    '73',
    [],
  ]);
  assert.deepEqual(await project.reader.read('SSCAN', setKey, '73', 'MATCH', `comment:${repo}#*`, 'COUNT', '256'), [
    '0',
    [`comment:${repo}#42:7`],
  ]);
  const failed = commentOverlapReader(
    { read: async (command) => (command === 'GET' ? cursor : ['0', []]) },
    scope,
    signal,
    async () => {
      throw new Error('pagination incomplete');
    },
  );
  await failed.reader.read('GET', key);
  await assert.rejects(
    failed.reader.read('SSCAN', setKey, '0', 'MATCH', `comment:${repo}#*`, 'COUNT', '256'),
    /incomplete/,
  );
});
test('missing cursor keeps stock baseline behavior; invalid or foreign evidence refuses the projection', async () => {
  const raw = ['0', [`comment:${repo}#42:7`]];
  const missing = commentOverlapReader(
    { read: async (command) => (command === 'GET' ? null : raw) },
    scope,
    signal,
    async () => {
      throw Error('No provider read expected');
    },
  );
  await missing.reader.read('GET', key);
  assert.equal(await missing.reader.read('SSCAN', setKey, '0', 'MATCH', `comment:${repo}#*`, 'COUNT', '256'), raw);
  const invalid = commentOverlapReader(
    { read: async (command) => (command === 'GET' ? cursor : raw) },
    scope,
    signal,
    async () => ['comment:another/project#42:7'],
  );
  await assert.rejects(
    invalid.reader.read('SSCAN', setKey, '0', 'MATCH', `comment:${repo}#*`, 'COUNT', '256'),
    /original cursor/,
  );
  await invalid.reader.read('GET', key);
  await assert.rejects(
    invalid.reader.read('SSCAN', setKey, '0', 'MATCH', `comment:${repo}#*`, 'COUNT', '256'),
    /Unscoped/,
  );
});
