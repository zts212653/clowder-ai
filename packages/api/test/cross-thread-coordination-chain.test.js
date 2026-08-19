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
      coordination: { phase: 'active' },
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
      coordination: { phase: 'terminal' },
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
    const mismatchedTerminalAckResponse = await post({
      auth: targetAckAuth,
      threadId: source.id,
      content: 'Release received with stale caller id',
      targetCat: 'opus',
      coordination: { phase: 'terminal', id: 'caller-supplied-other-chain' },
      clientMessageId: 'ack-mismatched-terminal-id',
    });
    assert.equal(mismatchedTerminalAckResponse.statusCode, 200);
    assert.equal(mismatchedTerminalAckResponse.json().status, 'terminal_ack_recorded');
    assert.equal(invocationRecordStore.getRecords().length, recordsBeforeMismatchedTerminalAck);
    const mismatchedTerminalAck = findMessage(source.id, 'Release received with stale caller id');
    assert.equal(mismatchedTerminalAck.extra.coordination.id, coordinationId);
    assert.equal(mismatchedTerminalAck.extra.coordination.phase, 'ack');

    const recordsBeforeRestart = invocationRecordStore.getRecords().length;
    const restartResponse = await post({
      auth: targetAckAuth,
      threadId: source.id,
      content: 'New substantive coordination',
      targetCat: 'opus',
      coordination: { phase: 'active', id: coordinationId },
      clientMessageId: 'restart',
    });
    assert.equal(restartResponse.statusCode, 200);
    assert.equal(restartResponse.json().status, 'ok');
    assert.equal(invocationRecordStore.getRecords().length, recordsBeforeRestart + 1);
    const restart = findMessage(source.id, 'New substantive coordination');
    assert.notEqual(restart.extra.coordination.id, coordinationId);
    assert.equal(restart.extra.coordination.phase, 'active');
    assert.equal(restart.extra.coordination.hop, 0);
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

    // coordinate must deliver successfully (not intercepted)
    assert.equal(response.statusCode, 200, 'coordinate cross-thread must succeed (not intercepted)');

    // Message must be delivered to the target thread
    const delivered = findMessage(target.id, '@codex\nPlease review PR #3203');
    assert.ok(delivered, 'coordinate message must be delivered to target thread');

    // No DispatchProposal created — coordinate bypasses the intercept entirely
    const pending = await dispatchProposalStore.listPendingByUser('user-1');
    assert.equal(pending.length, 0, 'coordinate must NOT create a DispatchProposal (no approval card)');
  });
});
