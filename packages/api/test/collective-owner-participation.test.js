import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { CollectiveCurrentContext } from '../dist/domains/plugin/builtin-runtime/collective-current-context.js';
import { CollectiveWorkAuthority } from '../dist/domains/plugin/builtin-runtime/collective-work-authority.js';
import { CollectiveWorkDispatcher } from '../dist/domains/plugin/builtin-runtime/collective-work-dispatcher.js';
import { registerCollectiveOwnerParticipationRoutes } from '../dist/routes/collective-owner-participation-routes.js';
import { adaptMessageStore } from './helpers/message-from-fixtures.js';
import { readHeaders, writeHeaders } from './plugin-official-routes.fixture.js';

const userId = writeHeaders['x-test-session-user'];
const base = '/api/plugins/collective-connector/con_aaaaaaaa';
async function harness(delayThreadWrites = false) {
  const messages = adaptMessageStore(new MessageStore());
  const tasks = new TaskStore();
  const threads = new ThreadStore();
  let route;
  let published = false;
  let starts = 0;
  const connector = {
    async getProjection() {
      return { connectionId: 'con_aaaaaaaa', authorizedHumanId: 'human_aaaaaaaa', authorityStatus: 'connected' };
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
      return [];
    },
    async readParticipationContext(source) {
      return { source: { ...source, body: 'Request' }, events: [] };
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
    cats: () => [
      { id: 'codex-sol', displayName: 'Sol', supported: true },
      { id: 'opus', displayName: 'Opus', supported: false },
    ],
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
  await app.ready();
  const put = (payload) =>
    app.inject({
      method: 'PUT',
      url: `${base}/participation`,
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload,
    });
  const post = (path, payload) =>
    app.inject({ method: 'POST', url: `${base}${path}`, headers: writeHeaders, remoteAddress: '127.0.0.1', payload });
  const source = () =>
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
          participation: {
            serviceInstanceId: 'svc_aaaaaaaa',
            collectiveId: 'col_aaaaaaaa',
            connectionId: 'con_aaaaaaaa',
            catId: 'codex-sol',
            eventId: 'evt_aaaaaaaa',
            participationRevision: route.revision,
            location: { channelId: 'a' },
            actor: { kind: 'human', humanId: 'human_bbbbbbbb', displayName: 'Guest' },
          },
        },
      },
    });
  return { app, put, post, messages, tasks, threads, source, starts: () => starts, route: () => route };
}
const join = { catId: 'codex-sol', enabled: true, channelIds: ['a'], expectedRevision: 0 };

test('concurrent owner retries cannot create orphan public or private Threads', async () => {
  const f = await harness(true);
  try {
    const joins = await Promise.all([f.put(join), f.put(join)]);
    assert.deepEqual(joins.map((response) => response.statusCode).sort(), [200, 409]);
    assert.equal(f.threads.list(userId).length, 1);
    const source = f.source();
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
    const source = f.source();
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
    const forged = await f.post('/work/resume', { taskId: task.id, observedRevision: 999, requestId: randomUUID() });
    assert.equal(forged.statusCode, 409);
    assert.equal(f.starts(), 1);
    await f.put({ ...join, enabled: false, expectedRevision: 1 });
    const revoked = await f.post('/work/resume', { taskId: task.id, observedRevision: 1, requestId: randomUUID() });
    assert.equal(revoked.statusCode, 409);
    assert.equal(f.starts(), 1);
    assert.equal(f.tasks.get(task.id).status, 'todo');
    assert.ok(f.messages.getById(source.id));
  } finally {
    await f.app.close();
  }
});
