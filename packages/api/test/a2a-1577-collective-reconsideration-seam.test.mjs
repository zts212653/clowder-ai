import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.ts';
import { MessageStore, settleLifecycleResponseInputs } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { CollectiveCurrentContext } from '../src/domains/plugin/builtin-runtime/collective-current-context.ts';
import { requireCurrentReconsiderationSource } from '../src/domains/plugin/builtin-runtime/collective-work/collective-reconsideration-source.ts';
import { registerCollectiveOwnerWorkReconsiderationRoutes } from '../src/routes/collective-owner-work-reconsideration.ts';
import './helpers/setup-cat-registry.js';
import { appendTestLifecycleResponseSource } from './helpers/message-from-fixtures.js';

async function fixture(t) {
  const owner = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
  const threadId = 'collective-reconsider-seam';
  const messages = new MessageStore();
  const ledger = new InMemoryQueueLedgerStore();
  let wakes = 0;
  const admission = {
    onAdmitted: () => {
      wakes++;
    },
  };
  let queue = new InvocationQueue(ledger, admission);
  let revoked = false;
  const identity = {
    serviceInstanceId: 'svc_fixture000',
    collectiveId: 'col_fixture000',
    connectionId: 'con_fixture000',
    eventId: 'evt_fixture000',
    catId: 'opus',
    location: { channelId: 'general' },
    participationRevision: 1,
    actor: { kind: 'human', humanId: 'human_fixture000', displayName: 'Fixture Owner' },
  };
  const source = messages.append({
    userId: owner,
    threadId,
    from: { kind: 'external', connectorId: 'collective' },
    content: 'Classify this request',
    mentions: ['opus'],
    timestamp: 1,
    source: { connector: 'collective', label: 'Collective', meta: { participation: identity } },
  });
  const scope = {
    source: identity,
    threadId,
    sourceMessageId: source.id,
    purposeKey: `collective-reconsider:${'a'.repeat(64)}`,
    grantRef: 'grant-guides',
    grantRevision: 1,
    requestKind: 'guide',
    event: { body: source.content, actor: identity.actor, eventId: identity.eventId, sequence: 1 },
    assertCurrentPermission: async () => {
      if (revoked) throw Object.assign(new Error('Permission revoked'), { code: 'WORK_DELEGATION_UNAVAILABLE' });
    },
  };
  const runtime = {
    get queue() {
      return queue;
    },
  };
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    req.sessionUserId = owner;
  });
  registerCollectiveOwnerWorkReconsiderationRoutes(app, {
    messages,
    threads: { get: () => ({ createdBy: owner, participants: ['opus'] }) },
    cats: () => [{ id: 'opus', supported: true }],
    connector: () => ({
      withWorkReconsiderationAuthority: async (_connection, _owner, _input, consume) => consume(scope),
    }),
    reconsideration: runtime,
  });
  t.after(() => app.close());
  const post = () =>
    app.inject({
      method: 'POST',
      url: '/api/plugins/collective-connector/con_fixture000/work/reconsider',
      remoteAddress: '127.0.0.1',
      headers: { host: 'localhost', origin: 'http://localhost' },
      payload: {
        sourceEventId: identity.eventId,
        catId: 'opus',
        grantRef: scope.grantRef,
        grantRevision: 1,
        requestKind: 'guide',
      },
    });
  return {
    post,
    messages,
    ledger,
    scope,
    connector: { withWorkReconsiderationAuthority: async (_connection, _owner, _input, consume) => consume(scope) },
    owner,
    threadId,
    get queue() {
      return queue;
    },
    get wakes() {
      return wakes;
    },
    revoke: () => {
      revoked = true;
    },
    restart: async () => {
      queue = new InvocationQueue(ledger, admission);
      await queue.hydrateFromLedger(messages);
    },
  };
}

test('owner reconsideration atomically publishes one restricted canonical Queue row, not Message custody', async (t) => {
  const f = await fixture(t);
  const r = await f.post();
  assert.equal(r.statusCode, 200, r.body);
  const entries = await f.ledger.list(f.threadId);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].targets, ['opus']);
  assert.equal(entries[0].execution.executionScope, 'collective-participation');
  assert.equal(entries[0].execution.ownerAuthProvenance, 'unknown');
  assert.equal(entries[0].payload.messageId, r.json().messageId);
  assert.equal(f.messages.getById(r.json().messageId).queueCustody, undefined);
  assert.equal(f.wakes, 1);
});

test('reconsideration permission and atomic History failure cannot leave queue-only work', async (t) => {
  const f = await fixture(t);
  f.revoke();
  assert.notEqual((await f.post()).statusCode, 200);
  assert.deepEqual(await f.ledger.list(f.threadId), []);
  assert.equal(f.wakes, 0);
  const g = await fixture(t);
  g.messages.appendWithQueueLedgerAdmission = () => {
    throw new Error('History storage unavailable');
  };
  assert.notEqual((await g.post()).statusCode, 200);
  assert.deepEqual(await g.ledger.list(g.threadId), []);
  assert.equal(g.wakes, 0);
});

test('restarted reconsideration reuses the canonical row without reconstructing Message custody', async (t) => {
  const f = await fixture(t);
  const first = await f.post();
  assert.equal(first.statusCode, 200, first.body);
  await f.restart();
  const replay = await f.post();
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().messageId, first.json().messageId);
  assert.equal(replay.json().disposition, 'already_queued');
  assert.equal((await f.ledger.list(f.threadId)).length, 1);
});

test('a withdrawn reconsideration cannot be resurrected from its visible History', async (t) => {
  const f = await fixture(t);
  const first = await f.post();
  assert.equal(first.statusCode, 200, first.body);
  f.messages.markCanceled(first.json().messageId);
  const before = f.wakes;
  const replay = await f.post();
  assert.notEqual(replay.statusCode, 200);
  assert.equal(f.wakes, before);
});

for (const state of ['processing', 'completed', 'failed', 'completed-unread']) {
  const status = state === 'completed-unread' ? 'completed' : state;
  test(`actual dispatched ${state} child is not reconstructed as new reconsideration work`, async (t) => {
    const f = await fixture(t);
    const first = await f.post();
    assert.equal(first.statusCode, 200, first.body);
    const entry = (await f.ledger.list(f.threadId))[0];
    const child = appendTestLifecycleResponseSource(f.messages, {
      userId: f.owner,
      threadId: f.threadId,
      catId: 'opus',
      invocationId: 'isolated-child',
      timestamp: Date.now(),
    });
    const receipt = f.messages.commitLifecycleAppendAdmission({
      threadId: f.threadId,
      entryId: entry.id,
      inputMessageIds: [first.json().messageId],
      runs: [
        {
          targetId: 'opus',
          invocationId: 'isolated-child',
          responseMessageId: child.id,
          dispatchedAt: Date.now(),
          ...(state === 'completed-unread' ? { inputReadSupported: true } : {}),
        },
      ],
    });
    assert.equal(receipt.kind, 'applied');
    assert.equal((await f.queue.retireClaimedLifecycleTarget(f.threadId, entry.id, 'opus')).outcome, 'retired');
    if (status !== 'processing') {
      const terminal = f.messages.commitLifecycleResponseTerminal(child.id, {
        invocationId: 'isolated-child',
        status,
        completedAt: Date.now(),
        content: 'Classification result',
        mentions: [],
      });
      assert.equal(terminal.kind, 'applied');
      await settleLifecycleResponseInputs(f.messages, terminal.message, child.id);
    }
    await f.restart();
    const replay = await f.post();
    if (state === 'completed-unread') {
      // Native read is presentation evidence, not another execution or recovery gate.
      assert.equal(f.messages.getById(first.json().messageId).lifecycle.dispatchRefs[0].inputRead.status, 'pending');
    }
    if (status === 'failed') assert.notEqual(replay.statusCode, 200);
    else {
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().disposition, status === 'completed' ? 'already_classified' : 'already_queued');
    }
    assert.deepEqual(await f.ledger.list(f.threadId), []);
  });
}

test('missing ledger without actual dispatch evidence fails closed, not History replay', async (t) => {
  const f = await fixture(t);
  const first = await f.post();
  assert.equal(first.statusCode, 200, first.body);
  const entry = (await f.ledger.list(f.threadId))[0];
  await f.queue.retireClaimedLifecycleTarget(f.threadId, entry.id, 'opus');
  await f.restart();
  assert.notEqual((await f.post()).statusCode, 200);
  assert.deepEqual(await f.ledger.list(f.threadId), []);
});

test('actual producer guard validates current permission and immutable purpose without Message custody', async (t) => {
  const f = await fixture(t);
  const first = await f.post();
  assert.equal(first.statusCode, 200, first.body);
  const input = {
    connector: f.connector,
    messages: f.messages,
    message: f.messages.getById(first.json().messageId),
    source: f.scope.source,
    ownerUserId: f.owner,
  };
  assert.deepEqual(await requireCurrentReconsiderationSource(input), {
    grantRef: f.scope.grantRef,
    grantRevision: 1,
    requestKind: 'guide',
  });
  f.revoke();
  await assert.rejects(
    requireCurrentReconsiderationSource(input),
    (error) => error.reason === 'permission_not_current',
  );
});

test('a forged purpose, target or sender cannot borrow reconsideration authority', async (t) => {
  const f = await fixture(t);
  const first = await f.post();
  assert.equal(first.statusCode, 200, first.body);
  for (const corrupt of [
    (m) => {
      m.source.meta.reconsideration.purposeKey = `collective-reconsider:${'b'.repeat(64)}`;
    },
    (m) => {
      m.mentions = ['codex'];
    },
    (m) => {
      m.from = { kind: 'user', userId: f.owner };
    },
  ]) {
    const message = structuredClone(f.messages.getById(first.json().messageId));
    corrupt(message);
    await assert.rejects(
      requireCurrentReconsiderationSource({
        connector: f.connector,
        messages: f.messages,
        message,
        source: f.scope.source,
        ownerUserId: f.owner,
      }),
      /purpose index|producer schema/,
    );
  }
});

test('actual provider context keeps the exact producer grant after dispatch, rechecking current Host authority', async (t) => {
  const f = await fixture(t);
  const first = await f.post();
  assert.equal(first.statusCode, 200, first.body);
  const entry = (await f.ledger.list(f.threadId))[0];
  await f.queue.retireClaimedLifecycleTarget(f.threadId, entry.id, 'opus');
  const route = {
    localOwnerUserId: f.owner,
    revision: 1,
    agentRoutes: {
      'human_fixture000:opus': {
        catId: 'opus',
        threadId: f.threadId,
        participation: { displayName: 'Fixture Cat', channelIds: ['general'] },
      },
    },
  };
  let reads = 0;
  const connector = {
    ...f.connector,
    readParticipationContext: async () => {
      reads++;
      return { source: f.scope.event };
    },
    getHostRoute: async () => route,
    getProjection: async () => ({ authorizedHumanId: 'human_fixture000' }),
  };
  const context = new CollectiveCurrentContext({
    connector: () => connector,
    messageStore: f.messages,
    threadStore: { get: () => ({ createdBy: f.owner }) },
  });
  const input = {
    userId: f.owner,
    threadId: f.threadId,
    catId: 'opus',
    originTriggerMessageId: first.json().messageId,
  };
  const resolved = await context.resolvePublic(input);
  assert.equal(resolved.grant.originTriggerMessageId, input.originTriggerMessageId);
  assert.deepEqual(resolved.grant.source, f.scope.source);
  assert.deepEqual(resolved.ownerWakePurpose, {
    grantRef: f.scope.grantRef,
    grantRevision: f.scope.grantRevision,
    requestKind: f.scope.requestKind,
  });
  assert.deepEqual(await f.ledger.list(f.threadId), []);
  route.revision = 2;
  await assert.rejects(context.resolvePublic(input), (error) => error.code === 'PARTICIPATION_REVOKED');
  route.revision = 1;
  await assert.rejects(
    context.resolvePublic({ ...input, catId: 'codex' }),
    (error) => error.code === 'RETURN_UNAVAILABLE',
  );
  f.revoke();
  const before = reads;
  await assert.rejects(context.resolvePublic(input), (error) => error.reason === 'permission_not_current');
  assert.equal(reads, before, 'revoked producer authority is rejected before external context read');
});
