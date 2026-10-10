import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCatId } from '@cat-cafe/shared';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { PersistedQueueDelivery } from '../../dist/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InMemoryQueueLedgerStore } from '../../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { InMemoryTurnExecutionStore } from '../../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import {
  MessageStore,
  settleLifecycleResponseInputs,
} from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import type { PersistedQueueDeliveryInput } from '../../src/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import type { QueueProcessorDeps } from '../../src/domains/cats/services/agents/invocation/QueueProcessor.js';
import type { RouteExecutionOptions } from '../../src/domains/cats/services/agents/routing/route-helpers.js';

/** Actual atomic admission/QueueProcessor/child History; controlled provider, not a model or successful Task verdict. */
export function createPersistedQueueFixture(
  messages = new MessageStore(),
  settings: {
    ledger?: InMemoryQueueLedgerStore;
    liveCompanionSessions?: QueueProcessorDeps['liveCompanionSessions'];
    onExecution?: (options: RouteExecutionOptions) => Promise<void>;
    onAdmitted?: (
      message?: import('../../dist/domains/cats/services/stores/ports/MessageStore.js').StoredMessage,
    ) => void;
  } = {},
) {
  const ledger = settings.ledger ?? new InMemoryQueueLedgerStore();
  let processor: QueueProcessor;
  const tracker = new InvocationTracker();
  const queue = new InvocationQueue(ledger, {
    invocationTracker: tracker,
    resolveTargets: async (requested) => (requested.length ? [...requested] : ['opus']),
    onAdmitted: ({ threadId, message }) => {
      settings.onAdmitted?.(message);
      void processor.requestDrain(threadId);
    },
  });
  const records = new InvocationRecordStore();
  const turns = new InMemoryTurnExecutionStore();
  const starts: {
    threadId: string;
    userId: string;
    invocationId: string;
    parentInvocationId: string;
    messageIds: readonly string[];
    ownerAuthProvenance: unknown;
  }[] = [];
  const completed: Promise<void>[] = [];
  const releases: (() => void)[] = [];
  processor = new QueueProcessor({
    queue,
    liveCompanionSessions: settings.liveCompanionSessions,
    invocationTracker: tracker,
    messageStore: messages,
    turnExecutionStore: turns,
    invocationRecordStore: {
      async create(input) {
        return records.create(input as unknown as Parameters<InvocationRecordStore['create']>[0]);
      },
      get: (id) => records.get(id),
      async update(id, input) {
        return records.update(id, input as Parameters<InvocationRecordStore['update']>[1]);
      },
    },
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
    log: { info() {}, warn() {}, error() {} },
    router: {
      async resolveExplicitTargets(requestedCatIds) {
        return [...requestedCatIds];
      },
      async resolveConversationTargetsAtAdmission(requestedCatIds) {
        return [...requestedCatIds];
      },
      async *routeExecution(userId, _content, threadId, messageId, targets, _intent, options) {
        const parentInvocationId = String(options?.parentInvocationId);
        const invocationId = randomUUID();
        const target = targets[0];
        if (!target) throw new Error('persisted Queue fixture requires one target');
        const catId = createCatId(target);
        assert.ok(messageId, 'persisted Queue fixture requires a public source');
        const messageIds = options?.persistedPromptMessageIds ?? [];
        const startedAt = Date.now();
        turns.createRunning({
          invocationId,
          parentInvocationId,
          threadId,
          userId,
          catId,
          startedAt,
          executionKind: 'ordinary',
          causal: { triggerMessageId: messageId, ...(messageIds.length ? { coveredMessageIds: [...messageIds] } : {}) },
        });
        const lifecycle = await options?.onLifecycleInvocationStarted?.({
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
        await exposed?.({ threadId, userId, catId, invocationId, messageIds, seenAt: Date.now() });
        await settings.onExecution?.(options);
        starts.push({
          threadId,
          userId,
          invocationId,
          parentInvocationId,
          messageIds,
          ownerAuthProvenance: options?.ownerAuthProvenance,
        });
        let finish!: () => void;
        completed.push(
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        );
        try {
          await new Promise<void>((resolve) => releases.push(resolve));
          turns.transitionTerminal(invocationId, {
            status: 'failed',
            terminalReason: 'fixture_provider_released',
            endedAt: Date.now(),
          });
          const terminal = messages.commitLifecycleResponseTerminal(lifecycle.responseMessageId, {
            invocationId,
            status: 'failed',
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
    progress: (entry, target) => processor.progressOwnedCarrier(entry, target),
  });
  const admissions: PersistedQueueDeliveryInput[] = [];
  const deliver = delivery.deliver.bind(delivery);
  delivery.deliver = async (input) => {
    const result = await deliver(input);
    admissions.push(input);
    return result;
  };
  function assertExactChild(messageId: string, started: (typeof starts)[number]) {
    assert.notEqual(started.invocationId, started.parentInvocationId, 'parent is not an exact child witness');
    assert.ok(records.get(started.parentInvocationId));
    const turn = turns.get(started.invocationId);
    assert.ok(turn);
    assert.equal(turn.parentInvocationId, started.parentInvocationId);
    const source = messages.getById(messageId);
    assert.ok(source && !Object.hasOwn(source, 'queueCustody'));
    assert.equal(source?.lifecycle?.kind, 'input');
    if (source?.lifecycle?.kind !== 'input') assert.fail('Source has no canonical input lifecycle');
    const ref = source.lifecycle.dispatchRefs?.find((candidate) => candidate.targetId === turn.catId);
    assert.ok(ref);
    const receiver = messages.getById(ref.statusMessageId);
    assert.equal(receiver?.lifecycle?.kind, 'response');
    if (receiver?.lifecycle?.kind !== 'response') assert.fail('Exact receiver response is missing');
    assert.equal(receiver.lifecycle.invocationId, started.invocationId);
    return started.invocationId;
  }
  async function waitForAwakening(messageId: string) {
    const deadline = Date.now() + 2000;
    for (;;) {
      const started = starts.find((candidate) => candidate.messageIds.includes(messageId));
      if (started) return assertExactChild(messageId, started);
      if (Date.now() >= deadline) assert.fail('QueueProcessor did not persist exact child admission and exposure');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
  async function close() {
    releases.splice(0).forEach((release) => {
      release();
    });
    await Promise.all(completed);
  }
  return {
    ledger,
    queue,
    tracker,
    records,
    turns,
    processor,
    delivery,
    admissions,
    messages,
    starts,
    waitForAwakening,
    close,
  };
}
