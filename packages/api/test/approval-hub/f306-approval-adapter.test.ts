import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeInteractionRequest } from '@cat-cafe/shared';
import { F306ApprovalAdapter } from '../../src/domains/approval-hub/adapters/F306ApprovalAdapter.js';
import type { IApprovalAdapter } from '../../src/domains/approval-hub/ports/IApprovalAdapter.js';
import { InMemoryRuntimeInteractionStore } from '../../src/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.js';

const owner = { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol', invocationId: 'inv-1' };
const provider = {
  providerId: 'openai',
  method: 'item/commandExecution/requestApproval',
  requestId: 'rpc-1',
  threadId: 'provider-thread',
  turnId: 'provider-turn',
  itemId: 'provider-item',
};

function requests(): RuntimeInteractionRequest[] {
  return [
    {
      version: 1,
      interactionId: 'approval-1',
      kind: 'approval',
      owner,
      provider,
      createdAt: 3000,
      title: 'Run command?',
      description: 'pnpm test',
      decisions: [
        { id: 'accept', label: 'Allow', outcome: 'accept' },
        { id: 'decline', label: 'Decline', outcome: 'decline' },
      ],
    },
    {
      version: 1,
      interactionId: 'question-1',
      kind: 'question',
      owner: { ...owner, invocationId: 'inv-question' },
      provider: { ...provider, method: 'item/tool/requestUserInput', requestId: 'rpc-2' },
      createdAt: 2000,
      title: 'Which environment?',
      questions: [{ id: 'environment', header: 'Environment', question: 'Where?' }],
    },
    {
      version: 1,
      interactionId: 'elicitation-1',
      kind: 'elicitation',
      mode: 'url',
      owner: { ...owner, invocationId: 'inv-elicitation' },
      provider: { ...provider, method: 'mcpServer/elicitation/request', requestId: 'rpc-3' },
      createdAt: 1000,
      title: 'Authorize MCP server',
      message: 'Open the provider page',
      elicitationId: 'elicit-1',
      url: 'https://example.com/auth',
      decisions: [{ id: 'cancel', label: 'Cancel', outcome: 'cancel' }],
    },
  ];
}

describe('F306ApprovalAdapter', () => {
  it('reports unavailable rather than empty history for a source without the read capability', async () => {
    const adapter = new F306ApprovalAdapter({ get: async () => null, listPendingByUser: async () => [] });
    await assert.rejects(adapter.listSettled('user-1'), /history unavailable/);
  });
  it('projects only anchored pending approval requests as navigation-only Hub items', async () => {
    const store = new InMemoryRuntimeInteractionStore();
    for (const request of requests()) {
      await store.createStaged({ request, hostEpoch: 'host-1', now: request.createdAt });
      await store.anchor(
        request.interactionId,
        'host-1',
        {
          threadId: request.owner.threadId,
          messageId: `message-${request.interactionId}`,
          blockId: `runtime-interaction:${request.interactionId}`,
        },
        request.createdAt + 1,
      );
    }

    const adapter = new F306ApprovalAdapter(store);
    const items = await adapter.listPending('user-1');
    assert.equal(adapter.featureId, 'F306');
    assert.equal(items.length, 1);
    assert.equal(items[0].proposalId, 'approval-1');
    assert.equal(items[0].inlineApprovable, false);
    assert.equal(items[0].sourceFeatureId, 'F306');
    assert.equal(items[0].expiresAt, undefined, 'TTL=0 F306 projections never become client-expired Hub rows');
    assert.deepEqual(items[0].navigation, {
      state: 'anchored',
      originRef: { kind: 'message', threadId: 'thread-1', messageId: 'message-approval-1' },
      approvalCardRef: { threadId: 'thread-1', messageId: 'message-approval-1' },
    });
    assert.deepEqual(items[0].needsMeDecisionRefs, [
      { producerId: 'f306.runtime_interaction', subjectRef: 'approval-1', revision: 3001 },
    ]);
    assert.equal(items[0].detail.providerRequestId, 'rpc-1');
    assert.equal(items[0].detail.providerTurnId, 'provider-turn');
    assert.equal(items[0].detail.providerItemId, 'provider-item');
  });

  it('does not project staged, invalidated, or another owner records', async () => {
    const store = new InMemoryRuntimeInteractionStore();
    const [approval] = requests();
    await store.createStaged({ request: approval, hostEpoch: 'host-1', now: 3000 });
    const adapter = new F306ApprovalAdapter(store);
    assert.deepEqual(await adapter.listPending('user-1'), []);
    assert.deepEqual(await adapter.listPending('user-2'), []);
  });
});

it('reads owner-scoped canonical provider terminals after pending retirement', async () => {
  const store = new InMemoryRuntimeInteractionStore();
  for (const request of requests()) {
    await store.createStaged({ request, hostEpoch: 'history-host', now: request.createdAt });
    await store.anchor(
      request.interactionId,
      'history-host',
      {
        threadId: request.owner.threadId,
        messageId: `history-${request.interactionId}`,
        blockId: `runtime-interaction:${request.interactionId}`,
      },
      request.createdAt + 1,
    );
    await store.settle({
      interactionId: request.interactionId,
      hostEpoch: 'history-host',
      now: request.createdAt + 2,
      terminal: { status: 'answered', reasonCode: 'answered', settledAt: request.createdAt + 2 },
    });
  }
  const adapter: IApprovalAdapter = new F306ApprovalAdapter(store);
  const settled = await adapter.listSettled?.('user-1');
  assert.equal(settled?.length, 3, 'all anchored provider kinds have durable result projections');
  assert.equal((await adapter.listSettled?.('user-1', { limit: 1 }))?.length, 1);
  assert.equal((await adapter.listPending('user-1')).length, 0);
  assert.deepEqual(await adapter.listSettled?.('user-2'), []);
  assert.ok(settled?.every((item) => item.ownerUserId === 'user-1' && typeof item.detail.runtimeRevision === 'number'));
});

for (const reasonCode of ['answered', 'defaulted'] as const)
  it(`retains canonical ${reasonCode} choices without private response text or a fabricated approval`, async () => {
    const store = new InMemoryRuntimeInteractionStore();
    const request: RuntimeInteractionRequest = {
      version: 1,
      interactionId: 'conversation-history',
      kind: 'conversation_decision',
      owner,
      createdAt: 1000,
      title: 'Which environment?',
      allowTextResponse: true,
      presentation: {
        kind: 'interactive',
        v: 1,
        id: 'conversation-block',
        interactiveType: 'select',
        options: [{ id: 'alpha', label: 'Alpha' }],
      },
    };
    const created = await store.createStaged({ request, hostEpoch: 'history-host', now: 1000 });
    const anchored = await store.anchor(
      request.interactionId,
      'history-host',
      {
        threadId: owner.threadId,
        messageId: 'conversation-card',
        blockId: 'conversation-block',
        blockDigest: 'a'.repeat(64),
        publishedAt: 1001,
      },
      1001,
      created.revision,
    );
    assert.ok(anchored);
    await store.settleConversation({
      interactionId: request.interactionId,
      expectedRevision: anchored.revision,
      terminal: {
        status: 'answered',
        reasonCode,
        settledAt: 1002,
        response: { kind: 'selection', selectedIds: ['alpha'] },
      },
      now: 1002,
    });
    const adapter = new F306ApprovalAdapter(store);
    const rows = await adapter.listSettled(owner.userId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, reasonCode === 'answered' ? 'approved' : 'closed_without_decision');
    assert.deepEqual(rows[0].detail.runtimeSelectedLabels, ['Alpha']);
    assert.deepEqual(rows[0].detail.runtimeCardRef, anchored.cardRef);
    assert.equal(rows[0].detail.runtimeKind, 'conversation_decision');
    assert.equal(Object.hasOwn(rows[0].detail, 'response'), false);
    assert.deepEqual(await adapter.listPending(owner.userId), []);
  });
