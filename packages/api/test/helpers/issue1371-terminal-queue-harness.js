import { mock } from 'node:test';
import { buildHandedCvoEvent } from '../../dist/domains/ball-custody/ball-custody-events.js';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import {
  createInitialCrossThreadQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { createA2ADispositionHarness } from './a2a-dispatch-disposition-harness.js';

export async function runTerminalQueueHarness(scenario = 'active control') {
  const h = await createA2ADispositionHarness({
    ...(scenario === 'retirement unavailable'
      ? {
          beforeDispositionRecord: async () => {
            throw new Error('retirement store unavailable');
          },
        }
      : {}),
  });
  h.source.extra = {
    crossPost: { sourceThreadId: 'thread-origin', sourceInvocationId: 'origin-invocation' },
    coordination: { id: 'coord-review', phase: 'active', hop: 1, subjectRef: 'task:review' },
    targetCats: ['codex-sol'],
  };
  const terminal = h.messageStore.append({
    userId: 'user-1',
    catId: 'codex-sol',
    content: '@fable5 terminal result',
    mentions: ['fable5'],
    timestamp: 1_750,
    threadId: 'thread-origin',
    origin: 'callback',
    deliveryStatus: 'queued',
    extra: {
      crossPost: { sourceThreadId: 'thread-1', sourceInvocationId: 'inv-1' },
      coordination: { id: 'coord-review', phase: 'terminal', hop: 2, subjectRef: 'task:review' },
      causal: { kind: 'invocation_reply', triggerMessageId: h.source.id },
      stream: { invocationId: 'inv-1', turnInvocationId: 'inv-1' },
      targetCats: ['fable5'],
    },
  });
  h.setLatest(false);
  if (scenario === 'done_notify') {
    await h.ingest.record(
      buildHandedCvoEvent({
        threadId: 'thread-1',
        fromCatId: 'opus',
        messageId: 'unrelated-cvo-message',
        intent: 'done_notify',
        at: 1_751,
      }),
    );
  }
  const queue = new InvocationQueue();
  const deps = {
    queue,
    messageStore: h.messageStore,
    a2aDispatchDispositionService: h.service,
    queueCustodyCoordinator: new QueuedMessageCustodyCoordinator({ messageStore: h.messageStore }),
    invocationTracker: new InvocationTracker(),
    invocationRecordStore: {
      create: async () => ({ outcome: 'created', invocationId: 'inv-stub' }),
      update: async () => {},
    },
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    router: {
      routeExecution: mock.fn(async function* (...args) {
        await args[6].onPromptMessagesExposed({
          threadId: terminal.threadId,
          userId: terminal.userId,
          catId: 'fable5',
          invocationId: 'terminal-child',
          messageIds: [terminal.id],
          seenAt: 1_760,
        });
        h.messageStore.append({
          userId: terminal.userId,
          catId: 'fable5',
          content: 'Review finished.',
          mentions: [],
          timestamp: 1_765,
          threadId: terminal.threadId,
          replyTo: terminal.id,
          extra: {
            causal: { kind: 'invocation_reply', triggerMessageId: terminal.id },
            stream: { invocationId: 'inv-stub', turnInvocationId: 'terminal-child' },
          },
        });
        yield {
          type: 'done',
          catId: 'fable5',
          invocationId: 'terminal-child',
          timestamp: 1_770,
          turnCustodyTerminalWitness: {
            kind: 'terminal_silent',
            projectionState: 'covered_empty',
            wake: 'coordination_terminal',
          },
        };
      }),
      ackCollectedCursors: async () => {},
    },
  };
  const { entry } = queue.enqueue({
    threadId: terminal.threadId,
    userId: terminal.userId,
    ownerAuthProvenance: 'unknown',
    content: terminal.content,
    source: 'agent',
    sourceCategory: 'a2a',
    targetCats: ['fable5'],
    intent: 'execute',
    autoExecute: true,
    callerCatId: 'codex-sol',
    a2aParentInvocationId: 'inv-1',
    a2aTriggerMessageId: terminal.id,
  });
  queue.backfillMessageId(terminal.threadId, terminal.userId, entry.id, terminal.id);
  const queued = queue.getEntrySnapshot(terminal.threadId, terminal.userId, entry.id);
  h.messageStore.initializeQueueCustody(
    terminal.id,
    createInitialCrossThreadQueuedMessageCustody(terminal.id, [queued]),
  );
  const processor = new QueueProcessor(deps);
  const result = await processor.executeEntry(queue.markProcessing(terminal.threadId, terminal.userId));
  await processor.onInvocationComplete(
    terminal.threadId,
    'fable5',
    result.status,
    result.invocationId,
    result.successfulCatIds,
    result.primaryEntryRequeued,
    result.terminalInvocationIdByCatId,
    result.attemptedQueueEntryIds,
    result.terminalConsumptionByInvocationId,
  );
  const custody = h.messageStore.getById(terminal.id).queueCustody;
  return { h, terminal, queue, deps, entry, queued, processor, result, custody };
}
