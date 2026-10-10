/**
 * F167 Phase R — cross-thread coordination identity + terminal ACK guard.
 *
 * Regression lineage: Claim -> active reply -> terminal Release. Cross-thread
 * posts remain fail-closed without routing credentials; either text or
 * structured targets after terminal start genuinely new active work.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';

function createMockSocketManager() {
  return {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
    emitToUser() {},
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

describe('F167 Phase R: cross-thread coordination chain', () => {
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
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    invocationRecordStore = createMockInvocationRecordStore();
    dispatchProposalStore = new InMemoryDispatchProposalStore();
    const invocationQueue = new InvocationQueue();
    app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      socketManager: createMockSocketManager(),
      router: createMockRouter(),
      invocationRecordStore,
      dispatchProposalStore,
      invocationQueue,
      queueProcessor: { requestDrain() {} },
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
        ...(targetCat ? { targetCats: [targetCat] } : {}),
        clientMessageId,
        ...(effectClass ? { effectClass } : {}),
        ...(coordination ? { coordination } : {}),
      },
    });
  }

  function findMessage(threadId, content) {
    return messageStore.getByThread(threadId, 20, 'user-1').find((message) => message.content === content);
  }

  test('Claim -> Release closes while every explicit routing form starts fresh active work', async () => {
    const source = await threadStore.create('user-1', 'Source');
    const target = await threadStore.create('user-1', 'Target');
    await threadStore.addParticipants(source.id, ['opus']);
    await threadStore.addParticipants(target.id, ['codex']);

    const sourceClaimAuth = await registry.create('user-1', 'opus', source.id);
    const claimResponse = await post({
      auth: sourceClaimAuth,
      threadId: target.id,
      content: 'Claim shared callback files',
      targetCat: 'codex',
      coordination: { phase: 'active', subjectRef: 'subject:review-cycle' },
      clientMessageId: 'claim',
    });
    assert.equal(claimResponse.statusCode, 200);
    const claim = findMessage(target.id, 'Claim shared callback files');
    assert.ok(claim);
    assert.equal(claim.extra.crossPost.sourceThreadId, source.id);
    assert.equal(claim.extra.crossPost.coordination, undefined, 'crossPost must remain provenance-only');
    assert.equal(claim.extra.coordination.phase, 'active');
    assert.equal(claim.extra.coordination.hop, 0);
    const coordinationId = claim.extra.coordination.id;
    assert.match(coordinationId, /^coord-/);

    const targetActiveAuth = await registry.create('user-1', 'codex', target.id, undefined, claim.id);
    const activeResponse = await post({
      auth: targetActiveAuth,
      threadId: source.id,
      content: 'Working reply',
      targetCat: 'opus',
      clientMessageId: 'active-reply',
    });
    assert.equal(activeResponse.statusCode, 200);
    const activeReply = findMessage(source.id, 'Working reply');
    assert.equal(activeReply.extra.coordination.id, coordinationId);
    assert.equal(activeReply.extra.coordination.phase, 'active');
    assert.equal(activeReply.extra.coordination.hop, 1);

    const sourceReleaseAuth = await registry.create('user-1', 'opus', source.id, undefined, activeReply.id);
    const releaseResponse = await post({
      auth: sourceReleaseAuth,
      threadId: target.id,
      content: 'Release shared callback files',
      targetCat: 'codex',
      coordination: { phase: 'terminal', subjectRef: 'subject:review-cycle' },
      clientMessageId: 'release',
    });
    assert.equal(releaseResponse.statusCode, 200);
    const release = findMessage(target.id, 'Release shared callback files');
    assert.equal(release.extra.coordination.id, coordinationId);
    assert.equal(release.extra.coordination.phase, 'terminal');
    assert.equal(release.extra.coordination.hop, 2);

    const targetAckAuth = await registry.create('user-1', 'codex', target.id, undefined, release.id);
    const messagesBeforeUnroutedPost = messageStore.getByThread(source.id, 20, 'user-1').length;
    const unroutedResponse = await post({
      auth: targetAckAuth,
      threadId: source.id,
      content: 'Release received',
      clientMessageId: 'ack',
    });
    assert.equal(unroutedResponse.statusCode, 400);
    assert.equal(unroutedResponse.json().kind, 'cross_post_no_routing');
    assert.equal(
      messageStore.getByThread(source.id, 20, 'user-1').length,
      messagesBeforeUnroutedPost,
      'an unrouted cross-thread courtesy message must fail before persistence',
    );

    const structuredTargetResponse = await post({
      auth: targetAckAuth,
      threadId: source.id,
      content: 'New structured work discovered after release',
      targetCat: 'opus',
      clientMessageId: 'new-structured-work-after-release',
    });
    assert.equal(structuredTargetResponse.statusCode, 200);
    assert.equal(structuredTargetResponse.json().status, 'ok');
    assert.deepEqual(
      structuredTargetResponse.json().routed,
      ['opus'],
      'structured targetCats after terminal must enqueue a new active hop',
    );
    const structuredTarget = findMessage(source.id, 'New structured work discovered after release');
    assert.deepEqual(structuredTarget.mentions, ['opus']);
    assert.equal(structuredTarget.extra.coordination.phase, 'active');
    assert.notEqual(structuredTarget.extra.coordination.id, coordinationId);

    const explicitMentionResponse = await post({
      auth: targetAckAuth,
      threadId: source.id,
      content: '@opus\nNew work discovered after release',
      targetCat: 'opus',
      coordination: { phase: 'terminal', id: coordinationId },
      clientMessageId: 'new-work-after-release',
    });
    assert.equal(explicitMentionResponse.statusCode, 200);
    assert.equal(explicitMentionResponse.json().status, 'ok');
    assert.deepEqual(
      explicitMentionResponse.json().routed,
      ['opus'],
      'an explicit line-start mention after terminal must enqueue a new active hop',
    );
    const explicitMention = findMessage(source.id, '@opus\nNew work discovered after release');
    assert.deepEqual(explicitMention.mentions, ['opus']);
    assert.equal(explicitMention.extra.coordination.phase, 'active');
    assert.notEqual(explicitMention.extra.coordination.id, coordinationId);

    const recordsBeforeRestart = invocationRecordStore.getRecords().length;
    const restartResponse = await post({
      auth: targetAckAuth,
      threadId: source.id,
      content: 'New substantive coordination',
      targetCat: 'opus',
      coordination: { phase: 'active', id: coordinationId, subjectRef: 'subject:new-work' },
      clientMessageId: 'restart',
    });
    assert.equal(restartResponse.statusCode, 200);
    assert.equal(restartResponse.json().status, 'ok');
    assert.equal(
      invocationRecordStore.getRecords().length,
      recordsBeforeRestart,
      'callback admission must not mint an InvocationRecord before QueueProcessor reserves the carrier',
    );
    const restart = findMessage(source.id, 'New substantive coordination');
    assert.notEqual(restart.extra.coordination.id, coordinationId);
    assert.equal(restart.extra.coordination.phase, 'active');
    assert.equal(restart.extra.coordination.hop, 0);
    assert.equal(restart.extra.coordination.subjectRef, 'subject:new-work');
  });

  test('same-thread terminal review delivery closes cleanly and suppresses a courtesy ACK', async () => {
    const thread = await threadStore.create('user-1', 'Same-thread review');
    await threadStore.addParticipants(thread.id, ['opus', 'codex']);

    const requestAuth = await registry.create('user-1', 'opus', thread.id);
    const requestResponse = await post({
      auth: requestAuth,
      threadId: thread.id,
      content: 'Review exact HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      targetCat: 'codex',
      coordination: { phase: 'active' },
      clientMessageId: 'same-thread-review-request',
    });
    assert.equal(requestResponse.statusCode, 200);
    const requestMessage = findMessage(thread.id, 'Review exact HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(requestMessage.extra.crossPost, undefined, 'same-thread coordination is not cross-thread provenance');
    assert.equal(requestMessage.extra.coordination.phase, 'active');
    const coordinationId = requestMessage.extra.coordination.id;

    const verdictAuth = await registry.create('user-1', 'codex', thread.id, undefined, requestMessage.id);
    const verdictResponse = await post({
      auth: verdictAuth,
      threadId: thread.id,
      content: 'APPROVE exact HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; no open items.',
      targetCat: 'opus',
      coordination: { phase: 'terminal' },
      clientMessageId: 'same-thread-review-verdict',
    });
    assert.equal(verdictResponse.statusCode, 200);
    const verdict = findMessage(
      thread.id,
      'APPROVE exact HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; no open items.',
    );
    assert.equal(verdict.extra.crossPost, undefined);
    assert.equal(verdict.extra.coordination.id, coordinationId);
    assert.equal(verdict.extra.coordination.phase, 'terminal');

    const ackAuth = await registry.create('user-1', 'opus', thread.id, undefined, verdict.id);
    const recordsBeforeAck = invocationRecordStore.getRecords().length;
    const ackResponse = await post({
      auth: ackAuth,
      threadId: thread.id,
      content: '收到，无 open items。',
      clientMessageId: 'same-thread-review-ack',
    });
    assert.equal(ackResponse.statusCode, 200);
    assert.equal(ackResponse.json().status, 'terminal_ack_recorded');
    assert.equal(
      invocationRecordStore.getRecords().length,
      recordsBeforeAck,
      'terminal ACK must not wake the reviewer',
    );
    const ack = findMessage(thread.id, '收到，无 open items。');
    assert.deepEqual(ack.mentions, []);
    assert.equal(ack.extra.crossPost, undefined);
    assert.equal(ack.extra.coordination.phase, 'ack');
  });
});
