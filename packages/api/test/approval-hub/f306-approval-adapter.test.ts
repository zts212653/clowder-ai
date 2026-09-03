import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeInteractionRequest } from '@cat-cafe/shared';
import { F306ApprovalAdapter } from '../../src/domains/approval-hub/adapters/F306ApprovalAdapter.js';
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
      owner,
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
      owner,
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
