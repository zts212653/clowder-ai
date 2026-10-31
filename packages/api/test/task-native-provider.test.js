import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { taskNativeCallbackFixture } from './helpers/task-native-callback-fixture.js';

async function until(predicate) {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for exact provider lifecycle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
test('real callback → Queue → provider: stop exact writer before successor, source replay/restart creates no approval or second writer', async (t) => {
  const f = await taskNativeCallbackFixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'task-native-provider-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'writer.txt');
  const tracker = new InvocationTracker();
  let writerCount = 0,
    maximumWriters = 0,
    started = 0,
    closed = 0;
  let complete = false;
  const errors = [];
  const service = {
    async *invoke(_prompt, options) {
      writerCount++;
      started++;
      maximumWriters = Math.max(maximumWriters, writerCount);
      const env = options.callbackEnv;
      await appendFile(file, `${env.CAT_CAFE_CAT_ID}\n`);
      const timer = setInterval(() => {
        void appendFile(file, `${env.CAT_CAFE_CAT_ID}\n`);
      }, 5);
      try {
        yield { type: 'text', catId: env.CAT_CAFE_CAT_ID, content: 'working', timestamp: Date.now() };
        if (complete) {
          const done = await f.app.inject({
            method: 'POST',
            url: '/api/callbacks/update-task',
            headers: { 'x-invocation-id': env.CAT_CAFE_INVOCATION_ID, 'x-callback-token': env.CAT_CAFE_CALLBACK_TOKEN },
            payload: { taskId: f.task.id, status: 'done' },
          });
          assert.equal(done.statusCode, 200, done.body);
        } else if (!options.signal.aborted) {
          await new Promise((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }));
        }
        yield { type: 'done', catId: env.CAT_CAFE_CAT_ID, timestamp: Date.now() };
      } finally {
        clearInterval(timer);
        writerCount--;
        closed++;
      }
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
    async *routeExecution(userId, prompt, threadId, sourceId, targets, _intent, options) {
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
              return dir;
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
          a2aTriggerMessageId: sourceId,
          executionCausal: { triggerMessageId: sourceId },
          onLifecycleInvocationStarted: options.onLifecycleInvocationStarted,
        },
      );
    },
  };
  const processor = new QueueProcessor({
    queue: f.queue,
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
  const first = await f.send({
    threadId: f.child.id,
    effectClass: 'assign_work',
    action: undefined,
    proposedAction: f.action,
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal((await processor.processNext(f.child.id, 'native-user')).started, true);
  await until(() => writerCount === 1);
  const oldRef = f.tasks.get(f.task.id).executionRef;
  assert.ok(f.turns.get(oldRef.invocationId)?.providerStartedAt);
  const second = await f.send({ clientMessageId: 'second-native-handoff', targetCats: ['codex'] });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal((await processor.processNext(f.home.id, 'native-user')).started, false);
  assert.equal(started, 1);
  tracker.cancelExact(oldRef.threadId, oldRef.catId, oldRef.parentInvocationId, 'native-user', 'task_handoff');
  await until(() => closed === 1 && f.tasks.get(f.task.id)?.executionRef == null);
  const oldTurn = f.turns.get(oldRef.invocationId);
  assert.ok(oldTurn.providerTeardownAt);
  const size = (await readFile(file, 'utf8')).length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await readFile(file, 'utf8')).length, size, 'stopped provider must stop writing the actual file');
  complete = true;
  assert.equal((await processor.processNext(f.home.id, 'native-user')).started, true, JSON.stringify(errors));
  await until(() => f.tasks.get(f.task.id)?.status === 'done' && closed === 2);
  assert.equal(maximumWriters, 1);
  assert.equal(started, 2);
  assert.deepEqual(f.counts(), { proposalCreates: 0, cards: 0, leaseCalls: 0 });
});
