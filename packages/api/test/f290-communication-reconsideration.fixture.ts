import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { collectiveSourceIdentitySchema } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueuedMessageCustodyCoordinator } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueProcessor } from '../src/domains/cats/services/agents/invocation/QueueProcessor.js';
import { registerCollectiveParticipationCallbacks } from '../src/routes/callback-collective-participation-routes.js';
import { registerCollectiveOwnerWorkReconsiderationRoutes } from '../src/routes/collective-owner-work-reconsideration.js';
import { fixture as manualFixture } from './f290-communication-manual-admission.fixture.js';
import { ownerPolicy, workOf } from './f290-communication-validation.harness.js';
import { CAT } from './f290-communication-validation.host.js';

/** Real QueueProcessor/Registry/current-context/Connector/Service. Only owner session, model and invocation-record store are fixtures. */
export async function fixture() {
  const f = await manualFixture();
  const queue = new InvocationQueue();
  const registry = new InvocationRegistry();
  const records = new Map<string, Record<string, unknown>>();
  const runs: string[] = [];
  const logs: string[] = [];
  let enabled = false;
  const reconsiderHooks: { beforeThreadRead?: () => Promise<void> } = {};
  const router = {
    async *routeExecution(
      userId: string,
      _content: string,
      threadId: string,
      messageId: string | null,
      cats: string[],
      _intent: unknown,
      options?: Record<string, unknown>,
    ) {
      assert.equal(cats[0], CAT);
      assert.ok(messageId);
      const trigger = await f.host.messages.getById(messageId);
      assert.ok(trigger);
      const source = collectiveSourceIdentitySchema.parse(trigger.source?.meta?.participation);
      await (options?.onPromptMessagesExposed as (input: unknown) => Promise<unknown>)?.({
        threadId,
        userId,
        catId: CAT,
        invocationId: String(options?.parentInvocationId),
        messageIds: [trigger.id],
        seenAt: Date.now(),
      });
      const created = await registry.create(
        userId,
        CAT,
        threadId,
        undefined,
        undefined,
        { mode: 'collective_participation' },
        trigger.id,
        'unknown',
        undefined,
        { kind: 'collective-participation', originTriggerMessageId: trigger.id, source },
      );
      const verified = await registry.verify(created.invocationId, created.callbackToken);
      assert.ok(verified.ok);
      f.world.turns.set(created.invocationId, { catId: CAT, status: 'running' });
      try {
        const auth = verified.record;
        const current = await f.host.context.current(auth);
        const grant = current.workDecision?.grants.find(
          (candidate) =>
            candidate.requestKinds.includes('guide') &&
            (candidate.allowedOnce || candidate.decisionMode === 'automatic'),
        );
        if (grant) {
          const accepted = await f.host.context.acceptWork(auth, current.contextRef, {
            grantRef: grant.grantRef,
            grantRevision: grant.grantRevision,
            requestKind: 'guide',
            title: 'Newcomer guide',
            intendedOutcome: current.request.body,
          });
          runs.push(accepted.workId);
        } else {
          const proposal = await f.host.context.proposeWork(auth, current.contextRef, {
            title: 'Newcomer guide',
            intendedOutcome: current.request.body,
            requestKind: 'guide',
          });
          runs.push(proposal.workId);
        }
      } finally {
        f.world.endTurn(created.invocationId);
      }
      yield { type: 'text', catId: CAT, content: 'The current public request was classified.', timestamp: Date.now() };
      yield { type: 'done', catId: CAT, content: '', timestamp: Date.now() };
    },
    async ackCollectedCursors() {},
  };
  const processor = new QueueProcessor({
    queue,
    invocationTracker: new InvocationTracker(),
    router: router as never,
    invocationRecordStore: {
      async create(input) {
        const id = randomUUID();
        const record = { id, ...input, status: 'queued' };
        records.set(id, record);
        return { outcome: 'created', invocationId: id };
      },
      async get(id) {
        return (records.get(id) as never) ?? null;
      },
      async update(id, input) {
        const record = records.get(id);
        if (!record) return null;
        const { expectedStatus, ...patch } = input;
        if (expectedStatus && expectedStatus !== record.status) return null;
        const next = { ...record, ...patch };
        records.set(id, next);
        return next as never;
      },
    },
    messageStore: f.host.messages,
    queueCustodyCoordinator: new QueuedMessageCustodyCoordinator({ messageStore: f.host.messages }),
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    log: {
      info() {},
      debug() {},
      trace() {},
      warn(value) {
        logs.push(JSON.stringify(value));
      },
      error(value) {
        logs.push(JSON.stringify(value));
      },
    } as never,
  });
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = f.host.userId;
  });
  registerCollectiveOwnerWorkReconsiderationRoutes(app, {
    connector: () => f.world.operator.connector,
    cats: () => [{ id: CAT, supported: true }],
    messages: f.host.messages,
    threads: {
      get: async (id) => {
        await reconsiderHooks.beforeThreadRead?.();
        return f.host.threads.get(id);
      },
    },
    reconsideration: {
      queue,
      processor: {
        processNext: (...args) => (enabled ? processor.processNext(...args) : Promise.resolve({ started: false })),
      },
    },
  });
  await registerCollectiveParticipationCallbacks(app, { registry, context: f.host.context });
  const post = (grantRevision: number, sourceEventId = f.request.eventId, requestKind = 'guide') =>
    app.inject({
      method: 'POST',
      url: `/api/plugins/collective-connector/${f.world.operator.connectionId}/work/reconsider`,
      headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
      remoteAddress: '127.0.0.1',
      payload: { sourceEventId, catId: CAT, grantRef: 'grant-guides', grantRevision, requestKind },
    });
  const approve = async (mode: 'manual' | 'automatic', once = false) => {
    const previous = await f.world.operator.connector.readWorkPolicy(f.world.operator.connectionId);
    const policy = await f.world.store.registerCollectiveWorkPolicy(f.world.operator.sessionToken, {
      ...ownerPolicy(f.world, f.world.operator, { expectedRevision: previous?.revision ?? 0 }),
      decisionMode: 'manual',
      grants: [
        {
          grantRef: 'grant-guides',
          catIds: [CAT],
          channelIds: ['general'],
          requestingHumanIds: 'channel_members',
          requestKinds: ['guide'],
          expiresAt: null,
          decisionMode: mode,
          ...(once ? { sourceEventIds: [f.request.eventId] } : {}),
        },
      ],
    });
    await f.world.operator.connector.adoptWorkPolicy(f.world.operator.connectionId, f.host.userId, policy.revision);
    const grant = policy.grants[0];
    assert.ok(grant);
    return grant.grantRevision;
  };
  const propose = () =>
    f.world.operator.connector.proposeWork(
      collectiveSourceIdentitySchema.parse(f.source.source?.meta?.participation),
      randomUUID(),
      f.world.agent(CAT, f.world.startTurn(CAT)),
      { title: 'Newcomer guide', intendedOutcome: f.source.content, requestKind: 'guide' },
    );
  const callbackAuth = async (messageId: string) => {
    const message = await f.host.messages.getById(messageId);
    assert.ok(message);
    const source = collectiveSourceIdentitySchema.parse(message.source?.meta?.participation);
    const auth = await registry.create(
      f.host.userId,
      CAT,
      message.threadId,
      undefined,
      undefined,
      { mode: 'collective_participation' },
      message.id,
      'unknown',
      undefined,
      { kind: 'collective-participation', originTriggerMessageId: message.id, source },
    );
    f.world.turns.set(auth.invocationId, { catId: CAT, status: 'running' });
    return { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  };
  return {
    ...f,
    queue,
    processor,
    runs,
    logs,
    post,
    approve,
    propose,
    reconsiderHooks,
    callbackAuth,
    callbacks: app,
    enable() {
      enabled = true;
    },
    work: (id: string) => workOf(f.world, id),
    async close() {
      await app.close();
      await f.close();
    },
  };
}
