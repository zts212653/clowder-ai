import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { ActionSuccessorKeys } from '../dist/domains/ball-custody/action-successor-keys.js';
import { approvedTaskFixture, OWNER, USER } from './helpers/approved-task-contract-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const reads = [
  ['proposal', 'hgetall', (f) => `proposal:${f.proposalId}`],
  ['task', 'hgetall', (f) => `task:${f.task.id}`],
  ['child', 'hgetall', (f) => `thread:${f.childId}`],
  ['history_index', 'smembers', () => ActionSuccessorKeys.ALL],
];

for (const [object, method, readKey] of reads) {
  test(
    `continuation ${object} read failure is attributable internally and private externally`,
    { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
    async (t) => {
      const f = await approvedTaskFixture(t);
      const duplicate = f.redis.duplicate.bind(f.redis);
      f.redis.duplicate = (...args) => {
        const session = duplicate(...args);
        const read = session[method].bind(session);
        session[method] = (...readArgs) => {
          if (readArgs[0] === readKey(f)) return Promise.reject(new Error('secret-storage-error-with-original-bytes'));
          return read(...readArgs);
        };
        return session;
      };
      const result = await f.proposals.continueApprovedTask({
        ...f.input,
        actor: { userId: USER, catId: OWNER, threadId: f.source.id },
      });
      assert.equal(result.outcome, 'rejected');
      assert.equal(result.reason, 'unavailable');
      assert.equal(result.diagnostic.object, object);
      assert.equal(result.diagnostic.stage, 'read');
      assert.match(result.diagnostic.keyDigest, /^[a-f0-9]{16}$/);
      assert.doesNotMatch(JSON.stringify(result), /secret-storage|original-bytes/);
      const response = await f.continueTask();
      assert.equal(response.statusCode, 503, response.body);
      assert.deepEqual(response.json(), { outcome: 'rejected', reason: 'unavailable' });
      assert.equal(await f.redis.hget(`proposal:${f.proposalId}`, 'taskContractContinuation'), null);
    },
  );
}
