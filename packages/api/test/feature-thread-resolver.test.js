import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildThreadIdsByFeatId, resolveUniqueFeatureThreadId } from '../dist/routes/feature-thread-resolver.js';

function stores(threads, backlogById) {
  return {
    threadStore: {
      async list() {
        return threads;
      },
    },
    backlogStore: {
      async get(id) {
        return backlogById.get(id) ?? null;
      },
    },
  };
}

const logger = { warn() {} };

describe('feature-thread resolver', () => {
  it('resolves one durable feature thread from ThreadStore plus BacklogStore truth', async () => {
    const deps = stores(
      [
        { id: 'thread_f203', backlogItemId: 'backlog-f203' },
        { id: 'thread_other', backlogItemId: 'backlog-f204' },
      ],
      new Map([
        ['backlog-f203', { tags: ['feature:f203'] }],
        ['backlog-f204', { tags: ['feature:f204'] }],
      ]),
    );
    const mapped = await buildThreadIdsByFeatId(deps.threadStore, deps.backlogStore, 'user-1', logger);
    assert.deepEqual(mapped.get('F203'), ['thread_f203']);
    assert.equal(
      await resolveUniqueFeatureThreadId(deps.threadStore, deps.backlogStore, 'user-1', 'F203', logger),
      'thread_f203',
    );
  });

  it('fails closed for missing and ambiguous feature-thread truth', async () => {
    const missing = stores([], new Map());
    await assert.rejects(
      () => resolveUniqueFeatureThreadId(missing.threadStore, missing.backlogStore, 'user-1', 'F203', logger),
      /feature_thread_not_found/,
    );
    const ambiguous = stores(
      [
        { id: 'thread_f203_a', backlogItemId: 'backlog-a' },
        { id: 'thread_f203_b', backlogItemId: 'backlog-b' },
      ],
      new Map([
        ['backlog-a', { tags: ['feature:f203'] }],
        ['backlog-b', { tags: ['feature:f203'] }],
      ]),
    );
    await assert.rejects(
      () => resolveUniqueFeatureThreadId(ambiguous.threadStore, ambiguous.backlogStore, 'user-1', 'F203', logger),
      /feature_thread_ambiguous/,
    );
  });
});
