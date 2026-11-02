import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import './helpers/setup-cat-registry.js';
import { approvedTaskFixture, OWNER, TARGET, USER } from './helpers/approved-task-contract-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

describe(
  'generic approval → seed/READY → existing continuation → native Task dispatch',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  () => {
    for (const legacy of [true, false])
      test(`${legacy ? 'legacy' : 'new'} complete approval runs the real isolated chain`, async (t) => {
        const f = await approvedTaskFixture(t, { legacy });
        const before = await f.redis.hgetall(`proposal:${f.proposalId}`);
        const messagesBefore = await f.messages.getByThreadAfter(f.childId, undefined, undefined, USER);
        assert.equal(messagesBefore.length, 2, 'actual approval seed and READY must already exist');
        assert.equal(
          (await f.delegates.getForTask(f.task.id, f.source.id, OWNER, USER, undefined, f.task.title)).length,
          0,
        );
        const denied = await f.implement();
        assert.notEqual(denied.statusCode, 200, denied.body);
        assert.equal((await f.leases.listActiveTaskLeases()).length, 0);
        assert.equal((await f.messages.getByThreadAfter(f.childId, undefined, undefined, USER)).length, 2);

        const continued = await f.continueTask();
        assert.equal(continued.statusCode, 200, continued.body);
        assert.equal(continued.json().outcome, 'continued');
        const receipt = continued.json().receipt;
        assert.equal(receipt.taskId, f.task.id);
        assert.equal(receipt.childThreadId, f.childId);
        assert.deepEqual(receipt.targetCatIds, [TARGET]);
        const after = await f.redis.hgetall(`proposal:${f.proposalId}`);
        const { taskContractContinuation: _, ...unchanged } = after;
        assert.deepEqual(unchanged, before, 'old approval/card/scope are never rewritten');
        assert.equal(await f.redis.ttl(`proposal:${f.proposalId}`), -1);

        const accepted = await f.implement();
        assert.equal(accepted.statusCode, 200, accepted.body);
        assert.equal(
          (await f.leases.listActiveTaskLeases()).length,
          0,
          'ordinary work does not create an implementation lease',
        );
        const source = await f.messages.getById(accepted.json().messageId);
        assert.ok(source.extra.taskHandoff.approvedAnchor.evidenceRef.includes(`:continuation:${receipt.receiptId}:`));
        const current = await f.tasks.get(f.task.id);
        assert.equal(current.threadId, f.source.id);
        assert.equal(current.ownerCatId, OWNER);
        assert.equal(current.lastAppliedHandoffMessageRef, `message:${source.id}`);
        const entries = await f.queue.listAllDurable(f.childId);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].execution.actionSuccessorFence, undefined);
        assert.equal((await f.handoffs.apply(source.id)).kind, 'replayed');
        const replay = await f.continueTask();
        assert.equal(replay.json().outcome, 'replayed', replay.body);
        assert.deepEqual(replay.json().receipt, receipt, 'replay after implementation preserves original receipt');
        const repeated = await f.implement();
        assert.equal(repeated.statusCode, 200, repeated.body);
        assert.equal((await f.queue.listAllDurable(f.childId)).length, 1, 'one durable carrier');
      });

    test('contract drift invalidates both recovered native handoff and actual provider admission', async (t) => {
      const f = await approvedTaskFixture(t);
      assert.equal((await f.continueTask()).statusCode, 200);
      const sent = await f.implement();
      assert.equal(sent.statusCode, 200, sent.body);
      const sourceId = sent.json().messageId;
      await f.tasks.update(f.task.id, { title: 'Different work' });
      const result = await f.handoffs.apply(sourceId);
      assert.deepEqual(result, { kind: 'refused', reason: 'task_approved_contract_unavailable' });
      await assert.rejects(
        f.handoffs.start(
          sourceId,
          { userId: USER, catId: TARGET, threadId: f.childId, invocationId: 'new-child' },
          'parent',
        ),
        /task_approved_contract_unavailable/,
      );
      assert.equal((await f.tasks.get(f.task.id)).executionRef, undefined);
      assert.equal((await f.leases.listActiveTaskLeases()).length, 0);
    });

    test('a new API process reads the same permanent receipt and derives the same delegate', async (t) => {
      const f = await approvedTaskFixture(t);
      const receipt = (await f.continueTask()).json().receipt;
      const script = `
      import './test/helpers/setup-cat-registry.js';
      import { Redis } from 'ioredis';
      import { RedisProposalStore } from './dist/domains/cats/services/stores/redis/RedisProposalStore.js';
      import { RedisThreadStore } from './dist/domains/cats/services/stores/redis/RedisThreadStore.js';
      import { createTaskApprovedDelegateProvider } from './dist/domains/ball-custody/ProposalStoreDelegateProvider.js';
      const input = JSON.parse(process.env.F167_RESTART_INPUT);
      const redis = new Redis(process.env.REDIS_URL, { keyPrefix: input.prefix });
      try {
        const proposals = new RedisProposalStore(redis);
        const provider = createTaskApprovedDelegateProvider(proposals, new RedisThreadStore(redis));
        process.stdout.write(JSON.stringify({receipt:(await proposals.get(input.proposalId)).taskContractContinuation,
          delegates:await provider.getForTask(input.taskId,input.sourceId,input.owner,input.user,undefined,input.title)}));
      } finally { await redis.quit(); }
    `;
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          F167_RESTART_INPUT: JSON.stringify({
            prefix: f.redis.options.keyPrefix,
            proposalId: f.proposalId,
            taskId: f.task.id,
            sourceId: f.source.id,
            owner: OWNER,
            user: USER,
            title: f.task.title,
          }),
        },
        timeout: 10000,
      });
      const restarted = JSON.parse(stdout.trim());
      assert.deepEqual(restarted.receipt, receipt, JSON.stringify(restarted));
      assert.equal(restarted.delegates.length, 1);
      assert.equal(restarted.delegates[0].catId, TARGET);
    });
  },
);
