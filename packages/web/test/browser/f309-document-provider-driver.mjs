// Production Queue/History/execution machinery; the provider is a bounded deterministic test driver, never a model.
// Same provider boundary as api/test/helpers/persisted-queue-fixture; imports use shipped API output.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InvocationQueue } from '../../../api/dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../../../api/dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { PersistedQueueDelivery } from '../../../api/dist/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import { QueueProcessor } from '../../../api/dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InMemoryTurnExecutionStore } from '../../../api/dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../../../api/dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import {
  MessageStore,
  settleLifecycleResponseInputs,
} from '../../../api/dist/domains/cats/services/stores/ports/MessageStore.js';
import { contentModificationRequestCarrierV1Schema } from '../../../shared/dist/index.js';

function originalHumanTrigger(messages, messageId, { userId, threadId, catId }) {
  const carrier = messages.getById(messageId);
  const pointer = contentModificationRequestCarrierV1Schema.safeParse(carrier?.source?.meta);
  if (!pointer.success) return messageId;
  const human = messages.getById(pointer.data.sourceMessageId);
  assert.ok(human && human.catId === null && human.userId === userId && human.threadId === threadId);
  assert.ok(human.mentions.includes(catId));
  return human.id;
}
/** Real admission, QueueProcessor and durable History, with a deterministic provider boundary that never calls a model. */
export function createDocumentProviderDriver(messages = new MessageStore(), { executionSource = 'carrier' } = {}) {
  const queue = new InvocationQueue();
  const tracker = new InvocationTracker();
  const records = new InvocationRecordStore();
  const turns = new InMemoryTurnExecutionStore();
  const starts = [];
  const completed = [];
  const releases = [];
  const processor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    messageStore: messages,
    turnExecutionStore: turns,
    invocationRecordStore: {
      async create(input) {
        return records.create(input);
      },
      get: (id) => records.get(id),
      async update(id, input) {
        return records.update(id, input);
      },
    },
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
    log: { info() {}, warn() {}, error() {} },
    router: {
      async resolveConversationTargetsAtAdmission(targets) {
        return [...targets];
      },
      async resolveExplicitTargets(targets) {
        return [...targets];
      },
      async *routeExecution(userId, _content, threadId, _messageId, targets, _intent, options) {
        const parentInvocationId = String(options?.parentInvocationId);
        const invocationId = randomUUID();
        const catId = targets[0];
        starts.push({ threadId, userId, invocationId });
        const startedAt = Date.now();
        // Replay the recorded Alpha same-turn causal cut at the synthetic provider boundary.
        // Delivery/callback/queue facts stay real; this is not a live-model or original Human-send claim.
        const triggerMessageId =
          executionSource === 'original-human'
            ? originalHumanTrigger(messages, _messageId, { userId, threadId, catId })
            : _messageId;
        turns.createRunning({
          invocationId,
          parentInvocationId,
          threadId,
          userId,
          catId,
          startedAt,
          executionKind: 'ordinary',
          causal: {
            triggerMessageId,
            ...(triggerMessageId !== _messageId
              ? { coveredMessageIds: [triggerMessageId] }
              : options?.persistedPromptMessageIds?.length
                ? { coveredMessageIds: options.persistedPromptMessageIds }
                : {}),
          },
        });
        const lifecycle = await options.onLifecycleInvocationStarted({
          threadId,
          userId,
          catId,
          invocationId,
          parentInvocationId,
          startedAt,
        });
        assert.ok(lifecycle);
        yield {
          type: 'system_info',
          catId,
          turnInvocationId: invocationId,
          turnExecutionStartedAt: startedAt,
          lifecycleResponseMessageId: lifecycle.responseMessageId,
          lifecyclePriorFrontierMessageId: lifecycle.priorFrontierMessageId,
          timestamp: startedAt,
          extra: { turnExecution: { executionKind: 'ordinary', invocationId, parentInvocationId } },
        };
        const exposed = options?.onPromptMessagesExposed;
        assert.equal(typeof exposed, 'function');
        if (typeof exposed === 'function')
          await exposed({
            threadId,
            userId,
            catId,
            invocationId,
            messageIds: options?.persistedPromptMessageIds,
            seenAt: Date.now(),
          });
        let finish;
        const settled = new Promise((resolve) => {
          finish = resolve;
        });
        completed.push(settled);
        await new Promise((resolve) => releases.push(resolve));
        // Release the fixture's provider without fabricating a successful work/Task verdict.
        try {
          if (turns.get(invocationId)?.status === 'running')
            turns.transitionTerminal(invocationId, {
              status: 'failed',
              terminalReason: 'fixture_provider_released',
              endedAt: Date.now(),
            });
          const turn = turns.get(invocationId);
          const terminal = messages.commitLifecycleResponseTerminal(lifecycle.responseMessageId, {
            invocationId,
            status: turn.status === 'succeeded' ? 'completed' : turn.status,
            completedAt: Date.now(),
            content: '',
            mentions: [],
            origin: 'stream',
            reason: 'fixture_provider_released',
          });
          assert.ok(terminal.kind === 'applied' || terminal.kind === 'replayed');
          await settleLifecycleResponseInputs(messages, terminal.message, lifecycle.responseMessageId);
          yield { type: 'done', catId, invocationId, timestamp: Date.now(), isError: true };
        } finally {
          finish();
        }
      },
      async ackCollectedCursors() {},
    },
  });
  const delivery = new PersistedQueueDelivery({
    messages,
    queue,
    progress: (entry, targetCatId) => processor.progressOwnedCarrier(entry, targetCatId),
  });
  async function waitForAwakening(messageId) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const message = messages.getById(messageId);
      const catId = message?.mentions[0];
      const ref = message?.lifecycle?.dispatchRefs?.find((item) => item.targetId === catId);
      const id = ref && messages.getById(ref.statusMessageId)?.lifecycle?.invocationId;
      if (id) {
        const turn = turns.get(id);
        assert.ok(turn);
        assert.ok(records.get(turn.parentInvocationId));
        return id;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail('QueueProcessor did not persist the admitted child awakening');
  }
  async function close() {
    for (const release of releases.splice(0)) release();
    await Promise.all(completed);
  }
  return {
    queue,
    tracker,
    records,
    turns,
    processor,
    delivery,
    messages,
    starts,
    waitForAwakening,
    close,
  };
}
