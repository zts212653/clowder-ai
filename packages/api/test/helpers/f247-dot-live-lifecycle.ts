import assert from 'node:assert/strict';
import { createCatId } from '@cat-cafe/shared';
import {
  type InvocationRecordStoreLike,
  QueueProcessor,
  type QueueProcessorDeps,
  type RouterLike,
} from '../../src/domains/cats/services/agents/invocation/QueueProcessor.js';
import type { dotProactiveFixture } from './f247-dot-proactive-fixture.js';

type Fixture = Awaited<ReturnType<typeof dotProactiveFixture>>;

export function dotLiveQueueProcessor(
  f: Fixture,
  router?: RouterLike,
  turnExecutionStore?: QueueProcessorDeps['turnExecutionStore'],
) {
  const tracker = f.invocationTracker;
  const processor = new QueueProcessor({
    queue: f.queue,
    messageStore: f.messages,
    invocationTracker: tracker,
    invocationRecordStore: f.records as unknown as InvocationRecordStoreLike,
    socketManager: f.socket,
    ...(turnExecutionStore ? { turnExecutionStore } : {}),
    router: router ?? {
      resolveExplicitTargets: async (targets) => [...targets],
      resolveConversationTargetsAtAdmission: async (targets) => [...targets],
      async *routeExecution() {
        throw new Error('The exposure fixture must not start another provider');
      },
      ackCollectedCursors: async () => {},
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  f.queueProcessor.adoptExposedQueuedEntries = processor.adoptExposedQueuedEntries.bind(processor);
  return { tracker, processor };
}

/** Exercise the production full-body adoption producer, without another message-custody ledger. */
export async function exposeDotAskToLive(
  f: Fixture,
  input: { threadId: string; invocationId: string; messageId: string; startedAt: number },
) {
  const { tracker, processor } = dotLiveQueueProcessor(f);
  tracker.start(input.threadId, 'codex', 'owner', ['codex'], input.invocationId);
  const response = f.messages.append({
    userId: 'owner',
    threadId: input.threadId,
    from: { kind: 'agent', catId: createCatId('codex') },
    content: '',
    mentions: [],
    timestamp: input.startedAt,
    origin: 'stream',
    lifecycle: {
      kind: 'response',
      orderKey: `${input.startedAt}:${input.invocationId}`,
      invocationId: input.invocationId,
      targetId: 'codex',
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt: input.startedAt,
    },
  });
  assert.equal(
    tracker.bindLifecycleActiveRun(
      {
        threadId: input.threadId,
        targetId: 'codex',
        invocationId: input.invocationId,
        responseMessageId: response.id,
        inputEntryIds: [],
        inputMessageIds: [],
        privateInputEntryIds: [],
        startedAt: input.startedAt,
      },
      input.invocationId,
    ),
    true,
  );
  const entry = f.queue.list(input.threadId, 'owner').find((row) => row.payload.messageId === input.messageId);
  assert.ok(entry);
  assert.equal(
    (
      await processor.adoptExposedQueuedEntries({
        threadId: input.threadId,
        userId: 'owner',
        catId: 'codex',
        invocationId: input.invocationId,
        entries: [{ entryId: entry.id, messageId: input.messageId }],
        seenAt: input.startedAt + 1,
      })
    ).outcome,
    'adopted',
  );
  return { response, tracker, processor };
}
