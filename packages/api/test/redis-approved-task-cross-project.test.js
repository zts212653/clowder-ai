import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { approvedTaskFixture, OWNER, TARGET, USER } from './helpers/approved-task-contract-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

async function crossProjectFixture(t, options = {}) {
  const projectPath = mkdtempSync(join(process.cwd(), '.tmp-approved-project-'));
  t.after(() => rmSync(projectPath, { recursive: true, force: true }));
  return approvedTaskFixture(t, { ...options, projectPath });
}

async function appendHandoff(f, input) {
  const request = await f.handoffs.prepare({ taskId: f.task.id, expectedOwnerRevision: 0, ...input });
  return f.messages.append({
    userId: USER,
    from: { kind: 'agent', catId: request.issuer.catId },
    threadId: request.targetThreadId,
    content: 'Continue the same approved Task',
    mentions: [request.targetCatId],
    origin: 'callback',
    timestamp: Date.now(),
    extra: { taskHandoff: request },
  });
}

function changeAtTaskCommit(f, change) {
  const duplicate = f.redis.duplicate.bind(f.redis);
  let changed = false;
  f.redis.duplicate = (...args) => {
    const session = duplicate(...args);
    const multi = session.multi.bind(session);
    session.multi = (...multiArgs) => {
      const transaction = multi(...multiArgs);
      const exec = transaction.exec.bind(transaction);
      transaction.exec = async (...execArgs) => {
        if (!changed) {
          changed = true;
          await change();
        }
        return exec(...execArgs);
      };
      return transaction;
    };
    return session;
  };
  return () => assert.equal(changed, true, 'the race must reach the real Redis Task commit');
}

// The real approval/continuation/callback/Redis chain protects the wiring that a
// mocked delegate cannot prove: approval explicitly names a different project.
describe(
  'exact approved Task child in another project',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  () => {
    for (const legacy of [true, false]) {
      test(`${legacy ? 'legacy' : 'frozen'} contract admits the approved project and replays the same source`, async (t) => {
        const f = await crossProjectFixture(t, { legacy });
        assert.notEqual((await f.threads.get(f.childId)).projectPath, f.source.projectPath);
        const continuation = await f.continueTask();
        assert.equal(continuation.statusCode, 200, continuation.body);
        assert.equal(continuation.json().outcome, 'continued');
        const receipt = continuation.json().receipt;
        const delegates = await f.delegates.getForTask(f.task.id, f.source.id, OWNER, USER, undefined, f.task.title);
        assert.equal(delegates.length, 1, 'the production provider already recognizes the exact approval');

        const sent = await f.implement();
        assert.equal(sent.statusCode, 200, sent.body);
        const sourceId = sent.json().messageId;
        const current = await f.tasks.get(f.task.id);
        assert.equal(current.threadId, f.source.id);
        assert.equal(current.ownerCatId, OWNER);
        assert.equal(current.ownerRevision, 0);
        assert.equal(current.lastAppliedHandoffMessageRef, `message:${sourceId}`);
        assert.equal((await f.handoffs.apply(sourceId)).kind, 'replayed');
        assert.deepEqual((await f.continueTask()).json().receipt, receipt);
        assert.equal((await f.implement()).json().messageId, sourceId);
        assert.equal((await f.queue.listAllDurable(f.childId)).length, 1);
        assert.equal((await f.leases.listActiveTaskLeases()).length, 0);

        const actor = { userId: USER, catId: TARGET, threadId: f.childId, invocationId: 'approved-child' };
        await f.handoffs.start(sourceId, actor, 'approved-parent');
        assert.deepEqual((await f.tasks.get(f.task.id)).executionRef, {
          invocationId: actor.invocationId,
          parentInvocationId: 'approved-parent',
          catId: TARGET,
          threadId: f.childId,
          sourceMessageId: sourceId,
        });
      });
    }

    test('same-child successor and return home retain approval and exact writer teardown', async (t) => {
      const f = await crossProjectFixture(t);
      assert.equal((await f.continueTask()).statusCode, 200);
      const sent = await f.implement();
      assert.equal(sent.statusCode, 200, sent.body);
      const actor = { userId: USER, catId: TARGET, threadId: f.childId, invocationId: 'child-writer' };
      await f.turns.createRunning({ ...actor, parentInvocationId: 'parent', executionKind: 'ordinary', startedAt: 1 });
      await f.handoffs.start(sent.json().messageId, actor, 'parent');
      const successor = await appendHandoff(f, { actor, targetCatId: 'sonnet', targetThreadId: f.childId });
      assert.equal((await f.handoffs.apply(successor.id)).kind, 'waiting');
      await f.turns.transitionTerminal(actor.invocationId, { status: 'succeeded', endedAt: 2 });
      assert.equal((await f.handoffs.apply(successor.id)).kind, 'waiting', 'terminal alone is not provider teardown');
      await f.turns.recordProviderTeardown(actor.invocationId, 3);
      assert.equal((await f.handoffs.apply(successor.id)).kind, 'applied');
      assert.equal((await f.handoffs.apply(successor.id)).kind, 'replayed');
      const nextActor = { ...actor, catId: 'sonnet', invocationId: 'next-writer' };
      await f.turns.createRunning({
        ...nextActor,
        parentInvocationId: 'next-parent',
        executionKind: 'ordinary',
        startedAt: 4,
      });
      await f.handoffs.start(successor.id, nextActor, 'next-parent');
      await f.handoffs.finish(f.task.id, actor.invocationId);
      assert.equal((await f.tasks.get(f.task.id)).executionRef.invocationId, nextActor.invocationId);
      await f.turns.transitionTerminal(nextActor.invocationId, {
        status: 'succeeded',
        endedAt: 5,
        providerTeardownAt: 5,
      });
      await f.handoffs.finish(f.task.id, nextActor.invocationId);
      const returned = await appendHandoff(f, { actor: nextActor, targetCatId: OWNER, targetThreadId: f.source.id });
      assert.equal((await f.handoffs.apply(returned.id)).kind, 'applied');
      assert.equal((await f.handoffs.apply(returned.id)).kind, 'replayed');
      await f.handoffs.start(
        returned.id,
        { ...actor, catId: OWNER, threadId: f.source.id, invocationId: 'home-writer' },
        'home-parent',
      );
      const current = await f.tasks.get(f.task.id);
      assert.equal(current.threadId, f.source.id);
      assert.equal(current.ownerCatId, OWNER);
      assert.equal(current.ownerRevision, 0);
      assert.equal(current.executionRef.threadId, f.source.id);
    });

    for (const mismatch of ['no continuation', 'wrong cat', 'wrong child', 'foreign child']) {
      test(`${mismatch} cannot use the project exception`, async (t) => {
        const f = await crossProjectFixture(t);
        if (mismatch !== 'no continuation') assert.equal((await f.continueTask()).statusCode, 200);
        const overrides = {};
        if (mismatch === 'wrong cat') overrides.targetCats = ['sonnet'];
        if (mismatch === 'wrong child') {
          const other = await f.threads.create(USER, 'Unapproved child', (await f.threads.get(f.childId)).projectPath);
          overrides.threadId = other.id;
        }
        if (mismatch === 'foreign child') await f.redis.hset(`thread:${f.childId}`, 'createdBy', 'foreign');
        const denied = await f.implement(overrides);
        assert.equal(denied.statusCode, mismatch === 'foreign child' ? 403 : 409, denied.body);
        const current = await f.tasks.get(f.task.id);
        assert.equal(current.lastAppliedHandoffMessageRef, undefined);
        assert.equal(current.executionRef, undefined);
        assert.equal((await f.leases.listActiveTaskLeases()).length, 0);
      });
    }

    test('same-user creator in an unapproved source project has no project exception', async (t) => {
      const f = await crossProjectFixture(t);
      assert.equal((await f.continueTask()).statusCode, 200);
      await f.redis.hset(`task:${f.task.id}`, 'createdBy', OWNER);
      const unrelated = await f.threads.create(USER, 'Unapproved source', (await f.threads.get(f.childId)).projectPath);
      await assert.rejects(
        f.handoffs.prepare({
          taskId: f.task.id,
          expectedOwnerRevision: 0,
          actor: { userId: USER, catId: OWNER, threadId: unrelated.id, invocationId: 'unapproved' },
          targetCatId: TARGET,
          targetThreadId: f.childId,
        }),
        /task_thread_authority_mismatch/,
      );
      assert.equal((await f.tasks.get(f.task.id)).lastAppliedHandoffMessageRef, undefined);
    });

    for (const drift of ['child project', 'proposal project', 'receipt', 'source withdrawal']) {
      test(`${drift} invalidates replay and provider admission`, async (t) => {
        const f = await crossProjectFixture(t);
        assert.equal((await f.continueTask()).statusCode, 200);
        const sent = await f.implement();
        assert.equal(sent.statusCode, 200, sent.body);
        const sourceId = sent.json().messageId;
        if (drift === 'child project') await f.redis.hset(`thread:${f.childId}`, 'projectPath', f.source.projectPath);
        if (drift === 'proposal project')
          await f.redis.hset(`proposal:${f.proposalId}`, 'projectPath', f.source.projectPath);
        if (drift === 'receipt') await f.redis.hset(`proposal:${f.proposalId}`, 'taskContractContinuation', '{}');
        if (drift === 'source withdrawal') await f.messages.softDelete(sourceId, USER);
        assert.equal((await f.handoffs.apply(sourceId)).kind, 'refused');
        await assert.rejects(
          f.handoffs.start(
            sourceId,
            { userId: USER, catId: TARGET, threadId: f.childId, invocationId: 'revoked-writer' },
            'parent',
          ),
        );
        assert.equal((await f.tasks.get(f.task.id)).executionRef, undefined);
      });
    }

    test('project drift at the native Task WATCH boundary prevents first admission', async (t) => {
      const f = await crossProjectFixture(t);
      assert.equal((await f.continueTask()).statusCode, 200);
      const assertRaced = changeAtTaskCommit(f, () =>
        f.redis.hset(`thread:${f.childId}`, 'projectPath', f.source.projectPath),
      );
      const denied = await f.implement();
      assertRaced();
      assert.equal(denied.statusCode, 409, denied.body);
      assert.equal((await f.tasks.get(f.task.id)).lastAppliedHandoffMessageRef, undefined);
    });

    test('source child approval is watched when returning home without a target anchor', async (t) => {
      const f = await crossProjectFixture(t);
      assert.equal((await f.continueTask()).statusCode, 200);
      const sent = await f.implement();
      assert.equal(sent.statusCode, 200, sent.body);
      const returned = await appendHandoff(f, {
        actor: { userId: USER, catId: TARGET, threadId: f.childId, invocationId: 'returning-child' },
        targetCatId: OWNER,
        targetThreadId: f.source.id,
      });
      assert.equal(returned.extra.taskHandoff.approvedAnchor, undefined);
      const assertRaced = changeAtTaskCommit(f, () =>
        f.redis.hset(`proposal:${f.proposalId}`, 'taskContractContinuation', '{}'),
      );
      assert.equal((await f.handoffs.apply(returned.id)).kind, 'refused');
      assertRaced();
      assert.equal((await f.tasks.get(f.task.id)).lastAppliedHandoffMessageRef, `message:${sent.json().messageId}`);
      assert.equal((await f.tasks.get(f.task.id)).executionRef, undefined);
    });
  },
);
