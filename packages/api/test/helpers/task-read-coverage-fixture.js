import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { invokeSingleCat } from '../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { callbacksRoutes } from '../../dist/routes/callbacks.js';
import { taskNativeCallbackFixture } from './task-native-callback-fixture.js';

/** Real read routes, Queue/Message transactions and native Task admission; no external model or runtime data. */
export async function taskReadCoverageFixture(t, redis) {
  const f = await taskNativeCallbackFixture(t, redis);
  const tracker = new InvocationTracker();
  const seed = await f.registry.create('native-user', 'sonnet', f.child.id, 'seed-parent');
  await f.turns.createRunning({
    ...seed,
    parentInvocationId: 'seed-parent',
    userId: 'native-user',
    threadId: f.child.id,
    catId: 'sonnet',
    executionKind: 'ordinary',
    startedAt: Date.now(),
  });
  tracker.start(f.child.id, 'sonnet', 'native-user', ['sonnet'], 'seed-parent');
  const response = await f.messages.append({
    userId: 'native-user',
    threadId: f.child.id,
    from: { kind: 'agent', catId: 'sonnet' },
    content: '',
    mentions: [],
    timestamp: Date.now(),
    lifecycle: {
      kind: 'response',
      orderKey: 'seed',
      invocationId: seed.invocationId,
      targetId: 'sonnet',
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt: Date.now(),
    },
  });
  tracker.bindLifecycleActiveRun(
    {
      threadId: f.child.id,
      targetId: 'sonnet',
      invocationId: seed.invocationId,
      responseMessageId: response.id,
      inputEntryIds: [],
      inputMessageIds: [],
      privateInputEntryIds: [],
      startedAt: Date.now(),
    },
    'seed-parent',
  );
  const sent = await f.send({
    threadId: f.child.id,
    effectClass: 'assign_work',
    action: undefined,
    proposedAction: f.action,
  });
  assert.equal(sent.statusCode, 200, sent.body);
  const sourceId = (await f.tasks.get(f.task.id)).lastAppliedHandoffMessageRef.slice('message:'.length);
  const [entry] = (await f.queue.getDurableEntriesForMessages(f.child.id, [sourceId])).get(sourceId) ?? [];
  assert.ok(entry);
  const errors = [];
  let releaseProvider;
  const providerRelease = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  t.after(releaseProvider);
  let enterProvider;
  const providerEntered = new Promise((resolve) => {
    enterProvider = resolve;
  });
  const executions = [];
  const waitForIdle = async () => {
    const deadline = Date.now() + 5000;
    while (tracker.getActiveSlots(f.child.id).length) {
      if (Date.now() > deadline) throw new Error('native Task fixture did not release its active run');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  t.after(async () => {
    releaseProvider();
    if (executions.length) await waitForIdle();
    else tracker.complete(f.child.id, 'sonnet');
  });
  const service = {
    async *invoke(_prompt, options) {
      const env = options.callbackEnv;
      const binding = structuredClone((await f.tasks.get(f.task.id)).executionRef);
      const update = await readApp.inject({
        method: 'POST',
        url: '/api/callbacks/update-task',
        headers: { 'x-invocation-id': env.CAT_CAFE_INVOCATION_ID, 'x-callback-token': env.CAT_CAFE_CALLBACK_TOKEN },
        payload: { taskId: f.task.id, status: 'doing', expectedOwnerRevision: 0 },
      });
      executions.push({ binding, statusCode: update.statusCode, body: update.body });
      enterProvider();
      await providerRelease;
      yield { type: 'done', catId: env.CAT_CAFE_CAT_ID, timestamp: Date.now() };
    },
  };
  const router = {
    async resolveExplicitTargets(targets) {
      return targets;
    },
    async resolveConversationTargetsAtAdmission(targets) {
      return targets;
    },
    async ackCollectedCursors() {},
    async *routeExecution(userId, prompt, threadId, messageId, targets, _intent, options) {
      yield* invokeSingleCat(
        {
          registry: f.registry,
          threadStore: null,
          messageStore: f.messages,
          turnExecutionStore: f.turns,
          ordinaryTaskHandoffs: f.handoffs,
          apiUrl: 'http://fixture.invalid',
          sessionManager: {
            async get() {},
            async getOrCreate() {
              return {};
            },
            async store() {},
            async delete() {},
            resolveWorkingDirectory() {
              return process.cwd();
            },
          },
        },
        {
          catId: targets[0],
          userId,
          threadId,
          prompt,
          service,
          isLastCat: true,
          signal: options.signalForCat?.(targets[0]) ?? options.signal,
          parentInvocationId: options.parentInvocationId,
          a2aTriggerMessageId: messageId,
          executionCausal: { triggerMessageId: messageId },
          onLifecycleInvocationStarted: options.onLifecycleInvocationStarted,
          onPromptMessagesExposed: options.onPromptMessagesExposed,
        },
      );
    },
  };
  const processorFor = (queue) =>
    new QueueProcessor({
      queue,
      invocationTracker: tracker,
      invocationRecordStore: f.invocationRecords,
      router,
      messageStore: f.messages,
      turnExecutionStore: f.turns,
      taskStore: f.tasks,
      ordinaryTaskHandoffs: f.handoffs,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      log: {
        info() {},
        warn() {},
        error(...args) {
          errors.push(args);
        },
      },
    });
  const processor = processorFor(f.queue);
  const readApp = Fastify();
  t.after(() => readApp.close());
  await readApp.register(callbacksRoutes, {
    registry: f.registry,
    messageStore: f.messages,
    threadStore: f.threads,
    taskStore: f.tasks,
    turnExecutionStore: f.turns,
    invocationQueue: f.queue,
    invocationTracker: tracker,
    queueProcessor: processor,
    ordinaryTaskHandoffs: f.handoffs,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
  });
  const headers = { 'x-invocation-id': seed.invocationId, 'x-callback-token': seed.callbackToken };
  const addOrdinary = (targets = ['sonnet']) =>
    f.queue.send(
      f.messages,
      {
        userId: 'native-user',
        threadId: f.child.id,
        from: { kind: 'agent', catId: 'codex' },
        content: 'ordinary published context',
        mentions: targets,
        timestamp: Date.now(),
      },
      {
        kind: 'message_wake',
        userId: 'native-user',
        threadId: f.child.id,
        from: { kind: 'agent', catId: 'codex' },
        content: 'ordinary published context',
        targetCats: targets,
        sourceCategory: 'a2a',
        ownerAuthProvenance: 'strict',
        intent: 'execute',
        autoExecute: true,
        messageDisposition: 'next_work',
      },
    );
  const finishSeed = async () => {
    await f.turns.transitionTerminal(seed.invocationId, {
      status: 'succeeded',
      endedAt: Date.now(),
      providerTeardownAt: Date.now(),
    });
    await f.messages.commitLifecycleResponseTerminal(response.id, {
      invocationId: seed.invocationId,
      status: 'succeeded',
      completedAt: Date.now(),
      content: '',
      mentions: [],
    });
    tracker.complete(f.child.id, 'sonnet');
  };
  const restart = async () => {
    const queue = new InvocationQueue(f.queue.ledgerStore);
    await queue.hydrateFromLedger(f.messages);
    return { queue, processor: processorFor(queue) };
  };
  return {
    ...f,
    tracker,
    processor,
    readApp,
    headers,
    seed,
    response,
    sourceId,
    entry,
    addOrdinary,
    finishSeed,
    restart,
    providerEntered,
    releaseProvider,
    waitForIdle,
    executions,
    errors,
  };
}
