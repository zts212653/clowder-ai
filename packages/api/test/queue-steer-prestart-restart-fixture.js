import { mock } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { StartupReconciler } = await import('../dist/domains/cats/services/agents/invocation/StartupReconciler.js');

export async function restartHarness(h) {
  const queue = new InvocationQueue();
  const tracker = new InvocationTracker();
  const routedContents = [];
  const log = { info: mock.fn(), warn: mock.fn(), error: mock.fn() };
  const invocationRecordStore = {
    scanByStatus: mock.fn(async () => []),
    get: mock.fn(async () => null),
    create: mock.fn(async () => ({ outcome: 'created', invocationId: 'inv-after-restart' })),
    update: mock.fn(async () => ({})),
  };
  const processor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    invocationRecordStore,
    messageStore: h.messageStore,
    socketManager: h.socketManager,
    router: {
      resolveExplicitTargets: mock.fn(async (requestedCatIds) => [...requestedCatIds]),
      resolveConversationTargetsAtAdmission: mock.fn(async (requestedCatIds) => [...requestedCatIds]),
      routeExecution: mock.fn(async function* (_userId, content, _threadId, _messageId, targetCats) {
        routedContents.push(content);
        yield { type: 'done', catId: targetCats[0], timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    },
    log,
  });
  const reconciler = new StartupReconciler({
    invocationRecordStore,
    invocationQueue: queue,
    messageStore: h.messageStore,
    taskProgressStore: { deleteSnapshot: mock.fn(async () => {}) },
    log: { info: mock.fn(), warn: mock.fn() },
    resumePrestartRetirement: (entries) => processor.resumeDurablePrestartRetirement(entries),
    resumeQueue: (threadId, userId) => processor.processNext(threadId, userId),
  });
  await reconciler.reconcileOrphans();
  return { queue, tracker, processor, reconciler, routedContents, invocationRecordStore, log };
}
