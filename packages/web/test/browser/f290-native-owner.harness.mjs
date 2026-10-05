import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../../../api/test/helpers/setup-cat-registry.js';
import { InvocationQueue } from '../../../api/dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../../../api/dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../../../api/dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../../../api/dist/domains/cats/services/stores/ports/ThreadStore.js';
import { CollectiveCurrentContext } from '../../../api/dist/domains/plugin/builtin-runtime/collective-current-context.js';
import { CollectiveIngressDispatcher } from '../../../api/dist/domains/plugin/builtin-runtime/collective-ingress-dispatcher.js';
import { resolveCollectiveStandingGrant } from '../../../api/dist/domains/plugin/builtin-runtime/collective-standing-grant.js';
import { CollectiveWorkAdmission } from '../../../api/dist/domains/plugin/builtin-runtime/collective-work/collective-work-admission.js';
import { CollectiveWorkAuthority } from '../../../api/dist/domains/plugin/builtin-runtime/collective-work-authority.js';
import { CollectiveWorkDispatcher } from '../../../api/dist/domains/plugin/builtin-runtime/collective-work-dispatcher.js';
import { CollectiveWorkResultReconciler } from '../../../api/dist/domains/plugin/builtin-runtime/collective-work-result-reconciler.js';
import { CollectiveWorkRevisionReconciler } from '../../../api/dist/domains/plugin/builtin-runtime/collective-work-revision-reconciler.js';
import { resolveCollectiveWorkThread } from '../../../api/dist/domains/plugin/builtin-runtime/collective-work-thread.js';
import { registerCollectiveConnectorRoutes } from '../../../api/dist/routes/collective-connector-routes.js';
import { registerCollectiveOwnerParticipationRoutes } from '../../../api/dist/routes/collective-owner-participation-routes.js';
import { registerCollectiveWorkResultRoutes } from '../../../api/dist/routes/collective-work-result-routes.js';
import { CollectiveConnector } from '../../../collective-connector/dist/index.js';
import { catRegistry } from '../../../shared/dist/index.js';
import {
  createNativeOwnerResultArtifacts,
  registerNativeOwnerResultArtifactRoutes,
} from './f290-result-artifact.harness.mjs';
import { startNext, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';

const require = createRequire(new URL('../../../api/package.json', import.meta.url));
const Fastify = require('fastify');
const cors = require('@fastify/cors');

/** Real Connector, owner routes, inbox dispatcher and Work stores; only login and Agent execution are test fixtures. */
export async function startNativeOwner({ store, owner, collectiveId, serviceUrl, context, ports }) {
  const { hostPort, apiPort } = ports;
  const directory = await mkdtemp(path.join(tmpdir(), 'f290-native-owner-'));
  const registered = catRegistry.getOrThrow('codex-sol').config;
  const cat = { id: 'codex-sol', displayName: registered.displayName, supported: true };
  const userId = process.env.DEFAULT_OWNER_USER_ID ?? 'f290-browser-owner';
  const hostUrl = `http://localhost:${hostPort}`;
  const apiUrl = `http://localhost:${apiPort}`;
  const token = randomUUID();
  const connector = await CollectiveConnector.open({ dataDirectory: directory, verifyAgent: async () => true });
  const intent = await store.createPairingIntent({
    sessionToken: owner.sessionToken,
    collectiveId,
    hostOrigin: hostUrl,
    nonce: randomUUID(),
  });
  const connection = await connector.pair({ serviceUrl, intent, endpointLabel: 'You 的 Café · 本机' });
  const threads = new ThreadStore();
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const resultArtifacts = createNativeOwnerResultArtifacts({ connector, tasks, messages, userId, cat });
  const { publications, ownerReads } = resultArtifacts;
  const queue = new InvocationQueue();
  const processor = { async processNext() {} }; // Never starts a model in a deterministic browser test.
  const work = new CollectiveWorkAuthority({
    messageStore: messages,
    taskStore: tasks,
    standingGrant: (source, catId) => resolveCollectiveStandingGrant(connector, source, catId),
    resolveWorkThread: (source, catId) => resolveCollectiveWorkThread(threads, tasks, source, catId),
  });
  const admissionErrors = [];
  const admit = work.admit.bind(work);
  work.admit = async (input) => {
    try {
      return await admit(input);
    } catch (error) {
      admissionErrors.push({ name: error.name, issues: error.issues ?? error.message });
      throw error;
    }
  };
  const current = new CollectiveCurrentContext({
    connector: () => connector,
    messageStore: messages,
    threadStore: threads,
    workAuthority: work,
    artifactReader: publications,
  });
  const dispatcher = new CollectiveWorkDispatcher({
    context: () => current,
    messageStore: messages,
    threadStore: threads,
    invocationQueue: queue,
    queueProcessor: processor,
  });
  const revisionReconciler = new CollectiveWorkRevisionReconciler({ messages, tasks, dispatcher });
  const admission = new CollectiveWorkAdmission({ connector: () => connector, authority: work, tasks, dispatcher });
  const ingress = new CollectiveIngressDispatcher({
    connector,
    threadStore: threads,
    messageStore: messages,
    invocationQueue: queue,
    queueProcessor: processor,
    socketManager: { broadcastToRoom() {}, emitToUser() {} },
    isCatAvailable: () => true,
    admitStandingWork: (source, catId) => admission.admit(source, catId),
    resumeWorkRevision: async (source, event) => {
      const notice = event.workRevisionNotice;
      const recipient = event.recipient;
      if (!notice || recipient?.kind !== 'agent' || event.actor.kind !== 'human') {
        throw new Error('Collective Work revision notice is invalid');
      }
      await connector.withAssignedWorkAuthority(recipient.connectionId, notice.workId, async (scope) => {
        if (
          scope.hostRoute?.localOwnerUserId !== source.userId ||
          scope.connection.authorizedHumanId !== event.actor.humanId
        ) {
          throw new Error('Collective Work revision belongs to another owner');
        }
        await revisionReconciler.reconcile({
          ownerUserId: source.userId,
          event,
          inbox: scope.inbox,
          work: scope.work,
        });
      });
    },
  });
  // This isolated fixture owns every connection. Force-close keep-alive sockets so
  // teardown stays bounded after the preceding browser suite has accumulated load.
  const app = Fastify({ forceCloseConnections: true });
  await app.register(cors, { origin: hostUrl, credentials: true });
  app.addHook('preHandler', async (request) => {
    if (request.headers.cookie?.split(';').some((part) => part.trim() === `f290-owner-session=${token}`))
      request.sessionUserId = userId;
  });
  app.get('/api/session', async (request, reply) =>
    request.sessionUserId ? { userId } : reply.code(401).send({ error: 'fixture session required' }),
  );
  registerNativeOwnerResultArtifactRoutes(app, resultArtifacts);
  registerCollectiveConnectorRoutes(app, {
    runtime: { connector: () => connector },
    localService: {
      status: async () => ({ state: 'ready', serviceUrl, dataDirectory: directory }),
      provision: async () => {
        throw new Error('Not part of this journey');
      },
    },
    callbackRegistry: {
      verify: async () => {
        throw new Error('Callback auth is outside this owner journey');
      },
    },
    resolveAgentIdentity: () => undefined,
    threadStore: threads,
    isCatAvailable: () => true,
  });
  registerCollectiveOwnerParticipationRoutes(app, {
    connector: () => connector,
    cats: () => [
      cat,
      { id: 'fable-5', displayName: '宪宪', supported: true },
      { id: 'unsupported', displayName: '尚未支持的伙伴', supported: false },
    ],
    threads,
    messages,
    tasks,
    context: current,
    work,
    dispatcher,
    reconsideration: { queue, processor },
  });
  registerCollectiveWorkResultRoutes(app, {
    connector: () => connector,
    reconciler: new CollectiveWorkResultReconciler({ messages, tasks }),
  });
  let next;
  try {
    await ports.releaseApi();
    await app.listen({ host: '127.0.0.1', port: apiPort });
    await context.addCookies([
      { name: 'f290-owner-session', value: token, url: hostUrl, httpOnly: true, sameSite: 'Lax' },
    ]);
    await ports.releaseHost();
    next = startNext(hostPort);
    await waitForHttp(`${hostUrl}/collective`, next);
  } catch (error) {
    if (next) await stopChild(next);
    await app.close();
    await rm(directory, { recursive: true });
    throw error;
  }

  async function routedSourceForEvent(eventId) {
    const item = (await connector.listInbox(connection.connectionId)).find(
      (candidate) => candidate.event.eventId === eventId,
    );
    if (item?.routeReceipt?.kind !== 'thread_message') throw new Error('Collective event was not routed');
    const sourceMessage = await messages.getById(item.routeReceipt.messageId);
    if (!sourceMessage) throw new Error('Collective event has no routed source Message');
    const source = sourceMessage.source?.meta?.participation;
    if (!source) throw new Error('Collective event has no admitted participation source');
    return { sourceMessage, source, sourceRef: `message:${sourceMessage.id}` };
  }

  async function exactWorkTaskForEvent(eventId) {
    const { source, sourceRef } = await routedSourceForEvent(eventId);
    const matches = (await tasks.listByKind('work')).filter((task) => {
      const refs = task.entrustedWork?.admission.sourceRefs;
      return task.userId === userId && task.ownerCatId === source.catId && refs?.length === 1 && refs[0] === sourceRef;
    });
    if (matches.length !== 1)
      throw new Error(`Collective event must own exactly one private Work Task; found ${matches.length}`);
    return matches[0];
  }

  return {
    hostUrl,
    apiUrl,
    userId,
    cat,
    admissionErrors,
    connection,
    connector,
    queue,
    tasks,
    threads,
    messages,
    publications,
    ownerReads,
    async admitPrivateWorkForEvent(eventId, title) {
      const { sourceMessage, source } = await routedSourceForEvent(eventId);
      await work.admit({
        ownerUserId: userId,
        source: sourceMessage,
        catId: source.catId,
        threadId: sourceMessage.threadId,
        ownerAuthProvenance: 'strict',
        requestId: `browser-negative:${eventId}`,
        title,
        intendedOutcome: title,
        closure: {
          condition: 'A reviewable result answers this unrelated request',
          expectedSignal: 'collective:accepted-result',
        },
      });
      return exactWorkTaskForEvent(eventId);
    },
    workTaskForEvent: exactWorkTaskForEvent,
    // Explicit Human commitment already exists in the Service. This adapter uses the
    // production owner admission route; it never turns ordinary chat into a Work.
    async admitCommittedWorkForEvent(eventId) {
      const { sourceMessage } = await routedSourceForEvent(eventId);
      const response = await fetch(`${apiUrl}/api/plugins/collective-connector/${connection.connectionId}/work/admit`, {
        method: 'POST',
        headers: { cookie: `f290-owner-session=${token}`, origin: hostUrl, 'content-type': 'application/json' },
        body: JSON.stringify({ sourceMessageId: sourceMessage.id, requestId: randomUUID() }),
      });
      if (response.status !== 200)
        throw new Error(`Committed Work admission failed (${response.status}): ${await response.text()}`);
      return exactWorkTaskForEvent(eventId);
    },
    async proposeWorkForEvent(eventId, intendedOutcome) {
      const { source } = await routedSourceForEvent(eventId);
      return connector.proposeWork(
        source,
        `scripted-browser-proposal:${eventId}`,
        { catId: cat.id, agentId: cat.id, displayName: cat.displayName, sessionRef: 'scripted-browser-proposal' },
        { title: intendedOutcome, intendedOutcome, requestKind: 'guide' },
      );
    },
    async acceptAuthorizedRequest(eventId, intendedOutcome) {
      const { source } = await routedSourceForEvent(eventId);
      const decision = await connector.currentWorkDecision(source);
      const grant = decision.grants.find((candidate) => candidate.requestKinds.includes('guide'));
      if (!grant || decision.delegationState !== 'adopted')
        throw new Error('The original request has no adopted grant');
      const accepted = await connector.acceptWork(
        source,
        { catId: cat.id, agentId: cat.id, displayName: cat.displayName, sessionRef: 'scripted-browser-acceptance' },
        {
          grantRef: grant.grantRef,
          grantRevision: grant.grantRevision,
          requestKind: 'guide',
          title: intendedOutcome,
          intendedOutcome,
        },
      );
      await connector.sync(connection.connectionId);
      const dispatched = await ingress.dispatchConnection(connection.connectionId);
      if (dispatched.failed) throw new Error(`Host admission failed: ${JSON.stringify(dispatched)}`);
      const task = await exactWorkTaskForEvent(accepted.assignmentEventId);
      return { work: accepted, task };
    },
    attachArtifactToTask: resultArtifacts.attachToTask,
    async receiveRequest(body, channelId = '产品方向') {
      const route = await connector.getHostRoute(connection.connectionId);
      const me = await store.getHumanProjection(owner.sessionToken);
      await store.postHumanMessage(owner.sessionToken, {
        serviceInstanceId: store.serviceInstanceId,
        collectiveId,
        clientEventId: randomUUID(),
        body,
        location: { channelId },
        recipient: {
          kind: 'agent',
          humanId: me.human.humanId,
          agentId: cat.id,
          connectionId: connection.connectionId,
          participationRevision: route.revision,
        },
      });
      await connector.sync(connection.connectionId);
      return ingress.dispatchConnection(connection.connectionId);
    },
    async dispatchPending() {
      await connector.sync(connection.connectionId);
      return ingress.dispatchConnection(connection.connectionId);
    },
    async queuedForChannel(channelId) {
      const route = await connector.getHostRoute(connection.connectionId);
      const threadId = route?.channelRoutes[channelId]?.threadId;
      if (!threadId) throw new Error(`Channel endpoint is unavailable: ${channelId}`);
      return queue.list(threadId, userId);
    },
    async replyToRequest(requestBody, replyBody) {
      const item = (await connector.listInbox(connection.connectionId)).find(
        (candidate) => candidate.event.body === requestBody,
      );
      if (item?.routeReceipt?.kind !== 'thread_message') throw new Error('Response request was not routed');
      const sourceMessage = await messages.getById(item.routeReceipt.messageId);
      const source = sourceMessage?.source?.meta?.participation;
      if (!source) throw new Error('Response request has no admitted participation source');
      const sourceRef = `message:${sourceMessage.id}`;
      const operation = await connector.prepareReply(source, sourceRef, 'response-request');
      await connector.submitReply(source, sourceRef, 'response-request', operation.outboxId, replyBody, {
        agentId: cat.id,
        catId: cat.id,
        displayName: cat.displayName,
        sessionRef: 'deterministic-browser-participant',
      });
      await connector.sync(connection.connectionId);
      await ingress.dispatchConnection(connection.connectionId);
      return connector.listInbox(connection.connectionId);
    },
    async replyToEvent(eventId, replyBody, resultRevision = 1) {
      const { source, sourceRef } = await routedSourceForEvent(eventId);
      const task = await exactWorkTaskForEvent(eventId);
      const resultKey = `work:${task.id}`;
      const operation = await connector.prepareReply(
        source,
        sourceRef,
        resultKey,
        task.entrustedWork.revision,
        resultRevision,
      );
      const artifactSnapshot = await resultArtifacts.snapshotForTask(task);
      await connector.submitReply(
        source,
        sourceRef,
        resultKey,
        operation.outboxId,
        replyBody,
        {
          agentId: cat.id,
          catId: cat.id,
          displayName: cat.displayName,
          sessionRef: 'deterministic-browser-work-result',
        },
        artifactSnapshot,
        resultRevision,
      );
      await connector.sync(connection.connectionId);
      await ingress.dispatchConnection(connection.connectionId);
      return connector.listInbox(connection.connectionId);
    },
    async close() {
      await stopChild(next);
      await app.close();
      await rm(directory, { recursive: true });
    },
  };
}

export { reserveNativeOwnerPorts } from './f290-owner-ports.harness.mjs';
