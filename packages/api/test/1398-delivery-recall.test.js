// A delivered input belongs to its member response and cannot be withdrawn from the pending Queue.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { messageActionsRoutes } from '../dist/routes/message-actions.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

const THREAD_ID = 'thread-delivery-recall';
const OWNER_ID = 'owner-delivery-recall';

const apps = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('recall after delivery', () => {
  it('refuses withdrawal after delivery without preparing index or draft changes', async () => {
    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    threadStore.ensureThread(THREAD_ID, 'Delivery recall');
    const suppressed = [];
    const app = Fastify();
    app.register(messageActionsRoutes, {
      messageStore,
      threadStore,
      invocationQueue: new InvocationQueue(),
      queueProcessor: { registerCallerDispatchQueueWithdrawal() {}, unregisterEntryCompleteHook() {} },
      indexBuilder: {
        async suppressMessagePassage(threadId, messageId) {
          suppressed.push(messageId);
          return { threadId, messageId, leaseId: 'lease' };
        },
        async releaseMessagePassageSuppression() {
          return true;
        },
        async finalizeMessagePassageSuppression() {},
      },
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    });
    apps.push(app);

    const input = messageStore.append(
      canonicalTestMessageInput({
        threadId: THREAD_ID,
        userId: OWNER_ID,
        catId: null,
        content: '顺便看一下那个测试',
        mentions: ['opus'],
        timestamp: 1_000,
        deliveryStatus: 'queued',
      }),
    );
    const response = messageStore.append({
      from: { kind: 'agent', catId: 'opus' },
      userId: OWNER_ID,
      threadId: THREAD_ID,
      content: '',
      mentions: [],
      origin: 'stream',
      timestamp: 900,
      lifecycle: {
        kind: 'response',
        orderKey: '900:turn-opus',
        invocationId: 'turn-opus',
        targetId: 'opus',
        inputEntryIds: [],
        inputMessageIds: [],
        status: 'processing',
        startedAt: 900,
      },
    });
    const admission = messageStore.commitLifecycleAppendAdmission({
      threadId: THREAD_ID,
      entryId: 'entry-delivered',
      inputMessageIds: [input.id],
      runs: [{ targetId: 'opus', invocationId: 'turn-opus', responseMessageId: response.id, dispatchedAt: 1_001 }],
    });
    assert.equal(admission.kind, 'applied');
    messageStore.markDelivered(input.id, 1_001);

    const res = await app.inject({
      method: 'POST',
      url: `/api/messages/${input.id}/recall`,
      headers: { 'x-cat-cafe-user': OWNER_ID },
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });
    assert.equal(res.statusCode, 409, res.body);
    const body = res.json();
    assert.equal(body.code, 'MESSAGE_NOT_RECALLABLE');
    assert.deepEqual(suppressed, [], 'no index suppression was prepared');
    assert.equal(messageStore.getById(input.id).content, '顺便看一下那个测试');
    assert.equal(messageStore.getOwnerComposerDraft(OWNER_ID, THREAD_ID), null);
  });
});
