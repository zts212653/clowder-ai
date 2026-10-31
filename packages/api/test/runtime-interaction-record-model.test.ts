import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeInteractionRequest } from '@cat-cafe/shared';
import { normalizeRuntimeInteractionRecord } from '../src/domains/runtime-interaction/RuntimeInteractionRecordModel.js';
import { InMemoryRuntimeInteractionStore } from '../src/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.js';

const owner = {
  userId: 'owner',
  threadId: 'thread-1',
  catId: 'codex-sol',
  invocationId: 'requester-invocation',
};

test('historical provider records derive their legacy binding and initial revision', () => {
  const request: RuntimeInteractionRequest = {
    version: 1,
    interactionId: 'provider-legacy',
    kind: 'approval',
    owner,
    provider: {
      providerId: 'openai',
      method: 'item/fileChange/requestApproval',
      requestId: 'provider-request',
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      itemId: 'provider-item',
    },
    createdAt: 1,
    title: 'Apply file?',
    decisions: [{ id: 'accept', label: 'Apply', outcome: 'accept' }],
  };
  const normalized = normalizeRuntimeInteractionRecord({
    request,
    status: 'pending',
    hostEpoch: 'host-1',
    updatedAt: 2,
    cardRef: { threadId: owner.threadId, messageId: 'message-1', blockId: 'block-1' },
  });

  assert.equal(normalized.source.kind, 'provider_request');
  assert.equal(normalized.returnBinding.kind, 'provider_waiter');
  assert.equal(normalized.revision, 1);
});

test('conversation records never infer missing durable source, return binding, or revision', () => {
  const request: RuntimeInteractionRequest = {
    version: 1,
    interactionId: 'conversation-unbound',
    kind: 'conversation_decision',
    owner,
    createdAt: 1,
    title: 'Choose',
    presentation: {
      id: 'block-1',
      kind: 'interactive',
      v: 1,
      interactiveType: 'select',
      options: [{ id: 'yes', label: 'Yes' }],
    },
    allowTextResponse: false,
  };

  assert.throws(
    () =>
      normalizeRuntimeInteractionRecord({
        request,
        status: 'pending',
        hostEpoch: 'host-1',
        updatedAt: 2,
        cardRef: { threadId: owner.threadId, messageId: 'message-1', blockId: 'block-1' },
      }),
    /conversation interaction requires explicit durable bindings and revision/,
  );
});

test('the Store derives source and return binding from the canonical request instead of caller overrides', async () => {
  const request: RuntimeInteractionRequest = {
    version: 1,
    interactionId: 'provider-binding-derived',
    kind: 'approval',
    owner,
    provider: {
      providerId: 'openai',
      method: 'item/fileChange/requestApproval',
      requestId: 'provider-request-derived',
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      itemId: 'provider-item',
    },
    createdAt: 3,
    title: 'Apply another file?',
    decisions: [{ id: 'accept', label: 'Apply', outcome: 'accept' }],
  };
  const forgedInput = {
    request,
    hostEpoch: 'host-1',
    now: 4,
    source: {
      kind: 'conversation_decision' as const,
      requesterCatId: owner.catId,
      requesterThreadId: owner.threadId,
      requesterInvocationId: owner.invocationId,
    },
    returnBinding: {
      kind: 'conversation_turn' as const,
      requesterCatId: owner.catId,
      requesterThreadId: owner.threadId,
    },
  };

  const record = await new InMemoryRuntimeInteractionStore().createStaged(forgedInput);

  assert.equal(record.source.kind, 'provider_request');
  assert.equal(record.returnBinding.kind, 'provider_waiter');
});
