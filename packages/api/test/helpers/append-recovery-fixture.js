import { mock } from 'node:test';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InvocationRecordStore } from '../../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './message-from-fixtures.js';

export async function appendRecoveryFixture(
  dispatch,
  {
    messageStore = new MessageStore(),
    ledgerStore,
    visibility,
    inspectInput,
    from = { kind: 'user', userId: 'owner' },
    content = 'one original input',
    inputCompletionReceipt = false,
    routeExecution = async function* () {},
  } = {},
) {
  const invocationTracker = new InvocationTracker();
  invocationTracker.start('thread', 'opus', 'owner', ['opus'], 'parent');
  const queue = new InvocationQueue(ledgerStore, {
    invocationTracker,
    resolveTargets: async (targets) => targets,
    resolveCarrierCapability: () => ({
      provider: 'anthropic',
      carrier: 'claude_agent_sdk',
      activeInvocationGuidance: 'supported',
      deliverySemantics: 'exact_active_turn',
    }),
  });
  const admission = await queue.send(
    messageStore,
    canonicalTestMessageInput({
      from,
      userId: 'owner',
      threadId: 'thread',
      catId: null,
      content,
      mentions: ['opus'],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
      ...(visibility === 'whisper' ? { visibility, whisperTo: ['opus'] } : {}),
    }),
    canonicalTestQueueInput({
      from,
      userId: 'owner',
      threadId: 'thread',
      kind: from.kind === 'agent' ? 'message_wake' : 'conversation_input',
      ownerAuthProvenance: 'strict',
      content,
      targetCats: ['opus'],
      intent: 'execute',
      autoExecute: true,
      sourceId: 'source',
    }),
  );
  const startedAt = Date.now();
  const response = await messageStore.append({
    from: { kind: 'agent', catId: 'opus' },
    userId: 'owner',
    threadId: 'thread',
    content: '',
    mentions: [],
    timestamp: startedAt,
    lifecycle: {
      kind: 'response',
      orderKey: `${startedAt}:turn`,
      invocationId: 'turn',
      targetId: 'opus',
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt,
    },
  });
  invocationTracker.bindLifecycleActiveRun(
    {
      threadId: 'thread',
      targetId: 'opus',
      invocationId: 'turn',
      responseMessageId: response.id,
      inputEntryIds: [],
      inputMessageIds: [],
      privateInputEntryIds: [],
      startedAt,
    },
    'parent',
  );
  invocationTracker.bindAgentClientActiveRunDispatcher('thread', 'opus', {
    invocationId: 'turn',
    capabilities: {
      append: true,
      steer: true,
      inputReadReceipt: true,
      ...(inputCompletionReceipt ? { inputCompletionReceipt } : {}),
    },
    handle: { provider: 'anthropic', carrier: 'claude_agent_sdk', threadId: 'native-thread', turnId: 'native-turn' },
    dispatch,
    ...(inspectInput ? { inspectInput } : {}),
  });
  const processor = recoveryProcessor({ queue, invocationTracker, messageStore, routeExecution });
  const append = () =>
    processor.appendExactEntry({
      threadId: 'thread',
      userId: 'owner',
      entryId: admission.entry.id,
      expectedQueueRevision: queue.snapshotRevision('thread', 'owner'),
      expectedRuns: [{ targetId: 'opus', invocationId: 'turn', responseMessageId: response.id }],
    });
  return { messageStore, invocationTracker, queue, processor, admission, response, append };
}

export function recoveryProcessor({
  queue,
  invocationTracker = new InvocationTracker(),
  messageStore,
  routeExecution = async function* () {},
}) {
  return new QueueProcessor({
    queue,
    invocationTracker,
    messageStore,
    invocationRecordStore: new InvocationRecordStore(),
    router: {
      resolveExplicitTargets: mock.fn(async (targets) => targets),
      resolveConversationTargetsAtAdmission: mock.fn(async (targets) => targets),
      routeExecution: mock.fn(routeExecution),
      ackCollectedCursors: mock.fn(async () => {}),
    },
    socketManager: { broadcastAgentMessage: mock.fn(), broadcastToRoom: mock.fn(), emitToUser: mock.fn() },
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
  });
}
