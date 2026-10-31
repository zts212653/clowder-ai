import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DevelopmentScopeV1 } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { RedisTaskDevelopmentWorkStore } from '../../src/domains/cats/services/stores/redis/RedisTaskDevelopmentWorkStore.js';

const TASK_COUNT = 4_485;
const scope: DevelopmentScopeV1 = {
  featureRef: 'feature:F310',
  phaseKey: 'B',
  workUnitRef: 'file:docs/plans/f310.md#absent-scope',
  acceptedSourceRef: 'file:docs/plans/f310.md',
  acceptedRevision: 'a'.repeat(40),
};

test('an absent development scope checks a production-sized task set in bounded Redis response waves', async (t) => {
  const ids = Array.from({ length: TASK_COUNT }, (_, index) => `task-${index}`);
  const rows = new Map(
    ids.map((id) => [
      `task:${id}`,
      {
        id,
        kind: 'work',
        threadId: 'unrelated-thread',
        title: id,
        ownerCatId: 'codex61-sol',
        status: 'doing',
        why: '',
        createdBy: 'codex61-sol',
        createdAt: '1',
        updatedAt: '1',
        userId: 'owner',
        resolveMode: '',
      },
    ]),
  );
  let responseWaves = 0;
  let pipelinedHashReads = 0;

  const redis = {
    duplicate() {
      return redis;
    },
    async watch() {
      responseWaves += 1;
      return 'OK';
    },
    async unwatch() {
      responseWaves += 1;
      return 'OK';
    },
    disconnect() {},
    async get() {
      responseWaves += 1;
      return null;
    },
    async zrange() {
      responseWaves += 1;
      return ids;
    },
    async hgetall(key: string) {
      responseWaves += 1;
      return rows.get(key) ?? {};
    },
    pipeline() {
      const keys: string[] = [];
      const pipeline = {
        hgetall(key: string) {
          keys.push(key);
          return pipeline;
        },
        async exec() {
          responseWaves += 1;
          pipelinedHashReads += keys.length;
          return keys.map((key) => [null, rows.get(key) ?? {}] as const);
        },
      };
      return pipeline;
    },
    multi() {
      const transaction = {
        set() {
          return transaction;
        },
        del() {
          return transaction;
        },
        async exec() {
          responseWaves += 1;
          return [[null, 1]];
        },
      };
      return transaction;
    },
  } as unknown as RedisClient;
  assert.deepEqual(await new RedisTaskDevelopmentWorkStore(redis).find('owner', scope), []);
  assert.equal(pipelinedHashReads, TASK_COUNT, 'the bounded read must still examine every canonical candidate');
  assert.ok(responseWaves <= 8, `absent-scope lookup used ${responseWaves} Redis response waves`);
  t.diagnostic(JSON.stringify({ taskCount: TASK_COUNT, responseWaves }));
});

test('an unavailable candidate pipeline cannot be mistaken for an absent responsibility', async () => {
  const redis = {
    duplicate() {
      return redis;
    },
    async watch() {
      return 'OK';
    },
    async unwatch() {
      return 'OK';
    },
    disconnect() {},
    async get() {
      return null;
    },
    async zrange() {
      return ['candidate'];
    },
    async hgetall() {
      return {};
    },
    pipeline() {
      const pipeline = {
        hgetall() {
          return pipeline;
        },
        async exec() {
          return null;
        },
      };
      return pipeline;
    },
    multi() {
      throw new Error('an uncertain candidate read must not commit an empty scope index');
    },
  } as unknown as RedisClient;

  await assert.rejects(
    new RedisTaskDevelopmentWorkStore(redis).find('owner', scope),
    /Development scope candidate read incomplete/,
  );
});
