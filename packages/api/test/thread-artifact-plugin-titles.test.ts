import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { DeclaredRuntimeContributions } from '../src/domains/plugin/declared/declared-runtime-contributions.js';
import { pluginWebhookForwardingRoutes } from '../src/routes/plugin/plugin-webhook-forwarding-routes.js';
import { threadsRoutes } from '../src/routes/threads.js';

async function fixture(t) {
  const calls = [];
  const webhooks = new DeclaredRuntimeContributions({
    packages: {
      async resolveInstalledPackage() {
        throw new Error('no package reads');
      },
    },
    configuration: { async readConfig() {}, async readSecret() {} },
  });
  await webhooks.activate(
    {
      instance: { pluginInstanceId: 'pi_title' },
      packageRecord: {
        pluginId: 'official.github-operations',
        manifest: {
          contributions: [
            {
              type: 'webhook',
              id: 'pr-title',
              path: 'github/pr-title',
              methods: ['GET'],
              action: { method: 'github.pr-title' },
            },
          ],
        },
      },
      effectiveGrants: [],
    },
    async (_instance, _method, params) => {
      calls.push(params.request);
      return { status: 200, body: { title: 'Title from the installed package' } };
    },
  );
  const app = Fastify();
  t.after(() => app.close());
  app.decorateRequest('sessionUserId', undefined);
  app.addHook('onRequest', async (request) => {
    if (request.headers['x-cat-cafe-user'] === 'alice') request.sessionUserId = 'alice';
  });
  await app.register(pluginWebhookForwardingRoutes, { webhooks });
  await app.register(threadsRoutes, {
    threadStore: { get: async () => ({ id: 'T1', createdBy: 'alice' }), getThreadMemory: async () => null },
    messageStore: { getByThread: async () => [], getByThreadBefore: async () => [] },
    taskStore: {
      listByThread: async () => [
        {
          kind: 'pr_tracking',
          subjectKey: 'pr:org/repo#12',
          userId: 'alice',
          title: 'PR tracking: org/repo#12',
          status: 'doing',
          updatedAt: 1,
        },
      ],
    },
  });
  return { app, calls, webhooks };
}

test('works titles use the installed declared HTTP route after visibility and owner authorization', async (t) => {
  const { app, calls, webhooks } = await fixture(t);
  const denied = await app.inject({
    url: '/api/threads/T1/artifacts?view=works',
    headers: { 'x-cat-cafe-user': 'bob' },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(calls.length, 0);
  const response = await app.inject({
    url: '/api/threads/T1/artifacts?view=works',
    headers: { 'x-cat-cafe-user': 'alice' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().artifacts[0].name, 'Title from the installed package');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query.ref, 'org/repo#12');
  assert.deepEqual(calls[0].principal, { kind: 'owner', id: 'alice' });
  assert.equal(calls[0].headers['x-cat-cafe-user'], undefined);
  webhooks.deactivate('pi_title');
  const unavailable = await app.inject({
    url: '/api/threads/T1/artifacts?view=works',
    headers: { 'x-cat-cafe-user': 'alice' },
  });
  assert.equal(unavailable.statusCode, 200);
  assert.equal(unavailable.json().artifacts[0].ref, 'org/repo#12');
  assert.equal(calls.length, 1);
});

test('title decoration preserves a remote caller address instead of promoting it to localhost', async (t) => {
  const { app, calls } = await fixture(t);
  const response = await app.inject({
    url: '/api/threads/T1/artifacts?view=works',
    remoteAddress: '203.0.113.10',
    headers: { 'x-cat-cafe-user': 'alice' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().artifacts[0].ref, 'org/repo#12');
  assert.equal(calls.length, 0);
});
