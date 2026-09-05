/**
 * F167 Phase R — callback ingress boundaries adjacent to coordination lifecycle.
 *
 * Split from cross-thread-coordination-chain.test.js to keep both files below
 * the repository's 350-line hard limit.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';

function createMockSocketManager() {
  return {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
  };
}

function createMockInvocationRecordStore() {
  const records = [];
  return {
    create(input) {
      const id = `inv-${records.length}`;
      records.push({ id, ...input });
      return { outcome: 'created', invocationId: id };
    },
    update() {},
    get() {
      return null;
    },
    getRecords() {
      return records;
    },
  };
}

function createMockRouter() {
  return {
    async *routeExecution() {
      yield* [];
    },
    getExecutions() {
      return [];
    },
  };
}

describe('F167 Phase R: callback ingress boundaries', () => {
  let registry;
  let messageStore;
  let threadStore;
  let invocationRecordStore;
  let dispatchProposalStore;
  let app;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { InMemoryDispatchProposalStore } = await import(
      '../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    );
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    invocationRecordStore = createMockInvocationRecordStore();
    dispatchProposalStore = new InMemoryDispatchProposalStore();
    app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      socketManager: createMockSocketManager(),
      router: createMockRouter(),
      invocationRecordStore,
      dispatchProposalStore,
    });
  });

  async function post({ auth, threadId, content, targetCat, effectClass, coordination, clientMessageId }) {
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
      },
      payload: {
        threadId,
        content,
        targetCats: [targetCat],
        clientMessageId,
        ...(effectClass ? { effectClass } : {}),
        ...(coordination ? { coordination } : {}),
      },
    });
  }

  function findMessage(threadId, content) {
    return messageStore.getByThread(threadId, 20, 'user-1').find((message) => message.content === content);
  }

  test('server-minted coordination roots keep content retry suppression without clientMessageId', async () => {
    const source = await threadStore.create('user-1', 'Source');
    const target = await threadStore.create('user-1', 'Target');
    await threadStore.addParticipants(target.id, ['codex']);
    const auth = await registry.create('user-1', 'opus', source.id);

    for (const phase of ['active', 'terminal']) {
      const content = `Minted ${phase} root`;
      const recordsBefore = invocationRecordStore.getRecords().length;

      const first = await post({
        auth,
        threadId: target.id,
        content,
        targetCat: 'codex',
        coordination: { phase },
      });
      assert.equal(first.statusCode, 200);
      assert.equal(first.json().status, 'ok');

      const retry = await post({
        auth,
        threadId: target.id,
        content,
        targetCat: 'codex',
        coordination: { phase },
      });
      assert.equal(retry.statusCode, 200);
      assert.equal(retry.json().status, 'duplicate');
      assert.equal(
        messageStore.getByThread(target.id, 20, 'user-1').filter((message) => message.content === content).length,
        1,
      );
      assert.equal(invocationRecordStore.getRecords().length, recordsBefore + 1);
    }
  });

  test('caller-chosen coordination ids remain distinct content-dedup identities', async () => {
    const source = await threadStore.create('user-1', 'Source');
    const target = await threadStore.create('user-1', 'Target');
    await threadStore.addParticipants(target.id, ['codex']);
    const auth = await registry.create('user-1', 'opus', source.id);

    for (const id of ['caller-chain-a', 'caller-chain-b']) {
      const response = await post({
        auth,
        threadId: target.id,
        content: 'Deliberately repeated content',
        targetCat: 'codex',
        coordination: { phase: 'active', id },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().status, 'ok');
    }

    const messages = messageStore
      .getByThread(target.id, 20, 'user-1')
      .filter((message) => message.content === 'Deliberately repeated content');
    assert.equal(messages.length, 2);
    assert.deepEqual(
      messages.map((message) => message.extra.coordination.id),
      ['caller-chain-a', 'caller-chain-b'],
    );
  });

  test('coordination with assign_work fails closed before creating a dispatch proposal', async () => {
    const source = await threadStore.create('user-1', 'Source');
    const target = await threadStore.create('user-1', 'Target');
    const auth = await registry.create('user-1', 'opus', source.id);

    const response = await post({
      auth,
      threadId: target.id,
      content: 'Assign coordinated work',
      targetCat: 'codex',
      effectClass: 'assign_work',
      coordination: { phase: 'active' },
      clientMessageId: 'coordination-assign-work',
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().kind, 'coordination_with_assign_work');
    assert.deepEqual(await dispatchProposalStore.listPendingByUser('user-1'), []);
  });

  // --- Convention contract (F246 Phase J charter update) ---

  test('coordinate effectClass cross-thread → delivered normally, no DispatchProposal created', async () => {
    // Convention: routine review/feedback uses coordinate, which bypasses the
    // assign_work intercept at callbacks.ts:1605 and delivers via normal flow.
    // This test proves the real HTTP ingress boundary: coordinate never creates
    // a DispatchProposal (no approval card in Approval Hub).
    const source = await threadStore.create('user-1', 'Source');
    const target = await threadStore.create('user-1', 'Target');
    await threadStore.addParticipants(target.id, ['codex']);
    const auth = await registry.create('user-1', 'opus', source.id);

    const response = await post({
      auth,
      threadId: target.id,
      content: '@codex\nPlease review PR #3203',
      targetCat: 'codex',
      effectClass: 'coordinate',
      clientMessageId: 'coordinate-review-request',
    });

    assert.equal(response.statusCode, 200, 'coordinate cross-thread must succeed (not intercepted)');
    assert.ok(findMessage(target.id, '@codex\nPlease review PR #3203'), 'coordinate message must be delivered');
    assert.deepEqual(await dispatchProposalStore.listPendingByUser('user-1'), []);
  });
});
