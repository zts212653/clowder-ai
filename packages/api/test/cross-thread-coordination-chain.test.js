/**
 * F167 Phase R — cross-thread coordination identity + terminal ACK guard.
 *
 * Regression lineage: Claim -> active reply -> terminal Release -> ACK.
 * The ACK is persisted for visibility but must not enqueue an ACK-of-ACK
 * invocation. A genuinely new active collaboration remains routable.
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

  test('Claim -> Release -> ACK closes without ACK-of-ACK spawn, while explicit new active work remains routable', async () => {
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
    const recordsBeforeAck = invocationRecordStore.getRecords().length;
    const ackResponse = await post({
      auth: targetAckAuth,
      threadId: source.id,
      content: '@opus\nRelease received',
      targetCat: 'opus',
      clientMessageId: 'ack',
    });
    assert.equal(ackResponse.statusCode, 200);
    const ackBody = ackResponse.json();
    assert.equal(ackBody.status, 'terminal_ack_recorded');
    assert.deepEqual(
      ackBody.routing_warnings.find((warning) => warning.kind === 'suppressed_by_terminal_ack'),
      { kind: 'suppressed_by_terminal_ack', droppedMentions: ['opus'] },
    );
    assert.equal(invocationRecordStore.getRecords().length, recordsBeforeAck, 'ACK must not enqueue ACK-of-ACK');
    const ack = findMessage(source.id, '@opus\nRelease received');
    assert.deepEqual(ack.mentions, []);
    assert.equal(ack.extra.coordination.id, coordinationId);
    assert.equal(ack.extra.coordination.phase, 'ack');
    assert.equal(ack.extra.coordination.hop, 3);

    const ackRetry = await post({
      auth: targetAckAuth,
      threadId: source.id,
      content: '@opus\nRelease received',
      targetCat: 'opus',
    });
    assert.equal(ackRetry.statusCode, 200);
    assert.equal(ackRetry.json().status, 'duplicate');
    assert.equal(
      messageStore
        .getByThread(source.id, 20, 'user-1')
        .filter((message) => message.content === '@opus\nRelease received').length,
      1,
      'terminal ACK retry must not append a second record when only an informational suppression warning exists',
    );

    const recordsBeforeMismatchedTerminalAck = invocationRecordStore.getRecords().length;
    const messagesBeforeMismatchedTerminalAck = messageStore.getByThread(source.id, 20, 'user-1').length;
    const mismatchedTerminalAckResponse = await post({
      auth: targetAckAuth,
      threadId: source.id,
      content: 'Release received with stale caller id',
      targetCat: 'opus',
      coordination: { phase: 'terminal', id: 'caller-supplied-other-chain' },
      clientMessageId: 'ack-mismatched-terminal-id',
    });
    assert.equal(mismatchedTerminalAckResponse.statusCode, 409);
    assert.deepEqual(mismatchedTerminalAckResponse.json(), {
      kind: 'coordination_id_conflict',
      message: 'Explicit terminal coordination id conflicts with the incoming coordination lineage.',
      incomingCoordinationId: coordinationId,
      explicitCoordinationId: 'caller-supplied-other-chain',
    });
    assert.equal(invocationRecordStore.getRecords().length, recordsBeforeMismatchedTerminalAck);
    assert.equal(
      messageStore.getByThread(source.id, 20, 'user-1').length,
      messagesBeforeMismatchedTerminalAck,
      'a rejected conflict must not persist a message',
    );
    assert.equal(findMessage(source.id, 'Release received with stale caller id'), undefined);

    const mismatchedTerminalAckRetry = await post({
      auth: targetAckAuth,
      threadId: source.id,
      content: 'Release received with stale caller id',
      targetCat: 'opus',
      coordination: { phase: 'terminal', id: 'caller-supplied-other-chain' },
      clientMessageId: 'ack-mismatched-terminal-id',
    });
    assert.equal(mismatchedTerminalAckRetry.statusCode, 409);
    assert.deepEqual(mismatchedTerminalAckRetry.json(), mismatchedTerminalAckResponse.json());
    assert.equal(invocationRecordStore.getRecords().length, recordsBeforeMismatchedTerminalAck);
    assert.equal(messageStore.getByThread(source.id, 20, 'user-1').length, messagesBeforeMismatchedTerminalAck);

    const mismatchedTerminalSubjectResponse = await post({
      auth: targetAckAuth,
      threadId: source.id,
      content: 'Release received with a foreign subject',
      targetCat: 'opus',
      coordination: { phase: 'terminal', id: coordinationId, subjectRef: 'subject:other-work' },
      clientMessageId: 'ack-mismatched-terminal-subject',
    });
    assert.equal(mismatchedTerminalSubjectResponse.statusCode, 409);
    assert.deepEqual(mismatchedTerminalSubjectResponse.json(), {
      kind: 'coordination_subject_conflict',
      message: 'Explicit terminal coordination subject conflicts with the incoming coordination lineage.',
      coordinationId,
      incomingSubjectRef: 'subject:review-cycle',
      explicitSubjectRef: 'subject:other-work',
    });
    assert.equal(invocationRecordStore.getRecords().length, recordsBeforeMismatchedTerminalAck);
    assert.equal(messageStore.getByThread(source.id, 20, 'user-1').length, messagesBeforeMismatchedTerminalAck);

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
    assert.equal(invocationRecordStore.getRecords().length, recordsBeforeRestart + 1);
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
      content: '@codex\n收到，无 open items。',
      targetCat: 'codex',
      clientMessageId: 'same-thread-review-ack',
    });
    assert.equal(ackResponse.statusCode, 200);
    assert.equal(ackResponse.json().status, 'terminal_ack_recorded');
    assert.equal(
      invocationRecordStore.getRecords().length,
      recordsBeforeAck,
      'terminal ACK must not wake the reviewer',
    );
    const ack = findMessage(thread.id, '@codex\n收到，无 open items。');
    assert.deepEqual(ack.mentions, []);
    assert.equal(ack.extra.crossPost, undefined);
    assert.equal(ack.extra.coordination.phase, 'ack');
  });
});
