import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('F276 defer-person-memory callback', () => {
  let app;
  let registry;
  let messageStore;
  let staged;
  let withdrawn;
  let forgotten;
  let forgetResult;
  let registryMatch;

  before(async () => {
    const [routeMod, registryMod, messageMod, authMod] = await Promise.all([
      import('../dist/routes/callback-defer-person-memory-routes.js'),
      import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
      import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
      import('../dist/routes/callback-auth-prehandler.js'),
    ]);
    registry = new registryMod.InvocationRegistry();
    messageStore = new messageMod.MessageStore();
    app = Fastify();
    authMod.registerCallbackAuthHook(app, registry);
    routeMod.registerCallbackDeferPersonMemoryRoutes(app, {
      registry,
      messageStore,
      receiptStore: {
        async stage(input) {
          staged.push(input);
          return {
            outcome: 'created',
            receipt: {
              ...input,
              state: input.ready ? 'deferred' : 'awaiting_confirmation',
              retention: 'owner_controlled_no_ttl',
              updatedAt: input.createdAt,
            },
          };
        },
        async hardForget(...args) {
          forgotten.push(args);
          return forgetResult;
        },
        async withdraw(ownerUserId, receiptId) {
          withdrawn.push({ ownerUserId, receiptId });
          return {
            outcome: 'withdrawn',
            receipt: { receiptId },
          };
        },
      },
      registryResolver: { resolve: async () => registryMatch },
    });
    await app.ready();
  });

  beforeEach(() => {
    staged = [];
    withdrawn = [];
    forgotten = [];
    forgetResult = { outcome: 'purged' };
    registryMatch = { kind: 'registered_person', ref: 'person_huang_ting' };
  });

  async function ownerMessage(threadId, content, extra = {}) {
    return messageStore.append({
      userId: 'owner-1',
      catId: null,
      content,
      mentions: [],
      timestamp: Date.now(),
      threadId,
      ...extra,
    });
  }

  async function invoke(payload, origin) {
    const auth = await registry.create(
      'owner-1',
      'codex-sol',
      origin.threadId,
      undefined,
      undefined,
      undefined,
      origin.id,
    );
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/defer-person-memory',
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
        'content-type': 'application/json',
      },
      payload,
    });
  }

  it('binds a content-free receipt to exact cross-thread owner sources and the current invocation', async () => {
    const source = await ownerMessage('thread_history', '黄挺和我聊了三小时团队管理');
    const origin = await ownerMessage('thread_current', '先记下来，当前别打断主任务');
    const response = await invoke(
      {
        subject: '黄挺',
        sources: [{ kind: 'message', messageId: source.id }],
        clientRequestId: 'capture-huang-ting-1',
      },
      origin,
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(JSON.parse(response.body)).sort(), ['deduped', 'receiptId', 'status']);
    assert.equal(JSON.parse(response.body).status, 'deferred');
    assert.equal(staged.length, 1);
    assert.equal(staged[0].ownerUserId, 'owner-1');
    assert.equal(staged[0].requesterCatId, 'codex-sol');
    assert.equal(staged[0].originMessageRef.threadId, 'thread_current');
    assert.deepEqual(staged[0].sourceCoordinates[0].sourceRef, {
      kind: 'message',
      threadId: 'thread_history',
      messageId: source.id,
    });
    assert.equal(JSON.stringify(staged[0]).includes(source.content), false);
  });

  it('canonicalizes source order and rejects duplicate exact coordinates before staging', async () => {
    const first = await ownerMessage('thread_history', '黄挺和我聊了团队管理');
    const second = await ownerMessage('thread_history', '黄挺和我聊了候选人评估');
    const origin = await ownerMessage('thread_current', '先记来源，稍后统一处理');

    const forward = await invoke(
      {
        subject: '黄挺',
        sources: [
          { kind: 'message', messageId: first.id },
          { kind: 'message', messageId: second.id },
        ],
        clientRequestId: 'capture-forward',
      },
      origin,
    );
    const reverse = await invoke(
      {
        subject: '黄挺',
        sources: [
          { kind: 'message', messageId: second.id },
          { kind: 'message', messageId: first.id },
        ],
        clientRequestId: 'capture-reverse',
      },
      origin,
    );

    assert.equal(forward.statusCode, 200);
    assert.equal(reverse.statusCode, 200);
    assert.equal(staged[0].dedupeHash, staged[1].dedupeHash);
    assert.deepEqual(
      staged[0].sourceCoordinates.map((coordinate) => coordinate.sourceRef.messageId),
      staged[1].sourceCoordinates.map((coordinate) => coordinate.sourceRef.messageId),
    );

    staged = [];
    const duplicate = await invoke(
      {
        subject: '黄挺',
        sources: [
          { kind: 'message', messageId: first.id },
          { kind: 'message', messageId: first.id },
        ],
        clientRequestId: 'capture-duplicate',
      },
      origin,
    );
    assert.equal(duplicate.statusCode, 422);
    assert.deepEqual(JSON.parse(duplicate.body), { error: 'duplicate_source_coordinate' });
    assert.equal(staged.length, 0);
  });

  it('rejects caller-owned auth fields and cross-owner source laundering', async () => {
    const source = await messageStore.append({
      userId: 'owner-2',
      catId: null,
      content: '黄挺的私密事实',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_other_owner',
    });
    const origin = await ownerMessage('thread_current', '延后处理');
    const forbidden = await invoke(
      {
        subject: '黄挺',
        sources: [{ kind: 'message', messageId: source.id }],
        clientRequestId: 'capture-forbidden-fields',
        ownerUserId: 'owner-2',
      },
      origin,
    );
    assert.equal(forbidden.statusCode, 400);

    const laundering = await invoke(
      {
        subject: '黄挺',
        sources: [{ kind: 'message', messageId: source.id }],
        clientRequestId: 'capture-cross-owner',
      },
      origin,
    );
    assert.equal(laundering.statusCode, 422);
    assert.equal(staged.length, 0);
  });

  it('keeps ASR attachments non-actionable until an exact owner confirmation is bound', async () => {
    const source = await ownerMessage('thread_history', '线下会面录音', {
      contentBlocks: [{ type: 'image', alt: 'ASR: 黄挺讨论候选人评估' }],
    });
    const origin = await ownerMessage('thread_current', '先延后');
    const unconfirmed = await invoke(
      {
        subject: '黄挺',
        sources: [
          {
            kind: 'message_attachment',
            messageId: source.id,
            attachmentLocator: { surface: 'content_block', index: 0 },
          },
        ],
        clientRequestId: 'capture-asr-unconfirmed',
      },
      origin,
    );
    assert.equal(unconfirmed.statusCode, 200);
    assert.equal(JSON.parse(unconfirmed.body).status, 'awaiting_confirmation');
    assert.equal(staged[0].ready, false);

    staged = [];
    const confirmation = await ownerMessage('thread_confirmation', '这份转写内容准确，已确认。');
    const confirmed = await invoke(
      {
        subject: '黄挺',
        sources: [
          {
            kind: 'message_attachment',
            messageId: source.id,
            attachmentLocator: { surface: 'content_block', index: 0 },
            confirmationMessageId: confirmation.id,
          },
        ],
        clientRequestId: 'capture-asr-confirmed',
      },
      origin,
    );
    assert.equal(confirmed.statusCode, 200);
    assert.equal(JSON.parse(confirmed.body).status, 'deferred');
    assert.equal(staged[0].ready, true);
    assert.equal(staged[0].sourceCoordinates[0].confirmationSourceRef.messageId, confirmation.id);
  });

  it('fails closed for unregistered subjects and stale invocation generations', async () => {
    const source = await ownerMessage('thread_history', '未知人甲和我聊了很久');
    const origin = await ownerMessage('thread_current', '延后处理');
    registryMatch = { kind: 'unregistered' };
    const unknown = await invoke(
      {
        subject: '未知人甲',
        sources: [{ kind: 'message', messageId: source.id }],
        clientRequestId: 'capture-unknown',
      },
      origin,
    );
    assert.equal(unknown.statusCode, 409);
    assert.equal(staged.length, 0);
  });

  it('withdraws and hard-forgets only an exact owner-authenticated receipt id', async () => {
    const origin = await ownerMessage('thread_current', '撤回之前延后的黄挺记录');
    const auth = await registry.create(
      'owner-1',
      'codex-sol',
      origin.threadId,
      undefined,
      undefined,
      undefined,
      origin.id,
    );
    const headers = {
      'x-invocation-id': auth.invocationId,
      'x-callback-token': auth.callbackToken,
      'content-type': 'application/json',
    };
    const receiptId = `deferred_person_${'a'.repeat(32)}`;

    const withdrawal = await app.inject({
      method: 'POST',
      url: '/api/callbacks/person-memory/deferred/withdraw',
      headers,
      payload: { receiptId },
    });
    assert.equal(withdrawal.statusCode, 200);
    assert.deepEqual(JSON.parse(withdrawal.body), { receiptId, status: 'withdrawn', replayed: false });
    assert.deepEqual(withdrawn, [{ ownerUserId: 'owner-1', receiptId }]);

    const forgetting = await app.inject({
      method: 'POST',
      url: '/api/callbacks/person-memory/deferred/forget',
      headers,
      payload: { receiptId },
    });
    assert.equal(forgetting.statusCode, 200);
    assert.deepEqual(JSON.parse(forgetting.body), { receiptId, status: 'purged' });
    assert.deepEqual(forgotten.at(-1), ['owner-1', receiptId]);

    const forged = await app.inject({
      method: 'POST',
      url: '/api/callbacks/person-memory/deferred/forget',
      headers,
      payload: { receiptId, ownerUserId: 'owner-2' },
    });
    assert.equal(forged.statusCode, 400);
    assert.equal(forgotten.length, 1);

    forgetResult = { outcome: 'proposal_bound', proposalId: 'person_candidate_bound' };
    const proposalBound = await app.inject({
      method: 'POST',
      url: '/api/callbacks/person-memory/deferred/forget',
      headers,
      payload: { receiptId },
    });
    assert.equal(proposalBound.statusCode, 409);
    assert.deepEqual(JSON.parse(proposalBound.body), {
      error: 'proposal_bound',
      proposalId: 'person_candidate_bound',
    });
  });
});
