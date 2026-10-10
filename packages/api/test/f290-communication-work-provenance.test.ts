import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { authRecordFromRedisHash } from '../src/domains/cats/services/agents/invocation/RedisAuthInvocationRecord.js';
import { BacklogStore } from '../src/domains/cats/services/stores/ports/BacklogStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { projectCollectiveWorkDelegation } from '../src/domains/plugin/builtin-runtime/collective-work-delegation.js';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.js';
import { registerCallbackWorkflowSopRoutes } from '../src/routes/callback-workflow-sop-routes.js';

const catId = createCatId('codex61-sol');
const carrier = { v: 1 as const, taskId: 'matter-A', observedRevision: 3, resultRevision: 2, executionRevision: 1 };
const binding = { ...carrier, sourceRef: 'message:original-A', authorityRef: 'message:admission-A' };

test('delegated Collective execution has a Work binding without claiming a strictly authenticated owner invocation', async () => {
  const registry = new InvocationRegistry();
  const created = await registry.create(
    'owner',
    catId,
    'private-A',
    undefined,
    undefined,
    undefined,
    'trigger-A',
    'unknown',
    undefined,
    undefined,
    binding,
  );
  const verified = await registry.verify(created.invocationId, created.callbackToken);
  assert.ok(verified.ok);
  assert.equal(verified.record.ownerAuthProvenance, 'unknown');
  assert.deepEqual(verified.record.collectiveWorkBinding, binding);
  await assert.rejects(
    registry.create(
      'owner',
      catId,
      'private-A',
      undefined,
      undefined,
      undefined,
      'trigger-A',
      'strict',
      undefined,
      undefined,
      binding,
    ),
    /owner|provenance|Collective/i,
  );
});

test('restart downgrades legacy private Work authentication while retaining exact admission evidence', () => {
  const fields = {
    invocationId: 'inv-A',
    callbackToken: 'token-A',
    userId: 'owner',
    catId,
    threadId: 'private-A',
    ownerAuthProvenance: 'strict',
    originTriggerMessageId: 'trigger-A',
    collectiveWorkBinding: JSON.stringify(binding),
  };
  const restored = authRecordFromRedisHash(fields, new Set());
  assert.ok(restored);
  assert.equal(restored.ownerAuthProvenance, 'unknown');
  assert.deepEqual(restored.collectiveWorkBinding, binding);
  assert.equal(authRecordFromRedisHash({ ...fields, originTriggerMessageId: '' }, new Set()), null);
});

test('a private Work queue producer cannot promote external origin to strict owner provenance', async () => {
  const queue = new InvocationQueue();
  const input = {
    kind: 'conversation_input' as const,
    sourceId: 'private-work-input',
    from: { kind: 'external' as const, connectorId: 'collective-work' },
    userId: 'owner',
    threadId: 'private-A',
    content: 'Execute admitted A',
    targetCats: [catId],
    intent: 'execute' as const,
    executionScope: 'collective-work' as const,
    ownerAuthProvenance: 'unknown' as const,
  };
  assert.ok((await queue.enqueueDurable(input)).entry);
  await assert.rejects(queue.enqueueDurable({ ...input, ownerAuthProvenance: 'strict' }), /scope|provenance/i);
});

test('a named home relay consumes the exact Work binding without owner control-plane authority', () => {
  const record = {
    userId: 'owner',
    threadId: 'private-A',
    catId,
    ownerAuthProvenance: 'unknown' as const,
    collectiveWorkBinding: binding,
  };
  const originMessage = new MessageStore().append({
    userId: 'owner',
    threadId: 'private-A',
    from: { kind: 'system' as const, service: 'collective-work' },
    content: 'Run A',
    mentions: [],
    timestamp: 1,
    extra: { collectiveWorkInvocationV1: carrier },
  });
  const input = {
    record,
    originMessage,
    targetThreadId: 'private-A',
    targetCatIds: [createCatId('codex-astra')],
    crossThread: false,
  };
  assert.deepEqual(projectCollectiveWorkDelegation(input), {
    ...carrier,
    ownerCatId: catId,
    targetCatIds: input.targetCatIds,
  });
  assert.equal(
    projectCollectiveWorkDelegation({ ...input, record: { ...record, collectiveWorkBinding: undefined } }),
    undefined,
  );
  assert.equal(projectCollectiveWorkDelegation({ ...input, crossThread: true }), undefined);
});

test('a bound private Work cannot consume an external instruction to change owner workflow authority', async () => {
  const registry = new InvocationRegistry();
  const work = await registry.create(
    'owner',
    catId,
    'private-A',
    undefined,
    undefined,
    undefined,
    'trigger-A',
    'unknown',
    undefined,
    undefined,
    binding,
  );
  const owner = await registry.create(
    'owner',
    catId,
    'owner-control',
    undefined,
    undefined,
    undefined,
    undefined,
    'strict',
  );
  const app = Fastify();
  registerCallbackAuthHook(app, registry);
  let writes = 0;
  registerCallbackWorkflowSopRoutes(app, {
    backlogStore: new BacklogStore(),
    workflowSopStore: {
      async get() {
        return null;
      },
      async getManagedWorkAdmission() {
        return null;
      },
      async bindManagedWorkAttempt() {
        return null;
      },
      async delete() {
        writes++;
        return false;
      },
      async upsert() {
        writes++;
        throw new Error('External Work reached owner workflow mutation');
      },
    },
  });
  try {
    const result = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-workflow-sop',
      headers: { 'x-invocation-id': work.invocationId, 'x-callback-token': work.callbackToken },
      payload: { featureId: 'F290', backlogItemId: 'unrelated-owner-program', stage: 'impl' },
    });
    assert.equal(result.statusCode, 403, result.body);
    assert.equal(result.json().code, 'strict_owner_auth_required');
    assert.equal(writes, 0);
    const control = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-workflow-sop',
      headers: { 'x-invocation-id': owner.invocationId, 'x-callback-token': owner.callbackToken },
      payload: {},
    });
    assert.equal(control.statusCode, 400, 'a real strict owner reaches the existing request validator');
  } finally {
    await app.close();
  }
});

test('canonical private Work Queue hydrate keeps immutable owner provenance without reconstructing Message custody', async () => {
  const ledger = new InMemoryQueueLedgerStore();
  const queue = new InvocationQueue(ledger);
  const messages = new MessageStore();
  const from = { kind: 'system' as const, service: 'collective-work' };
  const admitted = await queue.send(
    messages,
    {
      userId: 'owner',
      threadId: 'private-A',
      from,
      content: 'Execute admitted A',
      mentions: [catId],
      timestamp: 1,
      deliveryStatus: 'queued',
      extra: { collectiveWorkInvocationV1: carrier },
    },
    {
      kind: 'conversation_input',
      userId: 'owner',
      threadId: 'private-A',
      from,
      content: 'Execute admitted A',
      targetCats: [catId],
      intent: 'execute',
      executionScope: 'collective-work',
      ownerAuthProvenance: 'unknown',
    },
  );
  assert.ok(admitted.message && admitted.entry);
  const recovered = new InvocationQueue(ledger);
  assert.equal(await recovered.hydrateFromLedger(messages), 1);
  const entry = recovered.getEntrySnapshot('private-A', 'owner', admitted.entry.id);
  assert.equal(entry?.execution.ownerAuthProvenance, 'unknown');
  assert.equal(entry?.execution.executionScope, 'collective-work');
  assert.equal(entry?.payload.messageId, admitted.message.id);
  assert.equal(messages.getById(admitted.message.id)?.queueCustody, undefined);
  const durable = await ledger.get('private-A', admitted.entry.id);
  assert.ok(durable);
  assert.deepEqual(durable, await queue.getDurableEntry('private-A', admitted.entry.id));
});
