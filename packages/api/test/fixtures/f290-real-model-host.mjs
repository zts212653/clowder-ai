import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import Redis from 'ioredis';
import { InvocationQueue } from '../../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { InvocationTracker } from '../../src/domains/cats/services/agents/invocation/InvocationTracker.ts';
import { QueuedMessageCustodyCoordinator } from '../../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.ts';
import { QueueProcessor } from '../../src/domains/cats/services/agents/invocation/QueueProcessor.ts';
import { RedisAuthInvocationBackend } from '../../src/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.ts';
import { CodexAgentService } from '../../src/domains/cats/services/agents/providers/CodexAgentService.ts';
import { AgentRegistry } from '../../src/domains/cats/services/agents/registry/AgentRegistry.ts';
import { AgentRouter } from '../../src/domains/cats/services/agents/routing/AgentRouter.ts';
import { RedisInvocationRecordStore } from '../../src/domains/cats/services/stores/redis/RedisInvocationRecordStore.ts';
import { RedisMessageStore } from '../../src/domains/cats/services/stores/redis/RedisMessageStore.ts';
import { RedisTaskStore } from '../../src/domains/cats/services/stores/redis/RedisTaskStore.ts';
import { RedisThreadStore } from '../../src/domains/cats/services/stores/redis/RedisThreadStore.ts';
import { RedisTurnExecutionStore } from '../../src/domains/cats/services/stores/redis/RedisTurnExecutionStore.ts';
import { F232PreparedArtifactReader } from '../../src/domains/growing/F232PreparedArtifactReader.ts';
import { CollectiveCurrentContext } from '../../src/domains/plugin/builtin-runtime/collective-current-context.ts';
import { CollectiveIngressDispatcher } from '../../src/domains/plugin/builtin-runtime/collective-ingress-dispatcher.ts';
import { resolveCollectiveStandingGrant } from '../../src/domains/plugin/builtin-runtime/collective-standing-grant.ts';
import { CollectiveWorkAdmission } from '../../src/domains/plugin/builtin-runtime/collective-work/collective-work-admission.ts';
import { CollectiveWorkAuthority } from '../../src/domains/plugin/builtin-runtime/collective-work-authority.ts';
import { CollectiveWorkDispatcher } from '../../src/domains/plugin/builtin-runtime/collective-work-dispatcher.ts';
import { CollectiveWorkResultReconciler } from '../../src/domains/plugin/builtin-runtime/collective-work-result-reconciler.ts';
import { CollectiveWorkRevisionReconciler } from '../../src/domains/plugin/builtin-runtime/collective-work-revision-reconciler.ts';
import { resolveCollectiveWorkThread } from '../../src/domains/plugin/builtin-runtime/collective-work-thread.ts';
import { registerCollectiveParticipationCallbacks } from '../../src/routes/callback-collective-participation-routes.ts';
import { registerCallbackDocsRoutes } from '../../src/routes/callback-docs-routes.ts';
import { callbacksRoutes } from '../../src/routes/callbacks.ts';
import { uploadsRoutes } from '../../src/routes/uploads.ts';
import { visibleMessageEvidence } from './f290-real-model-evidence.mjs';
import { registerModelOwnerRead } from './f290-real-model-owner-read.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Two actual Host compositions; no scripted Cat or fake running-turn record. */
export async function createModelHost(world, cafe, db, config, evidence) {
  assert.equal(process.env.CAT_CAFE_REDIS_TEST_ISOLATED, '1');
  const redisUrl = new URL(process.env.REDIS_URL);
  assert.ok(![6397, 6398, 6399, 6401].includes(Number(redisUrl.port)));
  assert.equal(redisUrl.hostname, '127.0.0.1');
  redisUrl.pathname = `/${db}`;
  const redis = new Redis(redisUrl.href);
  await redis.ping();
  const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
  const threads = new RedisThreadStore(redis, { ttlSeconds: 0 });
  const tasks = new RedisTaskStore(redis, { ttlSeconds: 0 });
  const turns = new RedisTurnExecutionStore(redis);
  const parents = new RedisInvocationRecordStore(redis);
  world.attachTurns(cafe.label, turns);
  const catId = createCatId(world.catId);
  const endpoint = await threads.create(
    cafe.ownerUserId,
    `Fixture Cafe ${cafe.label} Collective`,
    process.env.F290_REAL_MODEL_REPO,
  );
  await threads.addParticipants(endpoint.id, [catId]);
  const participationRevision = await world.configure(cafe, endpoint);
  const authority = new CollectiveWorkAuthority({
    messageStore: messages,
    taskStore: tasks,
    resolveWorkThread: (source, id) => resolveCollectiveWorkThread(threads, tasks, source, id),
    standingGrant: (source, id) => resolveCollectiveStandingGrant(cafe.connector, source, id),
  });
  const context = new CollectiveCurrentContext({
    connector: () => cafe.connector,
    messageStore: messages,
    threadStore: threads,
    workAuthority: authority,
    artifactReader: new F232PreparedArtifactReader({ messages }),
    artifactUploadDir: process.env.UPLOAD_DIR,
  });
  const registry = new InvocationRegistry({
    backend: new RedisAuthInvocationBackend(redis),
    turnExecutionStore: turns,
    onLifecycleSignal: (signal) =>
      evidence.authLifecycles.push({
        cafe: cafe.label,
        invocationId: signal.invocationId,
        kind: signal.kind,
        disposition: signal.disposition,
        attempted: signal.attempted,
        existing: signal.existing,
      }),
  });
  registry.setCollectiveWorkAuthorityValidator(async (record) => {
    if (!(await context.resolvePrivate(record, 'callback')))
      throw Object.assign(new Error('Current Collective Work authority is unavailable'), {
        code: 'WORK_EXECUTION_NOT_CURRENT',
      });
  });
  const app = Fastify({ logger: false });
  const callbackResponses = new Map();
  app.addHook('onSend', async (request, _reply, payload) => {
    if (request.url.startsWith('/api/callbacks/') && typeof payload === 'string') {
      try {
        callbackResponses.set(request.id, JSON.parse(payload));
      } catch {}
    }
    return payload;
  });
  app.addHook('onResponse', async (request, reply) => {
    if (!request.url.startsWith('/api/callbacks/')) return;
    const invocationId = request.headers['x-invocation-id'];
    const turn = typeof invocationId === 'string' ? await turns.get(invocationId) : null;
    evidence.callbacks.push({
      cafe: cafe.label,
      path: request.url.split('?')[0],
      invocationId,
      status: reply.statusCode,
      turnStatus: turn?.status,
      input: request.body,
      response: callbackResponses.get(request.id),
    });
    callbackResponses.delete(request.id);
  });
  const frames = [];
  const sockets = {
    emitToUser() {},
    broadcastToRoom() {},
    broadcastAgentMessage(frame) {
      frames.push(frame);
      evidence.frames.push({
        cafe: cafe.label,
        type: frame.type,
        catId: frame.catId,
        invocationId: frame.invocationId,
        turnInvocationId: frame.turnInvocationId,
        metadata: frame.metadata,
        error: frame.error,
        errorCode: frame.errorCode,
        errorDisposition: frame.errorDisposition,
        label: frame.label,
        toolName: frame.toolName,
        content: frame.content?.slice(0, 2000),
      });
    },
  };
  const agentRegistry = new AgentRegistry();
  agentRegistry.register(catId, new CodexAgentService({ catId, cliCommand: config.cli?.command ?? 'codex' }));
  const router = new AgentRouter({
    agentRegistry,
    registry,
    messageStore: messages,
    threadStore: threads,
    taskStore: tasks,
    turnExecutionStore: turns,
    collectiveContext: () => context,
  });
  let callbackUrl = '';
  const originalStrategyDeps = router.getStrategyDeps.bind(router);
  // index.ts has a process-wide API port. In-process dual Hosts need instance-local callback URLs.
  router.getStrategyDeps = () => {
    const deps = originalStrategyDeps();
    return { ...deps, invocationDeps: { ...deps.invocationDeps, apiUrl: callbackUrl } };
  };
  const queue = new InvocationQueue();
  const tracker = new InvocationTracker();
  const queueProcessor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    invocationRecordStore: parents,
    router,
    messageStore: messages,
    queueCustodyCoordinator: new QueuedMessageCustodyCoordinator({ messageStore: messages }),
    turnExecutionStore: turns,
    socketManager: sockets,
    log: {
      info() {},
      warn(value, message) {
        evidence.logs.push({ cafe: cafe.label, level: 'warn', message, detail: safeError(value) });
      },
      error(value, message) {
        evidence.logs.push({ cafe: cafe.label, level: 'error', message, detail: safeError(value) });
      },
    },
  });
  const dispatcher = new CollectiveWorkDispatcher({
    context: () => context,
    messageStore: messages,
    threadStore: threads,
    invocationQueue: queue,
    queueProcessor,
  });
  const admission = new CollectiveWorkAdmission({ connector: () => cafe.connector, authority, tasks, dispatcher });
  const revisionReconciler = new CollectiveWorkRevisionReconciler({ messages, tasks, dispatcher });
  const resultReconciler = new CollectiveWorkResultReconciler({ messages, tasks });
  const ingress = new CollectiveIngressDispatcher({
    connector: cafe.connector,
    threadStore: threads,
    messageStore: messages,
    invocationQueue: queue,
    queueProcessor,
    socketManager: sockets,
    isCatAvailable: (id) => id === catId,
    admitStandingWork: (source, id) => admission.admit(source, id),
    resumeWorkRevision: async (source, event) => {
      const notice = event.workRevisionNotice;
      const recipient = event.recipient;
      if (!notice || recipient?.kind !== 'agent' || event.actor.kind !== 'human')
        throw new Error('Invalid revision notice');
      return cafe.connector.withAssignedWorkAuthority(recipient.connectionId, notice.workId, async (scope) => {
        assert.equal(scope.hostRoute?.localOwnerUserId, source.userId);
        assert.equal(scope.connection.authorizedHumanId, event.actor.humanId);
        return revisionReconciler.reconcile({
          ownerUserId: source.userId,
          event,
          inbox: scope.inbox,
          work: scope.work,
        });
      });
    },
  });
  await app.register(callbacksRoutes, {
    registry,
    messageStore: messages,
    threadStore: threads,
    taskStore: tasks,
    socketManager: sockets,
    router,
    invocationRecordStore: parents,
    turnExecutionStore: turns,
    invocationTracker: tracker,
    invocationQueue: queue,
    queueProcessor,
    agentRegistry,
  });
  await registerCollectiveParticipationCallbacks(app, { registry, context });
  await registerModelOwnerRead(app, registry, cafe, tasks, messages, evidence);
  await app.register(registerCallbackDocsRoutes);
  await mkdir(process.env.UPLOAD_DIR, { recursive: true });
  await app.register(uploadsRoutes, { uploadDir: process.env.UPLOAD_DIR });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  callbackUrl = `http://127.0.0.1:${address.port}`;
  evidence.hosts.push({
    cafe: cafe.label,
    callbackUrl,
    publicThreadId: endpoint.id,
    redisDb: db,
    persistence: 'production Redis Message/Task/Thread/Turn/Auth/Invocation stores',
    startup: 'in-process composition, not index.ts',
  });
  const host = {
    cafe,
    messages,
    threads,
    tasks,
    turns,
    parents,
    registry,
    tracker,
    queue,
    queueProcessor,
    ingress,
    resultReconciler,
    endpoint,
    participationRevision,
    callbackUrl,
    frames,
    async tick() {
      await cafe.connector.sync(cafe.connectionId);
      return ingress.dispatchConnection(cafe.connectionId);
    },
    async idle() {
      const ids = [endpoint.id, ...(await tasks.listByKind('work')).map((task) => task.threadId)];
      return ids.every(
        (id) => !tracker.has(id) && queue.list(id, cafe.ownerUserId).every((entry) => entry.status !== 'processing'),
      );
    },
    async reconcile(work) {
      const rows = await tasks.listByKind('work');
      for (const task of rows) {
        const sourceRef = task.entrustedWork?.admission.sourceRefs[0];
        if (!sourceRef) continue;
        const source = await messages.getById(sourceRef.slice('message:'.length));
        if (source?.source?.meta?.eventId === work.assignmentEventId)
          return resultReconciler.reconcile({ ownerUserId: cafe.ownerUserId, sourceMessageId: source.id, work });
      }
      throw new Error('No exact private Task for current Work');
    },
    async snapshot() {
      const taskRows = await tasks.listByKind('work');
      const threadIds = [...new Set([endpoint.id, ...taskRows.map((task) => task.threadId)])];
      const messageRows = (
        await Promise.all(threadIds.map((id) => messages.getByThreadIncludingQueued(id, 200)))
      ).flat();
      const invocationIds = [...new Set(frames.map((frame) => frame.turnInvocationId).filter(Boolean))];
      return {
        cafe: cafe.label,
        tasks: taskRows,
        messages: messageRows.map(visibleMessageEvidence),
        turns: await Promise.all(invocationIds.map((id) => turns.get(id))),
      };
    },
    async abort() {
      for (const task of await tasks.listByKind('work')) tracker.cancelAll(task.threadId);
      tracker.cancelAll(endpoint.id);
    },
    async close() {
      await host.abort();
      await sleep(100);
      await app.close();
      await redis.quit();
    },
  };
  return host;
}

function safeError(value) {
  const error = value?.err ?? value;
  return { code: error?.code, message: error?.message, reason: error?.reason };
}
