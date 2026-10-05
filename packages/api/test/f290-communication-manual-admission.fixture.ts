import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { collectiveEventSourceIdentity } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { EntrustedWorkOwnerReadService } from '../src/domains/growing/EntrustedWorkOwnerReadService.js';
import { F232PreparedArtifactReader } from '../src/domains/growing/F232PreparedArtifactReader.js';
import type { NeedsMeProducerCatalog } from '../src/domains/growing/NeedsMeProducerCatalog.js';
import { CollectiveIngressDispatcher } from '../src/domains/plugin/builtin-runtime/collective-ingress-dispatcher.js';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.js';
import { registerCallbackTaskRoutes } from '../src/routes/callback-task-routes.js';
import { registerCollectiveOwnerParticipationRoutes } from '../src/routes/collective-owner-participation-routes.js';
import { registerEntrustedWorkReadRoutes } from '../src/routes/entrusted-work-read-routes.js';
import { createWorld, grantRevisionOf, postNaturalRequest, workOf } from './f290-communication-validation.harness.js';
import { CAT, createHost } from './f290-communication-validation.host.js';

/** Real Service HTTP, Connector and Host components; Human auth/session and model turns are labeled fixtures. */
export async function fixture() {
  const world = await createWorld();
  const host = await createHost(world, world.operator);
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = host.userId;
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = host.userId;
  });
  registerCollectiveOwnerParticipationRoutes(app, {
    connector: () => world.operator.connector,
    cats: () => [{ id: CAT, displayName: 'Sol', supported: true }],
    threads: host.threads,
    messages: host.messages,
    tasks: host.tasks,
    context: host.context,
    work: host.authority,
    dispatcher: host.dispatcher,
  });
  const registry = new InvocationRegistry();
  registry.setCollectiveWorkAuthorityValidator(async (record) => {
    assert.ok(await host.context.resolvePrivate(record, 'callback'));
  });
  registerCallbackAuthHook(app, registry);
  registerCallbackTaskRoutes(app, {
    taskStore: host.tasks,
    messageStore: host.messages,
    threadStore: host.threads,
    socketManager: { broadcastToRoom() {}, emitToUser() {} } as never,
  });
  registerEntrustedWorkReadRoutes(app, {
    callbackRegistry: registry,
    service: new EntrustedWorkOwnerReadService({
      tasks: host.tasks,
      artifactReader: new F232PreparedArtifactReader({ messages: host.messages }),
      // Attention producers are inactive fixtures; Task, publication, Artifact and callback consumers are real.
      producerCatalog: {
        async listCurrentReceipts() {
          return [];
        },
      } as unknown as NeedsMeProducerCatalog,
    }),
  });
  const post = (sourceMessageId: string) =>
    app.inject({
      method: 'POST',
      url: `/api/plugins/collective-connector/${world.operator.connectionId}/work/admit`,
      headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
      remoteAddress: '127.0.0.1',
      payload: { sourceMessageId, requestId: randomUUID() },
    });
  const request = await postNaturalRequest(
    world,
    world.wulang,
    world.operator,
    CAT,
    'Please prepare a newcomer guide.',
    host.participationRevision,
  );
  await host.tick();
  const messages = await host.messages.getByThread(host.endpoint.id);
  const source = messages.find((message) => message.source?.meta?.participation?.eventId === request.eventId);
  assert.ok(source);
  const committedSource = async () => {
    const proposed = await world.store.proposeCollectiveWork(world.operator.sessionToken, {
      ...world.coordinates,
      sourceEventId: request.eventId,
      requestId: `proposal-${randomUUID()}`,
      title: 'Actual Guide Title',
      intendedOutcome: 'Actual guide outcome from the committed Work',
    });
    const committed = await world.store.commitCollectiveWork(world.operator.sessionToken, {
      ...world.coordinates,
      workId: proposed.workId,
      expectedRevision: proposed.revision,
      requestId: `commit-${randomUUID()}`,
      assignment: {
        connectionId: world.operator.connectionId,
        catId: CAT,
        participationRevision: host.participationRevision,
      },
    });
    await host.tick();
    const source = (await host.messages.getByThread(host.endpoint.id)).find(
      (message) => message.source?.meta?.participation?.eventId === committed.assignmentEventId,
    );
    assert.ok(source);
    return { committed, source };
  };
  // Admission producer intentionally unavailable: persist the real routed notice without claiming a Host fact.
  const routeWithoutAdmission = new CollectiveIngressDispatcher({
    connector: world.operator.connector,
    threadStore: host.threads,
    messageStore: host.messages,
    invocationQueue: new InvocationQueue(),
    queueProcessor: { async processNext() {} },
    socketManager: { broadcastToRoom() {} },
    isCatAvailable: () => true,
    admitStandingWork: async () => {},
  });
  const continueWork = async (workId: string, body: string) => {
    const work = workOf(world, workId);
    const replyToEventId = work.resultEventId ?? work.assignmentEventId;
    assert.ok(replyToEventId);
    const feedback = await world.store.postHumanMessage(world.wulang.sessionToken, {
      ...world.coordinates,
      clientEventId: randomUUID(),
      target: { kind: 'message', eventId: replyToEventId },
      location: { channelId: 'general' },
      replyToEventId,
      recipient: {
        kind: 'agent',
        humanId: world.operator.humanId,
        connectionId: world.operator.connectionId,
        agentId: CAT,
        participationRevision: host.participationRevision,
      },
      body,
    });
    const identity = collectiveEventSourceIdentity(feedback);
    assert.ok(identity);
    const continued = await world.operator.connector.continueWork(identity, world.agent(CAT, world.startTurn(CAT)), {
      workId,
      expectedRevision: work.revision,
      kind: work.lifecycle === 'result_ready' ? 'revision' : 'resume',
      grantRef: 'grant-guides',
      grantRevision: await grantRevisionOf(world.operator),
      requestKind: 'guide',
      ...(work.lifecycle === 'result_ready'
        ? { resultEventId: work.resultEventId, resultRevision: work.resultRevision ?? 1 }
        : {}),
    });
    await world.operator.connector.sync(world.operator.connectionId);
    await routeWithoutAdmission.dispatchConnection(world.operator.connectionId);
    const source = (await host.messages.getByThread(host.endpoint.id)).find(
      (message) => message.source?.meta?.participation?.eventId === continued.executionAuthority?.eventId,
    );
    assert.ok(source);
    return { work: continued, source, feedback };
  };
  const resume = (taskId: string, observedRevision: number) =>
    app.inject({
      method: 'POST',
      url: `/api/plugins/collective-connector/${world.operator.connectionId}/work/resume`,
      headers: { host: 'localhost:3004', origin: 'http://localhost:5173' },
      remoteAddress: '127.0.0.1',
      payload: { taskId, observedRevision, requestId: randomUUID() },
    });
  return {
    world,
    host,
    app,
    post,
    source,
    request,
    committedSource,
    routeWithoutAdmission,
    registry,
    continueWork,
    resume,
    revokeAfterPreflight() {
      const resolve = host.context.resolvePublic.bind(host.context);
      host.context.resolvePublic = async (input) => {
        const binding = await resolve(input);
        const route = await world.operator.connector.getHostRoute(world.operator.connectionId);
        assert.ok(route);
        await world.operator.connector.setHostRoute(
          world.operator.connectionId,
          {
            localOwnerUserId: route.localOwnerUserId,
            defaultIngressThreadId: route.defaultIngressThreadId,
            humanNotificationThreadId: route.humanNotificationThreadId,
            agentRoutes: {},
          },
          route.revision,
        );
        return binding;
      };
    },
    async close() {
      await app.close();
      await world.close();
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    },
  };
}
