import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { createSqliteHoldQuotaStore } from '../dist/domains/ball-custody/hold-quota-store.js';
import { ManagedCommandWakeRecoverySweep } from '../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js';
import { createManagedCommandWakeAdmission } from '../dist/domains/ball-custody/managed-command-wake-admission.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { AgentRegistry } from '../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { createWorkAuthorizer } from '../dist/domains/collaborative-content/works/access.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { PublishedMediaAccess } from '../dist/domains/video-studio/content-owner/published-media-access.js';
import { DynamicTaskStore } from '../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { reminderTemplate } from '../dist/infrastructure/scheduler/templates/reminder.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { cancelWakeWhenRunner, registerCallbackHoldBallRoutes } from '../dist/routes/callback-hold-ball-routes.js';
import { registerLivingWorkRoutes } from '../dist/routes/living-work-routes.js';
import { isolateManagedJobData } from './helpers/isolated-managed-job-data.js';
import { workCatalogueFixture } from './helpers/work-catalogue-fixture.js';

isolateManagedJobData();

const restricted = {
  mode: 'callback_allowlist',
  allowedCallbackRoutes: ['GET /api/callbacks/thread-context', 'POST /api/callbacks/hold-ball'],
};
const legacyPolicy = { mode: 'read_only', replayDeniedToolNames: [] };
const cases = [
  { name: 'strict', authorization: { ownerAuthProvenance: 'strict' } },
  { name: 'compatibility', authorization: { ownerAuthProvenance: 'compatibility_fallback' } },
  { name: 'unknown', authorization: { ownerAuthProvenance: 'unknown' } },
  { name: 'restricted', authorization: { ownerAuthProvenance: 'strict', toolExecutionPolicy: restricted } },
  { name: 'legacy', authorization: 'strict', expectedPolicy: legacyPolicy },
  {
    name: 'work-allowed',
    authorization: {
      ownerAuthProvenance: 'strict',
      toolExecutionPolicy: {
        mode: 'callback_allowlist',
        allowedCallbackRoutes: ['POST /api/callbacks/hold-ball', 'POST /api/callbacks/work'],
      },
    },
  },
];

async function waitFor(predicate) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'actual Queue/Router execution did not reach the expected boundary');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Real scheduler receipt -> shared composition port -> QueueProcessor -> AgentRouter ->
// invokeSingleCat -> callback auth. Only the model provider is controlled; it stays alive
// while its real credentials are checked, then finishes without network or a CLI process.
for (const scenario of cases) {
  test(`managed completion preserves ${scenario.name} authority through actual receiver authentication`, async (t) => {
    const db = new Database(':memory:');
    applyMigrations(db);
    t.after(() => db.close());
    const tasks = new DynamicTaskStore(db);
    const messages = new MessageStore();
    const threads = new ThreadStore();
    const thread = threads.create('owner', 'managed wake authority');
    const registry = new InvocationRegistry();
    const works = await workCatalogueFixture(t);
    works.setAuthorize(
      createWorkAuthorizer({
        ownerUserId: 'owner',
        access: new PublishedMediaAccess({ tasks: new TaskStore(), threads }),
        invocation: (id) => registry.peekRecord(id),
      }),
    );
    const savedWork = await works.create('held-work', thread.id);
    const tracker = new InvocationTracker();
    const turns = new InMemoryTurnExecutionStore();
    const records = new InvocationRecordStore();
    const agents = new AgentRegistry();
    const observed = [];
    let release;
    const providerDone = new Promise((resolve) => {
      release = resolve;
    });
    agents.register('opus', {
      supportsToolExecutionPolicy: () => true,
      async *invoke(_prompt, options) {
        observed.push(options);
        await providerDone;
        yield { type: 'done', catId: 'opus', invocationId: options.invocationId, timestamp: Date.now() };
      },
    });
    const router = new AgentRouter({
      agentRegistry: agents,
      registry,
      messageStore: messages,
      threadStore: threads,
      turnExecutionStore: turns,
    });
    const queue = new InvocationQueue(undefined, {
      resolveTargets: (targets, threadId, content, exact) =>
        router.resolveSendTargets(targets, threadId, content, exact),
    });
    const errors = [];
    const processor = new QueueProcessor({
      queue,
      router,
      invocationTracker: tracker,
      messageStore: messages,
      invocationRecordStore: records,
      turnExecutionStore: turns,
      socketManager: { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} },
      log: { info() {}, warn() {}, error: (...args) => errors.push(args) },
    });
    const app = Fastify();
    await registerLivingWorkRoutes(app, { service: works.service, registry });
    registerCallbackAuthHook(app, registry);
    app.get('/api/callbacks/thread-context', async () => ({ ok: true }));
    app.post('/api/callbacks/post-message', async () => ({ ok: true }));
    t.after(async () => {
      release();
      await waitFor(() => !tracker.has(thread.id, 'opus'));
      await app.close();
    });
    const admitWake = createManagedCommandWakeAdmission({
      queue,
      messageStore: messages,
      notifyAdmitted: async () => {},
    });
    const sweep = new ManagedCommandWakeRecoverySweep({
      dynamicTaskStore: tasks,
      messageStore: messages,
      invocationRecordStore: records,
      taskRunner: { unregister() {} },
      socketManager: { broadcastToRoom() {} },
      admitWake,
    });
    let taskId;
    if (scenario.name === 'legacy') {
      taskId = 'hold-ball-private-auth';
      tasks.insert(
        {
          id: taskId,
          templateId: 'reminder',
          trigger: { type: 'once', fireAt: Date.now() + 60_000 },
          params: {
            message: 'fallback',
            triggerUserId: 'owner',
            targetCatId: 'opus',
            // Public fields cannot upgrade unknown/compatibility or erase private restrictions.
            ownerAuthProvenance: 'strict',
            toolExecutionPolicy: null,
            holdLifecycle: {
              mode: 'wake_when',
              status: 'active',
              wakeAt: Date.now() + 60_000,
              managedCommand: { state: 'command_running', command: 'fixture-command', startedAt: Date.now() },
            },
          },
          display: { label: 'hold', category: 'system' },
          deliveryThreadId: thread.id,
          enabled: true,
          createdBy: 'hold-ball:opus',
          createdAt: new Date().toISOString(),
        },
        scenario.authorization,
      );
      await sweep.recordCompletion({
        taskId,
        wakeContent: 'legacy held command finished',
        result: { exitCode: 0, timedOut: false, durationMs: 1 },
      });
    } else {
      const quota = createSqliteHoldQuotaStore(':memory:');
      t.after(() => quota.close());
      t.after(() => cancelWakeWhenRunner(thread.id, 'opus'));
      registerCallbackHoldBallRoutes(app, {
        registry,
        dynamicTaskStore: tasks,
        messageStore: messages,
        threadStore: threads,
        ownerUserId: 'owner',
        holdQuotaStore: quota,
        invocationRecordStore: records,
        managedCommandWakeRecovery: sweep,
        admitManagedWake: admitWake,
        taskRunner: { registerDynamic() {}, unregister() {} },
        templateRegistry: { get: () => reminderTemplate },
        socketManager: { broadcastToRoom() {} },
      });
      const original = await registry.create(
        'owner',
        'opus',
        thread.id,
        undefined,
        undefined,
        scenario.authorization.toolExecutionPolicy,
        undefined,
        scenario.authorization.ownerAuthProvenance,
      );
      const registered = await app.inject({
        method: 'POST',
        url: '/api/callbacks/hold-ball',
        headers: { 'x-invocation-id': original.invocationId, 'x-callback-token': original.callbackToken },
        payload: {
          reason: 'verify held command authority',
          nextStep: 'read the original work',
          wakeWhen: { command: 'printf managed-wake-auth', timeoutMs: 5000 },
        },
      });
      assert.equal(registered.statusCode, 200, registered.body);
      taskId = registered.json().taskId;
      await registry.commitTerminal({
        invocationId: original.invocationId,
        disposition: 'completed',
        endedAt: Date.now(),
        endReason: 'original registering invocation completed',
      });
      await waitFor(() => queue.list(thread.id, 'owner').length === 1);
      assert.equal(tasks.getById(taskId).params.holdLifecycle.managedCommand.result.exitCode, 0);
    }
    const [entry] = queue.list(thread.id, 'owner');
    assert.ok(entry, 'completion must durably admit its one Queue input');
    const expectedGrade =
      typeof scenario.authorization === 'string' ? scenario.authorization : scenario.authorization.ownerAuthProvenance;
    const expectedPolicy = scenario.expectedPolicy ?? scenario.authorization.toolExecutionPolicy;
    assert.equal(entry.execution.ownerAuthProvenance, expectedGrade);
    assert.deepEqual(entry.execution.readOnlyToolPolicy, expectedPolicy);
    assert.equal(Object.hasOwn(messages.getById(entry.payload.messageId), 'ownerAuthProvenance'), false);
    assert.equal((await processor.processNext(thread.id, 'owner')).started, true);
    await waitFor(() => observed.length === 1 || errors.length > 0);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.equal(observed.length, 1);
    const env = observed[0].callbackEnv;
    const verified = await registry.verify(env.CAT_CAFE_INVOCATION_ID, env.CAT_CAFE_CALLBACK_TOKEN);
    assert.equal(verified.ok, true);
    assert.equal(verified.record.ownerAuthProvenance, expectedGrade);
    assert.deepEqual(verified.record.toolExecutionPolicy, expectedPolicy);
    const headers = { 'x-invocation-id': env.CAT_CAFE_INVOCATION_ID, 'x-callback-token': env.CAT_CAFE_CALLBACK_TOKEN };
    const listed = await app.inject({
      method: 'POST',
      url: '/api/callbacks/work',
      headers,
      payload: { command: { action: 'list' } },
    });
    assert.equal(
      listed.statusCode,
      scenario.name === 'strict' || scenario.name === 'work-allowed' ? 200 : 403,
      listed.body,
    );
    if (listed.statusCode === 200) assert.ok(listed.json().json.includes(savedWork.reference.contentRef));
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/callbacks/thread-context', headers })).statusCode,
      scenario.name === 'legacy' || scenario.name === 'work-allowed' ? 403 : 200,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/callbacks/post-message', headers })).statusCode,
      expectedPolicy ? 403 : 200,
    );
    release();
    await waitFor(() => !tracker.has(thread.id, 'opus'));
    await sweep.runOnce();
    assert.equal(observed.length, 1, 'an already consumed completion must not acquire a new invocation');
    assert.equal(queue.list(thread.id, 'owner').length, 0);
  });
}
