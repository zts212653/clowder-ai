import assert from 'node:assert/strict';
import { F306ApprovalAdapter } from '../../../api/dist/domains/approval-hub/adapters/F306ApprovalAdapter.js';
import { InvocationQueue } from '../../../api/dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageQueueRuntimeConversationReturnGateway } from '../../../api/dist/domains/runtime-interaction/MessageQueueRuntimeConversationReturnGateway.js';
import {
  MessageRuntimeInteractionCardPublisher,
  readVerifiedRuntimeInteractionPresentation,
} from '../../../api/dist/domains/runtime-interaction/RuntimeInteractionCardPublisher.js';
import { RuntimeInteractionService } from '../../../api/dist/domains/runtime-interaction/RuntimeInteractionService.js';
import { InMemoryRuntimeInteractionStore } from '../../../api/dist/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.js';
import { runtimeInteractionRoutes } from '../../../api/dist/routes/runtime-interaction-routes.js';
import { createInboxProposalFixture } from './f322-inbox-proposal.fixture.mjs';
import { providerRequest } from './f322-inbox-provider-requests.fixture.mjs';

/** Disposable authentic owner HTTP routes, original Message/Queue return and source validation. No provider dispatch. */
export async function createInboxConversationFixture(language) {
  const store = new InMemoryRuntimeInteractionStore(),
    queue = new InvocationQueue();
  let service, owner, messages, thread;
  const providers = new Map();
  const fixture = await createInboxProposalFixture({
    configureRuntime: async ({ app, owner: principal, messages: sourceMessages, threads, socketManager }) => {
      owner = principal;
      messages = sourceMessages;
      thread = threads.create(
        owner,
        language === 'en' ? 'Choose the verification environment' : '选择验证环境',
        'default',
      );
      const publisher = new MessageRuntimeInteractionCardPublisher({ messageStore: messages, socketManager });
      service = new RuntimeInteractionService({
        store,
        hostEpoch: 'owned-native-conversation',
        cardPublisher: publisher,
      });
      service.bindConversationReturnGateway(
        new MessageQueueRuntimeConversationReturnGateway({
          messageStore: messages,
          queue,
          socketManager,
          tryAutoExecute: async () => {},
        }),
      );
      await app.register(runtimeInteractionRoutes, { service });
      return {
        approvalAdapter: new F306ApprovalAdapter(store),
        service,
        store,
        queue,
        thread,
        async readPending() {
          const index = await store.readPendingIndexByUser(owner);
          assert.equal(index.exhaustiveness, 'complete');
          const presentations = new Map();
          for (const record of index.records) {
            const block = readVerifiedRuntimeInteractionPresentation(
              await messages.getById(record.cardRef.messageId),
              record.request,
              record.cardRef,
            );
            assert.ok(block);
            presentations.set(record.request.interactionId, block);
          }
          return { records: index.records, presentations };
        },
        async close() {
          for (const entry of providers.values()) entry.controller.abort();
          await Promise.all([...providers.values()].map((entry) => entry.settled));
        },
      };
    },
  });
  async function create(id, deadline = {}) {
    const title = language === 'en' ? `Where should we verify ${id}?` : `${id} 在哪里验证？`;
    return service.createConversationDecision({
      version: 1,
      interactionId: `native-${id}`,
      kind: 'conversation_decision',
      owner: { userId: owner, threadId: thread.id, catId: 'codex61-sol', invocationId: 'owned-producer-invocation' },
      createdAt: Date.now(),
      title,
      presentation: {
        kind: 'interactive',
        v: 1,
        id: `original-${id}`,
        interactiveType: 'select',
        title,
        options: [
          { id: 'alpha', label: 'Alpha' },
          { id: 'local', label: language === 'en' ? 'Local' : '本地' },
        ],
      },
      allowTextResponse: true,
      ...deadline,
    });
  }
  async function createProvider(id, kind) {
    const request = providerRequest({ id, kind, language, owner, threadId: thread.id });
    const controller = new AbortController();
    let terminal;
    const settled = service.request(request, { signal: controller.signal }).then(
      (response) => (terminal = { response }),
      (error) => (terminal = { error: error.reasonCode ?? error.message }),
    );
    providers.set(id, { controller, settled });
    for (let attempt = 0; attempt < 100; attempt++) {
      const pending = await store.get(request.interactionId);
      if (pending?.status === 'pending') return { pending, settled, result: () => terminal };
      if (terminal?.error) throw new Error(`Original provider request ${id} failed: ${terminal.error}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Original provider request ${id} did not publish`);
  }
  return { ...fixture, create, createProvider, service, store, queue, conversationThread: thread };
}
