import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KnowledgeResolver } from '../../src/domains/memory/KnowledgeResolver.js';
import type { KnowledgeDiscoverySource } from '../../src/domains/memory/knowledge-discovery.js';

const source = (id: string): KnowledgeDiscoverySource<string, string> => ({
  id,
  read: async () => ({ candidates: [id] }),
  project: async (row) => row,
  revalidate: async (row) => row,
  key: (row) => row,
});

test('a tolerated final source error drops that entire source and retains independently revalidated sources', async () => {
  const fast = source('fast');
  let checkedFast = false;
  fast.revalidate = async (row) => {
    checkedFast = true;
    return row;
  };
  const broken = source('broken');
  broken.tolerateError = true;
  broken.read = async () => ({ candidates: ['earlier', 'throws'] });
  broken.revalidate = async (row) => {
    if (row === 'throws') throw new Error('source temporarily unavailable');
    return row;
  };
  const found = await KnowledgeResolver.discover('neutral', { limit: 4, sources: [fast, broken] });
  assert.equal(checkedFast, true);
  assert.deepEqual(found.items, ['fast']);
  assert.deepEqual(found.sources[1]?.items, [], 'a partially revalidated failed source cannot publish');
  assert.equal(found.sources[1]?.stopReason, 'error');
});

test('a non-tolerated final source failure still rejects the entire discovery', async () => {
  const broken = source('broken');
  const failure = new Error('required source failed');
  broken.revalidate = async () => {
    throw failure;
  };
  await assert.rejects(
    KnowledgeResolver.discover('neutral', { limit: 4, sources: [source('fast'), broken] }),
    (error) => error === failure,
  );
});

test('caller cancellation during tolerated revalidation still rejects all completed sources', async () => {
  const parent = new AbortController();
  const reason = new DOMException('caller left', 'AbortError');
  const broken = source('broken');
  broken.tolerateError = true;
  broken.revalidate = async () => {
    parent.abort(reason);
    throw new Error('source failed at the same time');
  };
  await assert.rejects(
    KnowledgeResolver.discover('neutral', { limit: 4, signal: parent.signal, sources: [source('fast'), broken] }),
    (error) => error === reason,
  );
});

test('the original absolute deadline still rejects all results during a tolerated final revalidation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const broken = source('broken');
  broken.tolerateError = true;
  broken.revalidate = async () => {
    t.mock.timers.tick(100);
    throw new Error('source error after the deadline');
  };
  await assert.rejects(
    KnowledgeResolver.discover('neutral', { limit: 4, deadlineAt: 1100, sources: [source('fast'), broken] }),
    { name: 'TimeoutError' },
  );
});

test('a final authority check remains fatal even when every source tolerates ordinary errors', async () => {
  let checks = 0;
  const required = new Error('authority withdrawn');
  const fast = source('fast');
  fast.tolerateError = true;
  fast.revalidate = async (row) => {
    checks++;
    return row;
  };
  await assert.rejects(
    KnowledgeResolver.discover('neutral', {
      limit: 1,
      sources: [fast],
      check() {
        if (checks) throw required;
      },
    }),
    (error) => error === required,
  );
});
