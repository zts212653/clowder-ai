import assert from 'node:assert/strict';
import { it } from 'node:test';

import { createAssistantReturnInbox } from '../src/plugins/cloud-cat-personal-host/native-host/assistant-return-inbox.mjs';

const revisions = {
  helper: `sha512:${'0'.repeat(128)}`,
  extension: '0.2.10',
  pageAdapter: '2026-09-02.1',
};

function observed(overrides = {}) {
  return {
    v: 2,
    kind: 'assistant_final_observed',
    requestId: 'request-1',
    conversationId: 'conversation-7',
    idempotencyKey: 'source-message-9',
    hostMessageId: 'conversation-turn-41',
    assistantMessageId: 'conversation-turn-42',
    content: 'exact causal assistant final',
    observedRevisions: revisions,
    ...overrides,
  };
}

it('rejects an assistant final whose complete serialized return frame exceeds the local transport limit', async () => {
  const entry = {
    conversationId: 'conversation-7',
    idempotencyKey: 'source-message-9',
    submitted: true,
    hostMessageId: 'conversation-turn-41',
    expectedRevisions: revisions,
  };
  const ledger = new Map([['conversation-7\u0000source-message-9', entry]]);
  const inbox = createAssistantReturnInbox({ ledger, persist: async () => undefined });
  const list = (requestId) => inbox.handleLocalRequest({ v: 2, kind: 'list_assistant_returns', requestId });

  const jsonExpansionOverflow = `a${'\n'.repeat(128 * 1024 - 1)}`;
  const oversizedResult = {
    v: 2,
    kind: 'assistant_returns',
    requestId: 'x'.repeat(200),
    returns: [
      {
        conversationId: entry.conversationId,
        sourceMessageId: entry.idempotencyKey,
        assistantMessageId: 'conversation-turn-42',
        content: jsonExpansionOverflow,
      },
    ],
  };
  assert.ok(Buffer.byteLength(`${JSON.stringify(oversizedResult)}\n`, 'utf8') > 256 * 1024);
  assert.equal(await inbox.acceptObserved(observed({ content: jsonExpansionOverflow })), 'rejected');
  assert.deepEqual((await list('list-after-oversized-frame')).returns, []);
  assert.equal(entry.assistantReturn, undefined);

  assert.equal(await inbox.acceptObserved(observed()), 'accepted');
  assert.equal((await list('list-after-valid-frame')).returns.length, 1);
});

it('admits only a matching Host receipt and rolls memory back when durable persist or ACK fails', async () => {
  const entry = {
    conversationId: 'conversation-7',
    idempotencyKey: 'source-message-9',
    submitted: true,
    expectedRevisions: revisions,
  };
  const ledger = new Map([['conversation-7\u0000source-message-9', entry]]);
  let failPersist = false;
  const inbox = createAssistantReturnInbox({
    ledger,
    persist: async () => {
      if (failPersist) throw new Error('simulated durable write failure');
    },
    now: () => new Date('2026-08-30T08:00:00.000Z'),
  });
  const list = (requestId) => inbox.handleLocalRequest({ v: 2, kind: 'list_assistant_returns', requestId });

  assert.equal(await inbox.acceptObserved(observed()), 'rejected');
  assert.deepEqual((await list('list-before-host-receipt')).returns, []);

  entry.hostMessageId = 'conversation-turn-41';
  failPersist = true;
  await assert.rejects(inbox.acceptObserved(observed()), /simulated durable write failure/);
  assert.deepEqual((await list('list-after-failed-persist')).returns, []);

  failPersist = false;
  assert.equal(await inbox.acceptObserved(observed()), 'accepted');
  assert.equal((await list('list-pending')).returns.length, 1);

  failPersist = true;
  await assert.rejects(
    inbox.handleLocalRequest({
      v: 2,
      kind: 'ack_assistant_return',
      requestId: 'ack-failed',
      conversationId: 'conversation-7',
      sourceMessageId: 'source-message-9',
      assistantMessageId: 'conversation-turn-42',
    }),
    /simulated durable write failure/,
  );
  assert.equal((await list('list-after-failed-ack')).returns.length, 1);
});

it('lists after a retained return without deleting the durable head item', async () => {
  const first = {
    conversationId: 'conversation-7',
    idempotencyKey: 'source-message-9',
    assistantReturn: {
      state: 'pending',
      assistantMessageId: 'conversation-turn-42',
      content: 'retained restart final',
    },
  };
  const second = {
    conversationId: 'conversation-7',
    idempotencyKey: 'source-message-10',
    assistantReturn: {
      state: 'pending',
      assistantMessageId: 'conversation-turn-44',
      content: 'newer authorized final',
    },
  };
  const ledger = new Map([
    ['conversation-7\u0000source-message-9', first],
    ['conversation-7\u0000source-message-10', second],
  ]);
  const inbox = createAssistantReturnInbox({ ledger, persist: async () => undefined });

  assert.equal(
    (await inbox.handleLocalRequest({ v: 2, kind: 'list_assistant_returns', requestId: 'list-head' })).returns[0]
      .sourceMessageId,
    first.idempotencyKey,
  );
  assert.equal(
    (
      await inbox.handleLocalRequest({
        v: 2,
        kind: 'list_assistant_returns',
        requestId: 'list-after-retained',
        afterConversationId: first.conversationId,
        afterSourceMessageId: first.idempotencyKey,
        afterAssistantMessageId: first.assistantReturn.assistantMessageId,
      })
    ).returns[0].sourceMessageId,
    second.idempotencyKey,
  );
  assert.equal(
    (await inbox.handleLocalRequest({ v: 2, kind: 'list_assistant_returns', requestId: 'list-head-again' })).returns[0]
      .sourceMessageId,
    first.idempotencyKey,
  );
  assert.deepEqual(
    await inbox.handleLocalRequest({
      v: 2,
      kind: 'list_assistant_returns',
      requestId: 'list-invalid-half-cursor',
      afterSourceMessageId: first.idempotencyKey,
    }),
    {
      v: 2,
      kind: 'assistant_return_error',
      requestId: 'list-invalid-half-cursor',
      errorCode: 'INVALID_REQUEST',
    },
  );
});

it('advances past retained returns whose message IDs collide across conversations', async () => {
  const retained = {
    conversationId: 'conversation-7',
    idempotencyKey: 'source-message-9',
    assistantReturn: {
      state: 'pending',
      assistantMessageId: 'conversation-turn-2',
      content: 'retained return from the original conversation',
    },
  };
  const moved = {
    conversationId: 'conversation-8',
    idempotencyKey: 'source-message-9',
    assistantReturn: {
      state: 'pending',
      assistantMessageId: 'conversation-turn-2',
      content: 'retained return after the route moved',
    },
  };
  const later = {
    conversationId: 'conversation-9',
    idempotencyKey: 'source-message-10',
    assistantReturn: {
      state: 'pending',
      assistantMessageId: 'conversation-turn-3',
      content: 'later authorized return',
    },
  };
  const ledger = new Map([
    ['conversation-7\u0000source-message-9', retained],
    ['conversation-8\u0000source-message-9', moved],
    ['conversation-9\u0000source-message-10', later],
  ]);
  const inbox = createAssistantReturnInbox({ ledger, persist: async () => undefined });

  const afterRetained = await inbox.handleLocalRequest({
    v: 2,
    kind: 'list_assistant_returns',
    requestId: 'list-after-retained-collision',
    afterConversationId: retained.conversationId,
    afterSourceMessageId: retained.idempotencyKey,
    afterAssistantMessageId: retained.assistantReturn.assistantMessageId,
  });
  assert.equal(afterRetained.returns[0].conversationId, moved.conversationId);

  const afterMoved = await inbox.handleLocalRequest({
    v: 2,
    kind: 'list_assistant_returns',
    requestId: 'list-after-moved-collision',
    afterConversationId: moved.conversationId,
    afterSourceMessageId: moved.idempotencyKey,
    afterAssistantMessageId: moved.assistantReturn.assistantMessageId,
  });
  assert.equal(afterMoved.returns[0].conversationId, later.conversationId);

  assert.deepEqual(
    await inbox.handleLocalRequest({
      v: 2,
      kind: 'list_assistant_returns',
      requestId: 'list-invalid-cursor-without-conversation',
      afterSourceMessageId: retained.idempotencyKey,
      afterAssistantMessageId: retained.assistantReturn.assistantMessageId,
    }),
    {
      v: 2,
      kind: 'assistant_return_error',
      requestId: 'list-invalid-cursor-without-conversation',
      errorCode: 'INVALID_REQUEST',
    },
  );
});

it('acknowledges only the exact conversation when fallback assistant IDs collide across redispatches', async () => {
  const first = {
    conversationId: 'conversation-7',
    idempotencyKey: 'source-message-9',
    assistantReturn: {
      state: 'pending',
      assistantMessageId: 'conversation-turn-2',
      content: 'final from the original conversation',
    },
  };
  const moved = {
    conversationId: 'conversation-8',
    idempotencyKey: 'source-message-9',
    assistantReturn: {
      state: 'pending',
      assistantMessageId: 'conversation-turn-2',
      content: 'final after the authorized route moved',
    },
  };
  const ledger = new Map([
    ['conversation-7\u0000source-message-9', first],
    ['conversation-8\u0000source-message-9', moved],
  ]);
  const inbox = createAssistantReturnInbox({
    ledger,
    persist: async () => undefined,
    now: () => new Date('2026-08-30T09:00:00.000Z'),
  });

  assert.deepEqual(
    await inbox.handleLocalRequest({
      v: 2,
      kind: 'ack_assistant_return',
      requestId: 'ack-moved-conversation',
      conversationId: moved.conversationId,
      sourceMessageId: moved.idempotencyKey,
      assistantMessageId: moved.assistantReturn.assistantMessageId,
    }),
    {
      v: 2,
      kind: 'assistant_return_ack',
      requestId: 'ack-moved-conversation',
      status: 'acknowledged',
    },
  );
  assert.ok(first.assistantReturn, 'the other conversation return must remain durable');
  assert.equal(moved.assistantReturn, undefined);
  assert.equal(moved.assistantReturnAckedAt, '2026-08-30T09:00:00.000Z');
});
