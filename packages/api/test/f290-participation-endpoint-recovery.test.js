import assert from 'node:assert/strict';
import { test } from 'node:test';
import cookiePlugin from '@fastify/cookie';
import Fastify from 'fastify';
import { reconcileParticipation } from '../dist/domains/plugin/builtin-runtime/collective-participation-reconciler.js';
import { sessionAuthPlugin, sessionRoute } from '../dist/infrastructure/session-auth.js';
import { registerCollectiveOwnerParticipationRoutes } from '../dist/routes/collective-owner-participation-routes.js';
import { collectiveOwnerParticipationView } from '../dist/routes/collective-owner-participation-view.js';

async function harness() {
  const owner = 'owner-A';
  const cats = [{ id: 'codex-sol', displayName: 'Sol', supported: true }];
  const records = new Map();
  let nextId = 0;
  let route;
  const threads = {
    get: (id) => records.get(id),
    list: (userId) => [...records.values()].filter((thread) => thread.createdBy === userId),
    create(userId, title) {
      const thread = { id: `thread_${++nextId}`, createdBy: userId, title, participants: [], deletedAt: null };
      records.set(thread.id, thread);
      return thread;
    },
    addParticipants(id, participants) {
      const thread = records.get(id);
      thread.participants = [...new Set([...thread.participants, ...participants])];
    },
  };
  const connector = {
    getHostRoute: async () => route,
    getProjection: async () => ({
      connectionId: 'connection-A',
      authorizedHumanId: 'human-A',
      authorityStatus: 'connected',
    }),
    async setHostRoute(connectionId, input, expectedRevision) {
      assert.equal(route?.revision ?? 0, expectedRevision);
      route = { ...input, connectionId, revision: expectedRevision + 1 };
      return route;
    },
    publishParticipation: async () => undefined,
    isParticipationPublished: async () => true,
    listInbox: async () => [],
  };
  const reconcile = () =>
    reconcileParticipation({
      connector,
      threads,
      cats,
      ownerUserId: owner,
      connectionId: 'connection-A',
      route,
      expectedRevision: route?.revision ?? 0,
      channelIds: ['general'],
    });
  const view = () =>
    collectiveOwnerParticipationView(
      { cats: () => cats, threads, messages: { getById: async () => null }, tasks: { listByKind: async () => [] } },
      { connector, connection: { connectionId: 'connection-A' }, route, userId: owner },
    );
  await reconcile();
  return { connector, cats, owner, records, threads, reconcile, view, route: () => route };
}

test('healthy published endpoint does not request reconciliation or change its Thread', async () => {
  const h = await harness();
  const initial = structuredClone(h.route());
  assert.equal((await h.view()).reconcileRequired, false);
  await h.reconcile();
  assert.deepEqual(h.route(), initial);
  assert.equal(h.records.size, 1);
});

for (const failure of ['missing', 'deleted', 'foreign-owner', 'missing-participant']) {
  test(`published ${failure} endpoint requests owner reconciliation and recovers a usable channel`, async () => {
    const h = await harness();
    const original = structuredClone(h.route());
    const oldId = original.channelRoutes.general.threadId;
    const old = h.records.get(oldId);
    if (failure === 'missing') h.records.delete(oldId);
    if (failure === 'deleted') old.deletedAt = 123;
    if (failure === 'foreign-owner') old.createdBy = 'owner-B';
    if (failure === 'missing-participant') old.participants = [];

    const before = await h.view();
    assert.equal(before.published, true);
    assert.equal(before.reconcileRequired, true, 'a published route is not usable solely because the roster matches');
    assert.equal(h.route().revision, original.revision, 'GET must not repair or write routing');

    await h.reconcile();
    const recovered = h.route();
    const endpoint = h.records.get(recovered.channelRoutes.general.threadId);
    assert.equal(endpoint.createdBy, 'owner-A');
    assert.equal(endpoint.deletedAt, null);
    assert.deepEqual(endpoint.participants, ['codex-sol']);
    assert.deepEqual(recovered.desiredParticipation, original.desiredParticipation);
    assert.deepEqual(recovered.agentRoutes, {}, 'recovery must not introduce private work authority');
    assert.equal((await h.view()).reconcileRequired, false);

    if (failure !== 'missing-participant') {
      assert.notEqual(endpoint.id, oldId);
      assert.equal(recovered.defaultIngressThreadId, endpoint.id);
      assert.equal(recovered.humanNotificationThreadId, endpoint.id);
    }
    if (failure === 'foreign-owner') assert.deepEqual(old.participants, ['codex-sol']);
    const size = h.records.size;
    const revision = recovered.revision;
    await h.reconcile();
    assert.equal(h.records.size, size);
    assert.equal(h.route().revision, revision, 'a repaired endpoint must not keep spawning Threads');
  });
}

test('recovery preserves a separate valid owner notification Thread', async () => {
  const h = await harness();
  const oldId = h.route().channelRoutes.general.threadId;
  const notifications = h.threads.create('owner-A', 'Owner notifications');
  h.route().humanNotificationThreadId = notifications.id;
  h.records.delete(oldId);
  await h.reconcile();
  assert.equal(h.route().humanNotificationThreadId, notifications.id);
  assert.notEqual(h.route().defaultIngressThreadId, oldId);
  assert.equal((await h.view()).reconcileRequired, false);
});

test('localhost owner HTTP view and reconciliation repair the dangling endpoint without re-pairing', async () => {
  const h = await harness();
  const priorOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = h.owner;
  const app = Fastify();
  try {
    await app.register(cookiePlugin);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute, { ownerUserId: h.owner });
    registerCollectiveOwnerParticipationRoutes(app, {
      connector: () => h.connector,
      cats: () => h.cats,
      threads: h.threads,
      messages: { getById: async () => null },
      tasks: { listByKind: async () => [] },
      context: {},
      work: {},
      dispatcher: {},
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const session = await fetch(`${origin}/api/session`);
    assert.equal(session.status, 200);
    const cookie = session.headers.get('set-cookie').split(';')[0];
    const url = `${origin}/api/plugins/collective-connector/connection-A/participation`;
    const headers = { cookie, origin, 'content-type': 'application/json' };
    const oldId = h.route().channelRoutes.general.threadId;
    h.records.delete(oldId);
    const beforeResponse = await fetch(url, { headers });
    const before = await beforeResponse.json();
    assert.equal(beforeResponse.status, 200, JSON.stringify(before));
    assert.equal(before.published, true);
    assert.equal(before.reconcileRequired, true);
    const repair = await fetch(`${url}/reconcile`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ expectedRevision: before.revision, channelIds: ['general'] }),
    });
    assert.equal(repair.status, 200, await repair.text());
    const after = await fetch(url, { headers }).then((response) => response.json());
    assert.equal(after.reconcileRequired, false);
    assert.notEqual(after.channelRoutes.general.threadId, oldId);
    assert.deepEqual(Object.keys(after.channelRoutes.general.participants), ['codex-sol']);
    assert.equal(after.connection.connectionId, 'connection-A');
    assert.deepEqual(after.tasks, []);
  } finally {
    await app.close();
    if (priorOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = priorOwner;
  }
});
