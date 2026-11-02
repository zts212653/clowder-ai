import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { currentPluginOwnerRequestContext } from '../src/domains/plugin/carrier/plugin-owner-request-context.js';
import type { PluginRuntimeAdmission } from '../src/domains/plugin/carrier/runtime-carrier.js';
import { DeclaredPluginUi } from '../src/domains/plugin/declared/declared-plugin-ui.js';
import { DeclaredRuntimeContributions } from '../src/domains/plugin/declared/declared-runtime-contributions.js';
import { pluginUiRoutes } from '../src/routes/plugin/plugin-ui-routes.js';
import { pluginWebhookForwardingRoutes } from '../src/routes/plugin/plugin-webhook-forwarding-routes.js';

test('HTML and business requests share declared HTTP dispatch; UI only discovers and revokes resources', async (t) => {
  const action = { method: 'panel', params: { pane: 'diagnostics' } };
  const admission = {
    instance: { pluginInstanceId: 'fixture' },
    packageRecord: {
      pluginId: 'dev.fixture',
      manifest: {
        contributions: [
          { type: 'ui', id: 'open', kind: 'command', action },
          {
            type: 'ui',
            id: 'entry',
            kind: 'slot-item',
            command: 'open',
            label: 'Fixture',
            group: 'activity-bar.bottom',
          },
          { type: 'webhook', id: 'page', path: 'panel', methods: ['GET'], action },
          { type: 'webhook', id: 'business', path: 'feedback', methods: ['POST'], action: { method: 'business' } },
        ],
      },
    },
  } as unknown as PluginRuntimeAdmission;
  const ui = new DeclaredPluginUi();
  ui.activate(admission);
  const calls: { method: string; input: unknown }[] = [];
  const contexts: NonNullable<ReturnType<typeof currentPluginOwnerRequestContext>>[] = [];
  const contributions = new DeclaredRuntimeContributions({
    packages: {
      resolveInstalledPackage: async () => {
        throw new Error('no executable package needed');
      },
    },
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
  });
  await contributions.activate(admission, async (_id, method, input) => {
    const context = currentPluginOwnerRequestContext('fixture');
    assert.equal(context?.userId, 'owner');
    assert.equal(context?.operation, method === 'panel' ? 'read' : 'write');
    assert.ok(context);
    contexts.push(context);
    calls.push({ method, input });
    return {
      status: 200,
      headers: { 'content-type': method === 'panel' ? 'text/html' : 'application/json' },
      body: method === 'panel' ? '<p>declared HTML</p>' : { ok: true },
    };
  });
  t.after(() => contributions.deactivateAll());
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('onRequest', async (request) => {
    if (request.headers['x-fixture-owner']) request.sessionUserId = 'owner';
  });
  await app.register(pluginUiRoutes, { ui });
  await app.register(pluginWebhookForwardingRoutes, { ui, webhooks: contributions });
  const [entry] = ui.list();
  assert.ok(entry);
  const legacy = await app.inject({
    method: 'POST',
    url: '/api/plugin-ui/fixture/open',
    headers: { origin: 'http://localhost:5173' },
    payload: { generation: entry.generation },
  });
  assert.equal(legacy.statusCode, 404, 'no second request dispatcher remains even for HTML loading');
  assert.equal(entry.resourcePath, 'panel');
  const headers = {
    origin: 'http://localhost:5173',
    'x-fixture-owner': 'yes',
    'x-clowder-plugin-ui-instance': 'fixture',
    'x-clowder-plugin-ui-generation': entry.generation,
  };
  const { 'x-fixture-owner': _owner, ...anonymous } = headers;
  assert.ok(
    [401, 403].includes(
      (await app.inject({ method: 'GET', url: '/api/plugins/dev.fixture/panel', headers: anonymous })).statusCode,
    ),
  );
  assert.equal(calls.length, 0);
  const page = await app.inject({ method: 'GET', url: '/api/plugins/dev.fixture/panel', headers });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'] ?? '', /text\/html/);
  assert.equal(page.body, '<p>declared HTML</p>');
  assert.equal((calls[0]!.input as { pane: string }).pane, 'diagnostics');
  await assert.rejects(contexts[0]!.assertCurrent(), /no longer current/);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/plugins/dev.fixture/feedback',
        headers,
        payload: { op: 'list', userId: 'forged' },
      })
    ).statusCode,
    200,
  );
  assert.equal(calls.length, 2);
  ui.deactivateAll();
  ui.activate(admission);
  assert.equal((await app.inject({ method: 'GET', url: '/api/plugins/dev.fixture/panel', headers })).statusCode, 409);
  assert.equal(calls.length, 2);
});
