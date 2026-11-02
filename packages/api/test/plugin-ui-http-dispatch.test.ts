import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { PluginRuntimeAdmission } from '../src/domains/plugin/carrier/runtime-carrier.js';
import { DeclaredPluginUi } from '../src/domains/plugin/declared/declared-plugin-ui.js';
import { pluginUiRoutes } from '../src/routes/plugin/plugin-ui-routes.js';
import { pluginWebhookForwardingRoutes } from '../src/routes/plugin/plugin-webhook-forwarding-routes.js';

const admission = {
  instance: { pluginInstanceId: 'fixture' },
  packageRecord: {
    pluginId: 'dev.fixture',
    manifest: {
      contributions: [
        { type: 'ui', id: 'open', kind: 'command', action: { method: 'panel', params: { pane: 'diagnostics' } } },
        { type: 'ui', id: 'entry', kind: 'slot-item', command: 'open', label: 'Fixture', group: 'activity-bar.bottom' },
      ],
    },
  },
} as unknown as PluginRuntimeAdmission;

test('UI endpoint mounts only; subsequent business requests use declared HTTP routing and stale panels are fenced', async (t) => {
  const calls: unknown[] = [];
  const ui = new DeclaredPluginUi(async (_id, _method, input) => {
    calls.push(input);
    return { kind: 'plugin-panel', version: 1, html: '<p>Fixture</p>' };
  });
  ui.activate(admission);
  const generation = ui.list()[0]!.generation;
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = 'owner';
  });
  await app.register(pluginUiRoutes, { ui });
  let requests = 0;
  await app.register(pluginWebhookForwardingRoutes, {
    ui,
    webhooks: {
      resolvePluginWebhook: (pluginId, path) =>
        pluginId === 'dev.fixture' && path === 'feedback'
          ? { contributionId: 'http', path, methods: ['POST'], anonymous: false }
          : undefined,
      callPluginWebhook: async (_pluginId, _id, request) => {
        requests++;
        return { status: 200, body: JSON.stringify(request.body), headers: { 'content-type': 'application/json' } };
      },
    },
  });
  const headers = { origin: 'http://localhost:5173' };
  const rejected = await app.inject({
    method: 'POST',
    url: '/api/plugin-ui/fixture/open',
    headers,
    payload: { generation, input: { op: 'submit', userId: 'forged' } },
  });
  assert.equal(rejected.statusCode, 400, 'mount must not remain a second business-operation dispatcher');
  assert.equal(calls.length, 0);
  const mounted = await app.inject({
    method: 'POST',
    url: '/api/plugin-ui/fixture/open',
    headers,
    payload: { generation },
  });
  assert.equal(mounted.statusCode, 200);
  assert.deepEqual(calls[0], { op: 'open', pane: 'diagnostics' });
  const request = {
    method: 'POST' as const,
    url: '/api/plugins/dev.fixture/feedback',
    payload: { op: 'list' },
    headers: { ...headers, 'x-clowder-plugin-ui-instance': 'fixture', 'x-clowder-plugin-ui-generation': generation },
  };
  assert.equal((await app.inject(request)).statusCode, 200);
  assert.equal(requests, 1);
  ui.deactivateAll();
  ui.activate(admission);
  assert.equal((await app.inject(request)).statusCode, 409);
  assert.equal(requests, 1);
});
