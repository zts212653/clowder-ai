import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KnowledgeResolver } from '../../src/domains/memory/KnowledgeResolver.js';

test('discovery tops up rejected candidates and deduplicates canonical coordinates across sources', async () => {
  const reads: Array<{ cursor?: string; signal?: AbortSignal; deadlineAt?: number }> = [];
  const controller = new AbortController();
  const deadlineAt = Date.now() + 1000;
  const source = {
    id: 'chat',
    read: async (request: { cursor?: string; signal?: AbortSignal; deadlineAt?: number }) => {
      reads.push(request);
      return request.cursor
        ? { candidates: ['message:2', 'message:3'] }
        : { candidates: ['unreadable', 'message:1'], nextCursor: 'next' };
    },
    project: async (candidate: string) => (candidate === 'unreadable' ? null : candidate),
    key: (candidate: string) => candidate,
  };
  const result = await KnowledgeResolver.discover('a changed plan', {
    sources: [source, { ...source, id: 'document-reference', read: async () => ({ candidates: ['message:1'] }) }],
    limit: 3,
    signal: controller.signal,
    deadlineAt,
  });
  assert.deepEqual(new Set(result.items), new Set(['message:1', 'message:2', 'message:3']));
  assert.equal(result.items.length, 3);
  assert.equal(reads.length, 2);
  assert.ok(reads.every((request) => request.signal === reads[0]?.signal && request.deadlineAt === deadlineAt));
  assert.notEqual(reads[0]?.signal, controller.signal, 'discovery owns its read scope');
  assert.equal(controller.signal.aborted, false);
  assert.equal(result.version, 'knowledge-discovery-v1');
});

test('discovery stops source work at its budget without inventing complete coverage', async () => {
  let calls = 0;
  const result = await KnowledgeResolver.discover('needle', {
    sources: [
      {
        id: 'matter',
        read: async () => ({ candidates: [`hidden:${++calls}`], nextCursor: String(calls) }),
        project: async () => null,
        key: (row: string) => row,
      },
    ],
    limit: 2,
    candidateBudget: 3,
  });
  assert.equal(calls, 3);
  assert.deepEqual(result.items, []);
  assert.equal(result.sources[0]?.stopReason, 'candidate_budget');
  assert.equal(result.sources[0]?.nextCursor, '3');
});

test('a source cannot publish candidates after cancellation during projection', async () => {
  const controller = new AbortController();
  await assert.rejects(
    KnowledgeResolver.discover('private', {
      sources: [
        {
          id: 'chat',
          read: async () => ({ candidates: ['revoked'] }),
          project: async (row: string) => {
            controller.abort();
            return row;
          },
          key: (row: string) => row,
        },
      ],
      limit: 1,
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
});

test('a stalled owner read cannot outlive the shared discovery deadline', { timeout: 500 }, async () => {
  await assert.rejects(
    KnowledgeResolver.discover('stalled', {
      limit: 1,
      deadlineAt: Date.now() + 25,
      sources: [
        {
          id: 'stalled',
          read: () => new Promise(() => {}),
          project: async (row: string) => row,
          key: (row: string) => row,
        },
      ],
    }),
    { name: 'TimeoutError' },
  );
});
