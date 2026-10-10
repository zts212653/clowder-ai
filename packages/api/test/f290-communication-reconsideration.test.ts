import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { invokeSingleCat } from '../src/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { fixture } from './f290-communication-reconsideration.fixture.js';
import { CAT, until } from './f290-communication-validation.host.js';

test('manual once reconsiders the exact proposal through durable UNKNOWN public custody and actual Cat acceptance', async () => {
  const f = await fixture();
  try {
    const proposal = await f.propose();
    const grantRevision = await f.approve('manual', true);
    const first = await f.post(grantRevision);
    assert.equal(first.statusCode, 200, first.body);
    const replay = await f.post(grantRevision);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(first.json().messageId, replay.json().messageId);
    const wake = await f.host.messages.getById(first.json().messageId);
    assert.ok(wake);
    assert.equal(wake.queueCustody, undefined);
    const [pending] = f.queue.list(wake.threadId, f.host.userId);
    assert.equal(pending.execution.ownerAuthProvenance, 'unknown');
    assert.equal(pending.execution.executionScope, 'collective-participation');
    assert.equal(pending.payload.messageId, wake.id);
    assert.equal((await f.host.tasks.listByKind('work')).length, 0);
    assert.equal(f.queue.list(f.host.endpoint.id, f.host.userId).length, 1);
    f.enable();
    await f.processor.processNext(f.host.endpoint.id, f.host.userId);
    await until(() => f.runs.length === 1, `scripted model classified actual Work: ${f.logs}`);
    assert.equal(f.runs[0], proposal.workId);
    assert.equal(f.work(proposal.workId).lifecycle, 'committed');
    await until(async () => {
      const current = await f.host.messages.getById(wake.id);
      return current?.lifecycle?.kind === 'input' && current.lifecycle.dispatchRefs?.[0]?.phase === 'settled';
    }, 'public wake settled');
    const done = await f.post(grantRevision);
    assert.equal(done.json().disposition, 'already_classified');
    assert.equal(f.queue.list(f.host.endpoint.id, f.host.userId).length, 0);
    assert.equal(f.runs.length, 1);
    await f.host.tick();
    assert.equal((await f.host.tasks.listByKind('work')).length, 1, 'only actual accepted Work creates the Host Task');
  } finally {
    await f.close();
  }
});

test('lost response and restart recover the same durable wake; current revocation refuses its old grant before another birth', async () => {
  const f = await fixture();
  try {
    await f.propose();
    const grantRevision = await f.approve('manual', true);
    const first = await f.post(grantRevision);
    assert.equal(first.statusCode, 200, first.body);
    const wake = await f.host.messages.getById(first.json().messageId);
    assert.ok(wake);
    const [queued] = f.queue.list(wake.threadId, f.host.userId);
    assert.ok(queued);
    // Restart reads the same persisted ledger, not source-custody reconstruction.
    const restarted = new InvocationQueue(f.ledger);
    assert.equal(await restarted.hydrateFromLedger(f.host.messages), 1);
    assert.equal(restarted.list(wake.threadId, f.host.userId)[0]?.id, queued.id);
    assert.equal(await f.queue.hydrateFromLedger(f.host.messages), 1);
    await f.world.restartConnector(f.world.operator);
    await f.world.restartService();
    const retry = await f.post(grantRevision);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().messageId, wake.id);
    assert.equal(f.queue.list(wake.threadId, f.host.userId).length, 1);
    await f.world.operator.connector.revokeWorkGrants(f.world.operator.connectionId, f.host.userId, ['grant-guides']);
    const revoked = await f.post(grantRevision);
    assert.equal(revoked.statusCode, 409, revoked.body);
    assert.equal((await f.host.tasks.listByKind('work')).length, 0);
    assert.equal(f.runs.length, 0);
    assert.equal(f.queue.list(wake.threadId, f.host.userId)[0]?.targets[0], CAT);
  } finally {
    await f.close();
  }
});

test('a Service Human revocation after decision discovery and before fenced permission consumption creates no wake', async () => {
  const f = await fixture();
  try {
    const revision = await f.approve('manual', true);
    const connector = f.world.operator.connector;
    const source = (await connector.listInbox(f.world.operator.connectionId)).find(
      (item) => item.event.eventId === f.request.eventId,
    )?.event;
    assert.ok(source);
    const before = (await f.host.messages.getByThread(f.host.endpoint.id)).length;
    const read = connector.readParticipationContext.bind(connector);
    let revoked = false;
    connector.readParticipationContext = async (...args) => {
      const context = await read(...args);
      if (!revoked) {
        revoked = true;
        await f.world.store.registerCollectiveWorkPolicy(f.world.operator.sessionToken, {
          ...f.world.coordinates,
          connectionId: f.world.operator.connectionId,
          expectedRevision: 1,
          requestId: 'remote-revoke-before-wake',
          decisionMode: 'manual',
          grants: [],
        });
      }
      return context;
    };
    const response = await f.post(revision);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal((await f.host.messages.getByThread(f.host.endpoint.id)).length, before);
    assert.equal(f.queue.list(f.host.endpoint.id, f.host.userId).length, 0);
    assert.equal((await f.host.tasks.listByKind('work')).length, 0);
  } finally {
    await f.close();
  }
});

test('a remote owner revocation during the Host source/thread read is refreshed before queue or Message birth', async () => {
  const f = await fixture();
  try {
    const revision = await f.approve('manual', true);
    const before = (await f.host.messages.getByThread(f.host.endpoint.id)).length;
    let revoked = false;
    f.reconsiderHooks.beforeThreadRead = async () => {
      if (!revoked) {
        revoked = true;
        await f.world.store.registerCollectiveWorkPolicy(f.world.operator.sessionToken, {
          ...f.world.coordinates,
          connectionId: f.world.operator.connectionId,
          expectedRevision: 1,
          requestId: 'remote-revoke-during-host-read',
          decisionMode: 'manual',
          grants: [],
        });
      }
    };
    const response = await f.post(revision);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal((await f.host.messages.getByThread(f.host.endpoint.id)).length, before);
    assert.equal(f.queue.list(f.host.endpoint.id, f.host.userId).length, 0);
    assert.equal((await f.host.tasks.listByKind('work')).length, 0);
  } finally {
    await f.close();
  }
});

test('an explicit future-class rule reconsiders a second guide while a different kind cannot acquire a wake', async () => {
  const f = await fixture();
  try {
    const revision = await f.approve('automatic');
    await f.propose();
    f.enable();
    assert.equal((await f.post(revision)).statusCode, 200);
    await until(() => f.runs.length === 1, 'first authorized guide classified');
    const request = await f.world.store.postHumanMessage(f.world.wulang.sessionToken, {
      ...f.world.coordinates,
      clientEventId: 'future-guide-request',
      location: { channelId: 'general' },
      target: { kind: 'agent', humanId: f.world.operator.humanId, agentId: CAT },
      recipient: {
        kind: 'agent',
        humanId: f.world.operator.humanId,
        connectionId: f.world.operator.connectionId,
        agentId: CAT,
        participationRevision: f.host.participationRevision,
      },
      body: 'Please prepare another newcomer guide.',
    });
    await f.host.tick();
    assert.equal(
      (await f.post(revision, request.eventId, 'legal')).statusCode,
      409,
      'guide override cannot authorize legal work',
    );
    const accepted = await f.post(revision, request.eventId);
    assert.equal(accepted.statusCode, 200, accepted.body);
    await until(() => f.runs.length === 2, 'second guide uses the same registered class permission');
    assert.notEqual(f.runs[0], f.runs[1]);
    const policy = await f.world.operator.connector.readWorkPolicy(f.world.operator.connectionId);
    assert.equal(policy?.decisionMode, 'manual');
    assert.equal(policy?.grants[0]?.decisionMode, 'automatic');
  } finally {
    await f.close();
  }
});

test('an old actual g1 wake and its public callbacks cannot borrow newly adopted g2 while the new purpose remains usable', async () => {
  const f = await fixture();
  try {
    const g1 = await f.approve('manual', true);
    const first = await f.post(g1);
    assert.equal(first.statusCode, 200, first.body);
    const wake = await f.host.messages.getById(first.json().messageId);
    assert.ok(wake);
    const input = { userId: f.host.userId, threadId: wake.threadId, catId: CAT, originTriggerMessageId: wake.id };
    assert.ok(await f.host.context.resolvePublic(input));
    const headers = await f.callbackAuth(wake.id);
    const before = await f.callbacks.inject({
      method: 'POST',
      url: '/api/callbacks/collective-current-context',
      headers,
      payload: {},
    });
    assert.equal(before.statusCode, 200, before.body);
    await f.world.operator.connector.revokeWorkGrants(f.world.operator.connectionId, f.host.userId, ['grant-guides']);
    const g2 = await f.approve('automatic');
    await assert.rejects(
      f.host.context.resolvePublic(input),
      (error) => error instanceof Error && 'code' in error && error.code === 'collective_reconsideration_refused',
    );
    const stale = await f.callbacks.inject({
      method: 'POST',
      url: '/api/callbacks/collective-current-context',
      headers,
      payload: {},
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().code, 'collective_reconsideration_refused');
    let calls = 0;
    await assert.rejects(
      async () => {
        for await (const _ of invokeSingleCat(
          { messageStore: f.host.messages, collectiveContext: () => f.host.context } as never,
          {
            userId: f.host.userId,
            threadId: wake.threadId,
            catId: CAT,
            a2aTriggerMessageId: wake.id,
            executionScope: 'collective-participation',
            service: {
              async *invoke() {
                calls++;
                yield { type: 'done', catId: CAT, content: '', timestamp: Date.now() };
              },
            },
          } as never,
        )) {
        }
      },
      (error) => error instanceof Error && 'code' in error && error.code === 'collective_reconsideration_refused',
    );
    assert.equal(calls, 0, 'actual invocation guard refuses before provider start');
    const next = await f.post(g2);
    assert.equal(next.statusCode, 200, next.body);
    assert.notEqual(next.json().messageId, wake.id);
    assert.ok(await f.host.context.resolvePublic({ ...input, originTriggerMessageId: next.json().messageId }));
  } finally {
    await f.close();
  }
});

test('a transient Service policy read failure stays retryable and does not become a permanent wake refusal', async () => {
  const f = await fixture();
  try {
    const revision = await f.approve('manual', true);
    const response = await f.post(revision);
    const messageId = response.json().messageId;
    f.world.injectFault({ path: '/api/participation/work-policy/read', when: 'before' });
    const input = {
      userId: f.host.userId,
      threadId: f.host.endpoint.id,
      catId: CAT,
      originTriggerMessageId: messageId,
    };
    await assert.rejects(
      f.host.context.resolvePublic(input),
      (error) => error instanceof Error && (!('code' in error) || error.code !== 'collective_reconsideration_refused'),
    );
    assert.ok(await f.host.context.resolvePublic(input));
  } finally {
    await f.close();
  }
});
