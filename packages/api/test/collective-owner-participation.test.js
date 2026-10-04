import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { EntrustedWorkLifecycleService } from '../dist/domains/growing/EntrustedWorkLifecycleService.js';
import { CollectiveCurrentContext } from '../dist/domains/plugin/builtin-runtime/collective-current-context.js';
import { CollectiveWorkAuthority } from '../dist/domains/plugin/builtin-runtime/collective-work-authority.js';
import { CollectiveWorkDispatcher } from '../dist/domains/plugin/builtin-runtime/collective-work-dispatcher.js';
import { CollectiveWorkResultReconciler } from '../dist/domains/plugin/builtin-runtime/collective-work-result-reconciler.js';
import { registerCollectiveOwnerParticipationRoutes } from '../dist/routes/collective-owner-participation-routes.js';
import { registerCollectiveWorkResultRoutes } from '../dist/routes/collective-work-result-routes.js';
import { readHeaders, writeHeaders } from './plugin-official-routes.fixture.js';

const userId = writeHeaders['x-test-session-user'];
const base = '/api/plugins/collective-connector/con_aaaaaaaa';
async function harness(delayThreadWrites = false, initialExcludedCatIds = []) {
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const threads = new ThreadStore();
  let route;
  let published = false;
  let starts = 0;
  let inbox = [];
  let assignedWork;
  let cats = [
    { id: 'codex-sol', displayName: 'Sol', supported: true },
    { id: 'codex-terra', displayName: 'Terra', supported: true },
    { id: 'opus', displayName: 'Opus', supported: false },
  ];
  const connector = {
    async getProjection() {
      return {
        serviceInstanceId: 'svc_aaaaaaaa',
        collectiveId: 'col_aaaaaaaa',
        connectionId: 'con_aaaaaaaa',
        authorizedHumanId: 'human_aaaaaaaa',
        authorityStatus: 'connected',
        initialExcludedCatIds,
      };
    },
    async getHostRoute() {
      return route;
    },
    async setHostRoute(connectionId, input, expectedRevision) {
      if ((route?.revision ?? 0) !== expectedRevision)
        throw Object.assign(new Error('Concurrent edit'), { code: 'PARTICIPATION_REVISION_CONFLICT' });
      route = { ...input, connectionId, revision: expectedRevision + 1 };
      return route;
    },
    async publishParticipation() {
      published = true;
    },
    async isParticipationPublished() {
      return published;
    },
    async listInbox() {
      return inbox;
    },
    async readParticipationContext(source) {
      return { source: { ...source, body: 'Request' }, events: [] };
    },
    async readAssignedWork() {
      if (!assignedWork) throw Object.assign(new Error('Work unavailable'), { code: 'WORK_NOT_FOUND' });
      return structuredClone(assignedWork);
    },
    async withAssignedWorkAuthority(connectionId, workId, consume) {
      if (connectionId !== 'con_aaaaaaaa' || workId !== assignedWork?.workId) {
        throw Object.assign(new Error('Work unavailable'), { code: 'WORK_NOT_FOUND' });
      }
      return consume({
        connection: await this.getProjection(connectionId),
        hostRoute: route ? structuredClone(route) : undefined,
        inbox: structuredClone(inbox),
        work: structuredClone(assignedWork),
      });
    },
    async withSynchronizedAssignedWorkAuthority(connectionId, assignmentEventId, consume) {
      if (connectionId !== 'con_aaaaaaaa' || assignmentEventId !== assignedWork?.assignmentEventId) {
        throw Object.assign(new Error('Work unavailable'), { code: 'WORK_NOT_FOUND' });
      }
      return consume({
        connection: await this.getProjection(connectionId),
        hostRoute: route ? structuredClone(route) : undefined,
        inbox: structuredClone(inbox),
        work: structuredClone(assignedWork),
        resultPublications: [],
      });
    },
  };
  const work = new CollectiveWorkAuthority({ messageStore: messages, taskStore: tasks });
  const context = new CollectiveCurrentContext({
    connector: () => connector,
    messageStore: messages,
    threadStore: threads,
    workAuthority: work,
  });
  const dispatcher = new CollectiveWorkDispatcher({
    context: () => context,
    messageStore: messages,
    threadStore: threads,
    invocationQueue: new InvocationQueue(),
    queueProcessor: {
      async processNext() {
        starts++;
      },
    },
  });
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session-user'];
  });
  registerCollectiveOwnerParticipationRoutes(app, {
    connector: () => connector,
    cats: () => cats,
    threads: {
      get: (...args) => threads.get(...args),
      list: (...args) => threads.list(...args),
      addParticipants: (...args) => threads.addParticipants(...args),
      create: async (...args) => {
        if (delayThreadWrites) await new Promise(setImmediate);
        return threads.create(...args);
      },
    },
    messages,
    tasks,
    context,
    work,
    dispatcher,
  });
  registerCollectiveWorkResultRoutes(app, {
    connector: () => connector,
    reconciler: new CollectiveWorkResultReconciler({ messages, tasks }),
  });
  await app.ready();
  const put = (payload) =>
    app.inject({
      method: 'PUT',
      url: `${base}/participation`,
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload,
    });
  const reconcile = (payload) => post('/participation/reconcile', payload);
  const updatePolicy = (payload) =>
    app.inject({
      method: 'PUT',
      url: `${base}/participation/policy`,
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload,
    });
  const post = (path, payload) =>
    app.inject({ method: 'POST', url: `${base}${path}`, headers: writeHeaders, remoteAddress: '127.0.0.1', payload });
  const source = (participation = {}, meta = {}) =>
    messages.append({
      userId,
      threadId: route.defaultIngressThreadId,
      catId: null,
      mentions: [],
      timestamp: Date.now(),
      content: 'Prepare an answer',
      source: {
        connector: 'collective',
        label: 'Collective',
        meta: {
          ...meta,
          participation: {
            serviceInstanceId: 'svc_aaaaaaaa',
            collectiveId: 'col_aaaaaaaa',
            connectionId: 'con_aaaaaaaa',
            catId: 'codex-sol',
            eventId: 'evt_aaaaaaaa',
            participationRevision: route.revision,
            location: { channelId: 'a' },
            actor: { kind: 'human', humanId: 'human_bbbbbbbb', displayName: 'Guest' },
            ...participation,
          },
        },
      },
    });
  const committedSource = () => {
    const committed = source(
      { actor: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner' } },
      { workRequest: 'entrust' },
    );
    assignedWork = committedAssignedWork();
    inbox = [assignedWorkInbox(committed, 'actual-human-commit-fixture')];
    return committed;
  };
  return {
    app,
    put,
    post,
    reconcile,
    updatePolicy,
    messages,
    tasks,
    threads,
    source,
    committedSource,
    starts: () => starts,
    route: () => route,
    setCats(next) {
      cats = next;
    },
    setInbox(next) {
      inbox = next;
    },
    setAssignedWork(next) {
      assignedWork = next;
    },
  };
}
const join = { catId: 'codex-sol', enabled: true, channelIds: ['a'], expectedRevision: 0 };

test('first publication honors the owner-reviewed exclusions saved with pairing', async () => {
  const f = await harness(false, ['codex-sol']);
  try {
    const before = await f.app.inject({
      method: 'GET',
      url: `${base}/participation`,
      headers: readHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.deepEqual(before.json().desiredParticipation.excludedCatIds, ['codex-sol']);
    const response = await f.reconcile({ expectedRevision: 0, channelIds: ['a', 'b'] });
    assert.equal(response.statusCode, 200, response.payload);
    assert.deepEqual(f.route().desiredParticipation.excludedCatIds, ['codex-sol']);
    assert.deepEqual(Object.keys(f.route().channelRoutes.a.participants), ['codex-terra']);
    assert.deepEqual(Object.keys(f.route().channelRoutes.b.participants), ['codex-terra']);
    const laterInclusion = await f.updatePolicy({
      expectedRevision: f.route().revision,
      channelIds: ['a', 'b'],
      policy: { defaultMode: 'include', excludedCatIds: [], channelOverrides: {} },
    });
    assert.equal(laterInclusion.statusCode, 200, laterInclusion.payload);
    assert.deepEqual(Object.keys(f.route().channelRoutes.a.participants).sort(), ['codex-sol', 'codex-terra']);
  } finally {
    await f.app.close();
  }
});

test('first channel publication keeps pairing exclusions when a legacy Cat route was written first', async () => {
  const f = await harness(false, ['codex-sol']);
  try {
    const legacy = await f.put({ catId: 'codex-terra', enabled: true, channelIds: ['a'], expectedRevision: 0 });
    assert.equal(legacy.statusCode, 200, legacy.payload);
    assert.deepEqual(f.route().desiredParticipation?.excludedCatIds ?? [], []);
    const pendingView = await f.app.inject({
      method: 'GET',
      url: `${base}/participation`,
      headers: readHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.deepEqual(pendingView.json().desiredParticipation.excludedCatIds, ['codex-sol']);
    const response = await f.reconcile({ expectedRevision: 1, channelIds: ['a'] });
    assert.equal(response.statusCode, 200, response.payload);
    assert.deepEqual(f.route().desiredParticipation.excludedCatIds, ['codex-sol']);
    assert.deepEqual(Object.keys(f.route().channelRoutes.a.participants), ['codex-terra']);
  } finally {
    await f.app.close();
  }
});

test('first policy publication keeps pairing exclusions before a channel endpoint exists', async () => {
  const f = await harness(false, ['codex-sol']);
  try {
    const response = await f.updatePolicy({
      expectedRevision: 0,
      channelIds: ['a'],
      policy: { defaultMode: 'include', excludedCatIds: [], channelOverrides: {} },
    });
    assert.equal(response.statusCode, 200, response.payload);
    assert.deepEqual(f.route().desiredParticipation.excludedCatIds, ['codex-sol']);
    assert.deepEqual(Object.keys(f.route().channelRoutes.a.participants), ['codex-terra']);
  } finally {
    await f.app.close();
  }
});

test('automatic reconcile creates one shared endpoint per Channel and materializes every eligible Cat without private authority', async () => {
  const f = await harness();
  try {
    const response = await f.reconcile({ expectedRevision: 0, channelIds: ['a', 'b'] });
    assert.equal(response.statusCode, 200, response.payload);
    const route = f.route();
    assert.deepEqual(route.desiredParticipation, {
      defaultMode: 'include',
      excludedCatIds: [],
      channelOverrides: {},
    });
    assert.deepEqual(Object.keys(route.channelRoutes).sort(), ['a', 'b']);
    assert.notEqual(route.channelRoutes.a.threadId, route.channelRoutes.b.threadId);
    assert.deepEqual(Object.keys(route.channelRoutes.a.participants).sort(), ['codex-sol', 'codex-terra']);
    assert.deepEqual(Object.keys(route.channelRoutes.b.participants).sort(), ['codex-sol', 'codex-terra']);
    assert.equal(
      Object.values(route.agentRoutes).some((binding) => binding.standingWork),
      false,
    );
    assert.equal(f.tasks.listByKind('work').length, 0);
    assert.equal(f.threads.list(userId).length, 2);
    for (const endpoint of Object.values(route.channelRoutes)) {
      assert.deepEqual([...f.threads.get(endpoint.threadId).participants].sort(), ['codex-sol', 'codex-terra']);
    }

    const view = await f.app.inject({
      method: 'GET',
      url: `${base}/participation`,
      headers: readHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(view.statusCode, 200, view.payload);
    assert.equal(view.json().cats.find((cat) => cat.id === 'opus').eligible, false);
    assert.deepEqual(view.json().channelRoutes, route.channelRoutes);
  } finally {
    await f.app.close();
  }
});

test('owner entry reads registered Cat cards without leaking private routing settings', async () => {
  const h = await harness();
  h.setCats([
    {
      id: 'codex-sol',
      displayName: '缅因猫（Sol）',
      supported: true,
      avatar: '/avatars/codex-sol.png',
      roleDescription: '处理复杂实现',
      defaultModel: 'gpt-6-sol',
      accountRef: 'private-account',
    },
  ]);
  const result = await h.app.inject({
    method: 'GET',
    url: `${base}/participation`,
    headers: readHeaders,
    remoteAddress: '127.0.0.1',
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json().cats, [
    {
      id: 'codex-sol',
      displayName: '缅因猫（Sol）',
      configured: true,
      eligible: true,
      supported: true,
      avatar: '/avatars/codex-sol.png',
      roleDescription: '处理复杂实现',
      defaultModel: 'gpt-6-sol',
    },
  ]);
  assert.equal(result.body.includes('private-account'), false);
  await h.app.close();
});

test('automatic bring-in publishes only a short public Cat introduction and preserves exclusions', async () => {
  const h = await harness();
  h.setCats([
    { id: 'sol', displayName: '缅因猫（Sol）', supported: true, roleDescription: '复杂实现'.repeat(80) },
    { id: 'private', displayName: '私家猫', supported: false, roleDescription: '不要公开' },
  ]);
  const result = await h.reconcile({ expectedRevision: 0, channelIds: ['general'] });
  assert.equal(result.statusCode, 200);
  assert.equal(h.route().channelRoutes.general.participants.sol.displayName, '缅因猫（Sol）');
  assert.equal(h.route().publicProfiles.sol.description.length, 120);
  assert.equal(h.route().publicProfiles.private, undefined);
  await h.app.close();
});

test('owner view exposes response-request attention custody separately from private Work admission', async () => {
  const f = await harness();
  try {
    assert.equal((await f.reconcile({ expectedRevision: 0, channelIds: ['a'] })).statusCode, 200);
    f.setInbox([
      {
        event: {
          serviceInstanceId: 'svc_aaaaaaaa',
          collectiveId: 'col_aaaaaaaa',
          eventId: 'evt_attention',
          clientEventId: 'attention',
          sequence: 1,
          actor: { kind: 'human', humanId: 'human_bbbbbbbb', displayName: 'Guest' },
          target: { kind: 'channel', channelId: 'a' },
          location: { channelId: 'a' },
          recipient: { kind: 'channel' },
          attentionRequest: 'response_requested',
          body: '这件事谁家在做？',
          acceptedAt: '2026-09-11T00:00:00.000Z',
        },
        disposition: 'routed',
        routeReceipt: {
          kind: 'thread_message',
          threadId: f.route().channelRoutes.a.threadId,
          messageId: 'message_attention',
          attention: { request: 'response_requested', state: 'unclaimed' },
        },
      },
      {
        event: {
          serviceInstanceId: 'svc_aaaaaaaa',
          collectiveId: 'col_aaaaaaaa',
          eventId: 'evt_attention_failed',
          clientEventId: 'attention-failed',
          sequence: 2,
          actor: { kind: 'human', humanId: 'human_bbbbbbbb', displayName: 'Guest' },
          target: { kind: 'channel', channelId: 'a' },
          location: { channelId: 'a' },
          recipient: { kind: 'channel' },
          attentionRequest: 'response_requested',
          body: '还有谁可以回应？',
          acceptedAt: '2026-09-11T00:01:00.000Z',
        },
        disposition: 'route_failed',
        routeFailure: { code: 'ROUTE_QUEUE_FULL', message: 'Configured Cat queue is full' },
      },
      {
        event: {
          serviceInstanceId: 'svc_aaaaaaaa',
          collectiveId: 'col_aaaaaaaa',
          eventId: 'evt_attention_reply',
          clientEventId: 'attention-reply',
          sequence: 3,
          actor: {
            kind: 'agent',
            human: { humanId: 'human_aaaaaaaa', displayName: 'Owner' },
            agent: { agentId: 'codex-sol', displayName: 'Sol' },
            provenance: {
              connectionId: 'con_aaaaaaaa',
              endpointId: 'ep_aaaaaaaa',
              endpointLabel: 'Owner Café',
              catId: 'codex-sol',
              sessionRef: 'invocation:attention',
            },
          },
          target: { kind: 'message', eventId: 'evt_attention' },
          location: { channelId: 'a', rootEventId: 'evt_attention' },
          recipient: { kind: 'channel' },
          replyToEventId: 'evt_attention',
          body: '我家在跟进。',
          acceptedAt: '2026-09-11T00:02:00.000Z',
        },
        disposition: 'routed',
        routeReceipt: { kind: 'local_echo' },
      },
    ]);
    const response = await f.app.inject({
      method: 'GET',
      url: `${base}/participation`,
      headers: readHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(response.statusCode, 200, response.payload);
    assert.deepEqual(response.json().requests[0].attention, {
      request: 'response_requested',
      state: 'unclaimed',
    });
    assert.deepEqual(response.json().requests[1].failure, {
      code: 'ROUTE_QUEUE_FULL',
      message: 'Configured Cat queue is full',
    });
    assert.equal(response.json().requests[0].response.eventId, 'evt_attention_reply');
    assert.equal(response.json().tasks.length, 0);
  } finally {
    await f.app.close();
  }
});

test('owner view distinguishes a routed named request, private execution, and a public reply', async () => {
  const f = await harness();
  try {
    assert.equal((await f.reconcile({ expectedRevision: 0, channelIds: ['a'] })).statusCode, 200);
    const source = f.source({ eventId: 'evt_progress' });
    const threadId = f.route().channelRoutes.a.threadId;
    const originalGetById = f.messages.getById.bind(f.messages);
    let catProgress = {
      executionScope: 'collective-participation',
      allTargetCats: ['codex-sol'],
      status: 'processing',
      seenByCatIds: [],
      failedByCatIds: [],
      handledByCatIds: [],
    };
    f.messages.getById = (id) => {
      const message = originalGetById(id);
      return id === source.id && message
        ? {
            ...message,
            queueCustody: catProgress,
          }
        : message;
    };
    const requestItem = {
      event: {
        serviceInstanceId: 'svc_aaaaaaaa',
        collectiveId: 'col_aaaaaaaa',
        eventId: 'evt_progress',
        clientEventId: 'request-progress',
        sequence: 1,
        actor: { kind: 'human', humanId: 'human_bbbbbbbb', displayName: 'Guest' },
        target: { kind: 'agent', humanId: 'human_aaaaaaaa', agentId: 'codex-sol' },
        location: { channelId: 'a' },
        recipient: {
          kind: 'agent',
          connectionId: 'con_aaaaaaaa',
          humanId: 'human_aaaaaaaa',
          agentId: 'codex-sol',
          participationRevision: 1,
        },
        body: '请回答',
        acceptedAt: '2026-09-26T00:00:00.000Z',
      },
      disposition: 'routed',
      routeReceipt: { kind: 'thread_message', threadId, messageId: source.id, catId: 'codex-sol' },
    };
    f.setInbox([requestItem]);
    const read = () =>
      f.app.inject({
        method: 'GET',
        url: `${base}/participation`,
        headers: readHeaders,
        remoteAddress: '127.0.0.1',
      });
    let response = await read();
    assert.equal(response.json().requests[0].execution.stage, 'queued');
    catProgress = { ...catProgress, seenByCatIds: ['codex-sol'] };
    response = await read();
    assert.equal(response.json().requests[0].execution.stage, 'started');
    catProgress = {
      ...catProgress,
      status: 'terminal',
      handledByCatIds: ['codex-sol'],
      targetOutcomeByCatId: { 'codex-sol': { disposition: 'completed_with_turn' } },
    };
    response = await read();
    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(response.json().requests[0].privateThread.id, threadId);
    assert.equal(response.json().requests[0].execution.stage, 'ended');
    assert.equal(response.json().requests[0].response, undefined);
    f.messages.getById = (id) => {
      const message = originalGetById(id);
      return id === source.id && message
        ? {
            ...message,
            source: {
              ...message.source,
              meta: {
                ...message.source.meta,
                participation: { ...message.source.meta.participation, eventId: 'evt_other' },
              },
            },
            queueCustody: catProgress,
          }
        : message;
    };
    response = await read();
    assert.equal(response.json().requests[0].execution, undefined);
    f.messages.getById = (id) => {
      const message = originalGetById(id);
      return id === source.id && message ? { ...message, queueCustody: catProgress } : message;
    };
    const reply = (eventId, catId, connectionId = 'con_aaaaaaaa') => ({
      event: {
        ...requestItem.event,
        eventId,
        clientEventId: eventId,
        sequence: 2,
        actor: {
          kind: 'agent',
          human: { humanId: 'human_aaaaaaaa', displayName: 'Owner' },
          agent: { agentId: catId, displayName: catId },
          provenance: {
            connectionId,
            endpointId: 'ep_aaaaaaaa',
            endpointLabel: 'Owner Café',
            catId,
            sessionRef: 'invocation:reply',
          },
        },
        target: { kind: 'message', eventId: 'evt_progress' },
        location: { channelId: 'a', rootEventId: 'evt_progress' },
        recipient: { kind: 'channel' },
        replyToEventId: 'evt_progress',
        body: '收到。',
      },
      disposition: 'routed',
      routeReceipt: { kind: 'local_echo' },
    });
    f.setInbox([requestItem, reply('evt_neighbor_reply', 'codex-terra')]);
    response = await read();
    assert.equal(response.json().requests[0].response, undefined);
    f.setInbox([requestItem, reply('evt_target_reply', 'codex-sol'), reply('evt_neighbor_reply', 'codex-terra')]);
    response = await read();
    assert.equal(response.json().requests[0].response.eventId, 'evt_target_reply');
  } finally {
    await f.app.close();
  }
});

test('desired exclusions survive eligibility loss and recovery while channel overrides stay local', async () => {
  const f = await harness();
  try {
    assert.equal((await f.reconcile({ expectedRevision: 0, channelIds: ['a', 'b'] })).statusCode, 200);
    const policy = {
      defaultMode: 'include',
      excludedCatIds: ['codex-terra'],
      channelOverrides: { a: { excludedCatIds: ['codex-sol'] } },
    };
    const excluded = await f.updatePolicy({ expectedRevision: 1, channelIds: ['a', 'b'], policy });
    assert.equal(excluded.statusCode, 200, excluded.payload);
    assert.deepEqual(f.route().desiredParticipation, policy);
    assert.deepEqual(Object.keys(f.route().channelRoutes.a.participants), []);
    assert.deepEqual(Object.keys(f.route().channelRoutes.b.participants), ['codex-sol']);

    f.setCats([
      { id: 'codex-sol', displayName: 'Sol', supported: false },
      { id: 'codex-terra', displayName: 'Terra', supported: true },
      { id: 'opus', displayName: 'Opus', supported: false },
    ]);
    const lost = await f.reconcile({ expectedRevision: 2, channelIds: ['a', 'b'] });
    assert.equal(lost.statusCode, 200, lost.payload);
    assert.deepEqual(f.route().desiredParticipation, policy);
    assert.deepEqual(Object.keys(f.route().channelRoutes.b.participants), []);

    f.setCats([
      { id: 'codex-sol', displayName: 'Sol', supported: true },
      { id: 'codex-terra', displayName: 'Terra', supported: true },
      { id: 'opus', displayName: 'Opus', supported: false },
    ]);
    const recovered = await f.reconcile({ expectedRevision: 3, channelIds: ['a', 'b'] });
    assert.equal(recovered.statusCode, 200, recovered.payload);
    assert.deepEqual(f.route().desiredParticipation, policy);
    assert.deepEqual(Object.keys(f.route().channelRoutes.a.participants), []);
    assert.deepEqual(Object.keys(f.route().channelRoutes.b.participants), ['codex-sol']);
  } finally {
    await f.app.close();
  }
});

test('stale policy updates cannot resurrect a Cat withdrawn by a newer revision', async () => {
  const f = await harness();
  try {
    assert.equal((await f.reconcile({ expectedRevision: 0, channelIds: ['a'] })).statusCode, 200);
    const withdrawn = await f.updatePolicy({
      expectedRevision: 1,
      channelIds: ['a'],
      policy: { defaultMode: 'include', excludedCatIds: ['codex-sol'], channelOverrides: {} },
    });
    assert.equal(withdrawn.statusCode, 200, withdrawn.payload);
    const stale = await f.updatePolicy({
      expectedRevision: 1,
      channelIds: ['a'],
      policy: { defaultMode: 'include', excludedCatIds: [], channelOverrides: {} },
    });
    assert.equal(stale.statusCode, 409, stale.payload);
    assert.deepEqual(f.route().desiredParticipation.excludedCatIds, ['codex-sol']);
    assert.equal(f.route().channelRoutes.a.participants['codex-sol'], undefined);
  } finally {
    await f.app.close();
  }
});

test('legacy per-Cat routes migrate into fresh Channel endpoints without erasing prior exclusions or scopes', async () => {
  const f = await harness();
  try {
    assert.equal((await f.put(join)).statusCode, 200);
    assert.equal(
      (
        await f.put({
          catId: 'codex-terra',
          enabled: false,
          channelIds: ['a'],
          expectedRevision: 1,
        })
      ).statusCode,
      200,
    );
    const legacyRoutes = structuredClone(f.route().agentRoutes);

    const migrated = await f.reconcile({ expectedRevision: 2, channelIds: ['a', 'b'] });
    assert.equal(migrated.statusCode, 200, migrated.payload);
    assert.deepEqual(f.route().desiredParticipation, {
      defaultMode: 'include',
      excludedCatIds: ['codex-terra'],
      channelOverrides: { b: { excludedCatIds: ['codex-sol'] } },
    });
    assert.deepEqual(Object.keys(f.route().channelRoutes.a.participants), ['codex-sol']);
    assert.deepEqual(Object.keys(f.route().channelRoutes.b.participants), []);
    assert.deepEqual(f.route().agentRoutes, legacyRoutes);
    assert.notEqual(f.route().channelRoutes.a.threadId, legacyRoutes['human_aaaaaaaa:codex-sol'].threadId);
  } finally {
    await f.app.close();
  }
});

test('concurrent owner retries cannot create orphan public or private Threads', async () => {
  const f = await harness(true);
  try {
    const joins = await Promise.all([f.put(join), f.put(join)]);
    assert.deepEqual(joins.map((response) => response.statusCode).sort(), [200, 409]);
    assert.equal(f.threads.list(userId).length, 1);
    const source = f.committedSource();
    const admitted = await Promise.all(
      [1, 2].map(() => f.post('/work/admit', { sourceMessageId: source.id, requestId: randomUUID() })),
    );
    assert.deepEqual(
      admitted.map((response) => response.statusCode),
      [200, 200],
    );
    assert.equal(f.threads.list(userId).length, 2);
    assert.equal(f.tasks.listByKind('work').length, 1);
    assert.equal(f.starts(), 1);
  } finally {
    await f.app.close();
  }
});

test('owner entry requires a real local owner session; public callback credentials and spoofed forwarding cannot join', async () => {
  const f = await harness();
  try {
    for (const request of [
      { headers: {} },
      { headers: { 'x-invocation-id': 'public', 'x-callback-token': 'valid-public-token' } },
      { headers: { ...writeHeaders, 'x-forwarded-for': '127.0.0.1' }, remoteAddress: '192.0.2.1' },
    ]) {
      const response = await f.app.inject({ method: 'PUT', url: `${base}/participation`, payload: join, ...request });
      assert.ok([401, 403].includes(response.statusCode), response.payload);
    }
    assert.equal(f.threads.list(userId).length, 0);
    const unsupported = await f.put({ ...join, catId: 'opus' });
    assert.equal(unsupported.statusCode, 422);
    assert.equal(f.threads.list(userId).length, 0);
    const valid = await f.put(join);
    assert.equal(valid.statusCode, 200, valid.payload);
    const binding = f.route().agentRoutes['human_aaaaaaaa:codex-sol'];
    assert.equal(binding.participation.displayName, 'Sol');
    assert.equal(binding.standingWork, undefined);
    assert.equal(f.tasks.listByKind('work').length, 0);
    assert.equal(f.threads.get(binding.threadId).createdBy, userId);
    const stale = await f.put({ ...join, enabled: false });
    assert.equal(stale.statusCode, 409);
    const view = await f.app.inject({
      method: 'GET',
      url: `${base}/participation`,
      headers: readHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(view.statusCode, 200);
    assert.equal(view.json().published, true);
    assert.equal(view.payload.includes('endpointCredential'), false);
  } finally {
    await f.app.close();
  }
});

test('the real owner action admits one canonical Work and resumes its exact source; ordinary public participation creates none', async () => {
  const f = await harness();
  try {
    await f.put(join);
    const source = f.committedSource();
    assert.equal(f.tasks.listByKind('work').length, 0);
    const payload = { sourceMessageId: source.id, requestId: randomUUID() };
    const first = await f.post('/work/admit', payload);
    assert.equal(first.statusCode, 200, first.payload);
    const second = await f.post('/work/admit', { ...payload, requestId: randomUUID() });
    assert.equal(second.statusCode, 200, second.payload);
    assert.equal(first.json().messageId, second.json().messageId);
    assert.equal(f.starts(), 1);
    assert.equal(f.tasks.listByKind('work').length, 1);
    const task = f.tasks.listByKind('work')[0];
    assert.deepEqual(task.entrustedWork.admission.sourceRefs, [`message:${source.id}`]);
    assert.notEqual(task.threadId, source.threadId);
    f.setInbox([assignedWorkInbox(source, 'work-assignment-resume'), revisionNoticeInbox('evt_revision00000')]);
    f.setAssignedWork(revisionPendingAssignedWork());
    const resumed = await f.post('/work/resume', {
      taskId: task.id,
      observedRevision: 1,
      requestId: randomUUID(),
    });
    assert.equal(resumed.statusCode, 200, resumed.payload);
    assert.equal(f.messages.getById(resumed.json().messageId).extra.collectiveWorkInvocationV1.resultRevision, 2);
    assert.equal(f.starts(), 2);
    const forged = await f.post('/work/resume', { taskId: task.id, observedRevision: 999, requestId: randomUUID() });
    assert.equal(forged.statusCode, 409);
    assert.equal(f.starts(), 2);
    await f.put({ ...join, enabled: false, expectedRevision: 1 });
    const revoked = await f.post('/work/resume', { taskId: task.id, observedRevision: 1, requestId: randomUUID() });
    assert.equal(revoked.statusCode, 409);
    assert.equal(f.starts(), 2);
    assert.equal(f.tasks.get(task.id).status, 'todo');
    assert.ok(f.messages.getById(source.id));
  } finally {
    await f.app.close();
  }
});

test('manual resume fails closed while Service revision feedback has not reached the Connector inbox', async () => {
  const f = await harness();
  try {
    await f.put(join);
    const source = f.committedSource();
    const admitted = await f.post('/work/admit', { sourceMessageId: source.id, requestId: randomUUID() });
    assert.equal(admitted.statusCode, 200, admitted.payload);
    const task = f.tasks.listByKind('work')[0];
    f.setInbox([assignedWorkInbox(source, 'work-assignment-feedback-not-synced')]);
    f.setAssignedWork(revisionPendingAssignedWork());

    const resumed = await f.post('/work/resume', {
      taskId: task.id,
      observedRevision: 1,
      requestId: randomUUID(),
    });

    assert.equal(resumed.statusCode, 409, resumed.payload);
    assert.equal(resumed.json().code, 'COLLECTIVE_WORK_CONTINUATION_UNAVAILABLE');
    assert.equal(f.starts(), 1);
  } finally {
    await f.app.close();
  }
});

test('manual resume rejects a retained revision notice after the revised Service result is ready', async () => {
  const f = await harness();
  try {
    await f.put(join);
    const source = f.committedSource();
    const admitted = await f.post('/work/admit', { sourceMessageId: source.id, requestId: randomUUID() });
    assert.equal(admitted.statusCode, 200, admitted.payload);
    const task = f.tasks.listByKind('work')[0];
    f.setInbox([
      assignedWorkInbox(source, 'work-assignment-revised-result-ready'),
      revisionNoticeInbox('evt_revision00000'),
    ]);
    f.setAssignedWork(revisedResultReadyAssignedWork());

    const resumed = await f.post('/work/resume', {
      taskId: task.id,
      observedRevision: 1,
      requestId: randomUUID(),
    });

    assert.equal(resumed.statusCode, 409, resumed.payload);
    assert.equal(resumed.json().code, 'COLLECTIVE_WORK_CONTINUATION_UNAVAILABLE');
    assert.equal(f.starts(), 1);
  } finally {
    await f.app.close();
  }
});

test('an exact accepted public Work idempotently satisfies its one admitted private Task', async () => {
  const f = await harness();
  try {
    await f.put(join);
    const source = f.committedSource();
    const admitted = await f.post('/work/admit', { sourceMessageId: source.id, requestId: randomUUID() });
    assert.equal(admitted.statusCode, 200, admitted.payload);
    const task = f.tasks.listByKind('work')[0];
    f.setInbox([assignedWorkInbox(source, 'work-assignment')]);
    f.setAssignedWork({
      v: 1,
      serviceInstanceId: 'svc_aaaaaaaa',
      collectiveId: 'col_aaaaaaaa',
      workId: 'work_aaaaaaaa',
      sourceEventId: 'evt_sourceaaa',
      sourceLocation: { channelId: 'a' },
      title: 'Prepare an answer',
      intendedOutcome: 'Prepare an answer',
      proposedBy: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner' },
      accountableHumanId: 'human_aaaaaaaa',
      assignment: {
        humanId: 'human_aaaaaaaa',
        connectionId: 'con_aaaaaaaa',
        catId: 'codex-sol',
        displayName: 'Sol',
        participationRevision: 1,
        assignedAt: '2026-09-13T00:00:00.000Z',
      },
      assignmentEventId: 'evt_aaaaaaaa',
      dependencyWorkIds: [],
      lifecycle: 'completed',
      resultEventId: 'evt_resultaaaa',
      resultRevision: 2,
      revision: 4,
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:01:00.000Z',
      history: [
        {
          revision: 4,
          action: 'result_accepted',
          actor: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner' },
          at: '2026-09-13T00:01:00.000Z',
          eventId: 'evt_resultaaaa',
          resultRevision: 2,
        },
      ],
      status: 'completed',
    });
    const payload = {
      serviceInstanceId: 'svc_aaaaaaaa',
      collectiveId: 'col_aaaaaaaa',
      connectionId: 'con_aaaaaaaa',
      workId: 'work_aaaaaaaa',
      workRevision: 4,
      assignmentEventId: 'evt_aaaaaaaa',
      resultEventId: 'evt_resultaaaa',
      resultRevision: 2,
    };
    const forged = await f.post('/work/result/accepted', { ...payload, resultEventId: 'evt_forgedaaaa' });
    assert.equal(forged.statusCode, 409, forged.payload);
    assert.equal(f.tasks.get(task.id).status, 'todo');

    const first = await f.post('/work/result/accepted', payload);
    const replay = await f.post('/work/result/accepted', payload);
    assert.equal(first.statusCode, 200, first.payload);
    assert.equal(replay.statusCode, 200, replay.payload);
    assert.equal(first.json().result, 'closed');
    assert.equal(replay.json().result, 'already_closed');
    const closed = f.tasks.get(task.id);
    assert.equal(closed.status, 'done');
    assert.equal(closed.entrustedWork.closure.state, 'satisfied');
    assert.deepEqual(closed.entrustedWork.closure.evidenceRefs, [
      'collective:svc_aaaaaaaa:col_aaaaaaaa:work_aaaaaaaa:revision:4',
      'collective:event:evt_aaaaaaaa',
      'collective:event:evt_resultaaaa',
    ]);
  } finally {
    await f.app.close();
  }
});

test('a completed public Work cannot create a new private Task from a retained assignment', async () => {
  const f = await harness();
  try {
    await f.put(join);
    const source = f.committedSource();
    f.setInbox([assignedWorkInbox(source, 'work-assignment-late-admission')]);
    f.setAssignedWork(completedAssignedWork());
    const payload = acceptedResultPayload();

    const beforeAdmission = await f.post('/work/result/accepted', payload);
    assert.equal(beforeAdmission.statusCode, 202, beforeAdmission.payload);
    assert.equal(beforeAdmission.json().result, 'not_admitted');

    const admitted = await f.post('/work/admit', { sourceMessageId: source.id, requestId: randomUUID() });
    assert.equal(admitted.statusCode, 409, admitted.payload);
    assert.equal(f.tasks.listByKind('work').length, 0);
    assert.equal(f.threads.list(userId).length, 1);
  } finally {
    await f.app.close();
  }
});

test('a differently closed private Task is an explicit conflict, never already reconciled', async () => {
  const f = await harness();
  try {
    await f.put(join);
    const source = f.committedSource();
    const admitted = await f.post('/work/admit', { sourceMessageId: source.id, requestId: randomUUID() });
    assert.equal(admitted.statusCode, 200, admitted.payload);
    const task = f.tasks.listByKind('work')[0];
    await new EntrustedWorkLifecycleService(f.tasks).close({
      taskId: task.id,
      expectedRevision: task.entrustedWork.revision,
      closure: {
        state: 'satisfied',
        condition: task.entrustedWork.closure.condition,
        expectedSignal: task.entrustedWork.closure.expectedSignal,
        evidenceRefs: ['different:result'],
      },
    });
    f.setInbox([assignedWorkInbox(source, 'work-assignment-conflict')]);
    f.setAssignedWork(completedAssignedWork());

    const conflict = await f.post('/work/result/accepted', acceptedResultPayload());
    assert.equal(conflict.statusCode, 409, conflict.payload);
    assert.equal(conflict.json().code, 'COLLECTIVE_RESULT_TERMINAL_CONFLICT');
    assert.deepEqual(f.tasks.get(task.id).entrustedWork.closure.evidenceRefs, ['different:result']);
  } finally {
    await f.app.close();
  }
});

test('a competing terminal close during CAS keeps its evidence and is not mislabeled as this result', async () => {
  const f = await harness();
  try {
    await f.put(join);
    const source = f.committedSource();
    const admitted = await f.post('/work/admit', { sourceMessageId: source.id, requestId: randomUUID() });
    assert.equal(admitted.statusCode, 200, admitted.payload);
    const task = f.tasks.listByKind('work')[0];
    const close = f.tasks.closeEntrustedWork.bind(f.tasks);
    let injected = false;
    f.tasks.closeEntrustedWork = (taskId, input) => {
      if (!injected) {
        injected = true;
        const competing = close(taskId, {
          ...input,
          closure: { ...input.closure, evidenceRefs: ['different:result'] },
        });
        assert.equal(competing.kind, 'closed');
      }
      return close(taskId, input);
    };
    f.setInbox([assignedWorkInbox(source, 'work-assignment-cas-conflict')]);
    f.setAssignedWork(completedAssignedWork());

    const conflict = await f.post('/work/result/accepted', acceptedResultPayload());
    assert.equal(conflict.statusCode, 409, conflict.payload);
    assert.equal(conflict.json().code, 'COLLECTIVE_RESULT_TERMINAL_CONFLICT');
    assert.deepEqual(f.tasks.get(task.id).entrustedWork.closure.evidenceRefs, ['different:result']);
  } finally {
    await f.app.close();
  }
});

function committedAssignedWork() {
  const { resultEventId, resultRevision, ...base } = completedAssignedWork();
  return {
    ...base,
    lifecycle: 'committed',
    status: 'ready',
    revision: 2,
    history: [
      {
        revision: 2,
        action: 'committed',
        actor: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner' },
        at: '2026-09-13T00:00:00.000Z',
        eventId: 'evt_aaaaaaaa',
      },
    ],
  };
}

function completedAssignedWork() {
  return {
    v: 1,
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    workId: 'work_aaaaaaaa',
    sourceEventId: 'evt_sourceaaa',
    sourceLocation: { channelId: 'a' },
    title: 'Prepare an answer',
    intendedOutcome: 'Prepare an answer',
    proposedBy: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner' },
    accountableHumanId: 'human_aaaaaaaa',
    assignment: {
      humanId: 'human_aaaaaaaa',
      connectionId: 'con_aaaaaaaa',
      catId: 'codex-sol',
      displayName: 'Sol',
      participationRevision: 1,
      assignedAt: '2026-09-13T00:00:00.000Z',
    },
    assignmentEventId: 'evt_aaaaaaaa',
    dependencyWorkIds: [],
    lifecycle: 'completed',
    resultEventId: 'evt_resultaaaa',
    resultRevision: 1,
    revision: 4,
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:01:00.000Z',
    history: [
      {
        revision: 4,
        action: 'result_accepted',
        actor: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner' },
        at: '2026-09-13T00:01:00.000Z',
        eventId: 'evt_resultaaaa',
        resultRevision: 1,
      },
    ],
    status: 'completed',
  };
}

function revisionPendingAssignedWork() {
  return {
    ...completedAssignedWork(),
    lifecycle: 'in_progress',
    status: 'in_progress',
    resultEventId: 'evt_result000000',
    resultRevision: 1,
    revision: 4,
    history: [
      {
        revision: 3,
        action: 'result_returned',
        actor: {
          kind: 'agent',
          humanId: 'human_aaaaaaaa',
          humanDisplayName: 'Owner',
          connectionId: 'con_aaaaaaaa',
          catId: 'codex-sol',
          displayName: 'Sol',
        },
        at: '2026-09-13T00:00:30.000Z',
        eventId: 'evt_result000000',
        resultRevision: 1,
      },
      {
        revision: 4,
        action: 'revision_requested',
        actor: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner' },
        at: '2026-09-13T00:01:00.000Z',
        eventId: 'evt_result000000',
        resultRevision: 1,
        note: '请补上重启后的恢复证据。',
      },
    ],
  };
}

function revisedResultReadyAssignedWork() {
  return {
    ...revisionPendingAssignedWork(),
    lifecycle: 'result_ready',
    status: 'result_ready',
    resultEventId: 'evt_result000002',
    resultRevision: 2,
    revision: 5,
    history: [
      ...revisionPendingAssignedWork().history,
      {
        revision: 5,
        action: 'result_returned',
        actor: {
          kind: 'agent',
          humanId: 'human_aaaaaaaa',
          humanDisplayName: 'Owner',
          connectionId: 'con_aaaaaaaa',
          catId: 'codex-sol',
          displayName: 'Sol',
        },
        at: '2026-09-13T00:02:00.000Z',
        eventId: 'evt_result000002',
        resultRevision: 2,
      },
    ],
  };
}

function revisionNoticeInbox(eventId) {
  return {
    event: {
      eventId,
      clientEventId: `revision-${eventId}`,
      sequence: 2,
      serviceInstanceId: 'svc_aaaaaaaa',
      collectiveId: 'col_aaaaaaaa',
      actor: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner' },
      target: { kind: 'agent', humanId: 'human_aaaaaaaa', agentId: 'codex-sol' },
      location: { channelId: 'a' },
      recipient: {
        kind: 'agent',
        humanId: 'human_aaaaaaaa',
        connectionId: 'con_aaaaaaaa',
        agentId: 'codex-sol',
        participationRevision: 1,
      },
      replyToEventId: 'evt_result000000',
      workRequest: 'revise',
      workRevisionNotice: {
        v: 1,
        workId: 'work_aaaaaaaa',
        workRevision: 4,
        assignmentEventId: 'evt_aaaaaaaa',
        resultEventId: 'evt_result000000',
        resultRevision: 1,
      },
      body: '请补上重启后的恢复证据。',
      acceptedAt: '2026-09-28T00:01:00.000Z',
    },
    disposition: 'routed',
    persistedAt: '2026-09-28T00:01:00.000Z',
  };
}

function assignedWorkInbox(source, clientEventId) {
  return {
    event: {
      serviceInstanceId: 'svc_aaaaaaaa',
      collectiveId: 'col_aaaaaaaa',
      eventId: 'evt_aaaaaaaa',
      clientEventId,
      sequence: 1,
      actor: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner' },
      target: { kind: 'agent', humanId: 'human_aaaaaaaa', agentId: 'codex-sol' },
      location: { channelId: 'a' },
      recipient: {
        kind: 'agent',
        humanId: 'human_aaaaaaaa',
        connectionId: 'con_aaaaaaaa',
        agentId: 'codex-sol',
        participationRevision: 1,
      },
      workRequest: 'entrust',
      body: 'Prepare an answer',
      acceptedAt: '2026-09-13T00:00:00.000Z',
    },
    disposition: 'routed',
    routeReceipt: { kind: 'thread_message', threadId: source.threadId, messageId: source.id, catId: 'codex-sol' },
  };
}

function acceptedResultPayload() {
  return {
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    connectionId: 'con_aaaaaaaa',
    workId: 'work_aaaaaaaa',
    workRevision: 4,
    assignmentEventId: 'evt_aaaaaaaa',
    resultEventId: 'evt_resultaaaa',
    resultRevision: 1,
  };
}
