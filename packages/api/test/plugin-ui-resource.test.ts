import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import Fastify from 'fastify';
import { currentPluginOwnerRequestContext } from '../src/domains/plugin/carrier/plugin-owner-request-context.js';
import type { PluginRuntimeAdmission } from '../src/domains/plugin/carrier/runtime-carrier.js';
import { DeclaredPluginUi } from '../src/domains/plugin/declared/declared-plugin-ui.js';
import { DeclaredRuntimeContributions } from '../src/domains/plugin/declared/declared-runtime-contributions.js';
import { securityHeadersPlugin } from '../src/infrastructure/security-headers.js';
import { pluginUiRoutes } from '../src/routes/plugin/plugin-ui-routes.js';
import { pluginWebhookForwardingRoutes } from '../src/routes/plugin/plugin-webhook-forwarding-routes.js';

test('plugin resource isolation preserves document, asset and business response bytes', async (t) => {
  const responses = [
    { mime: 'text/html; charset=utf-8', body: '<p>HTML</p>' },
    { mime: 'Application/XHTML+XML; charset=utf-8', body: '<html xmlns="http://www.w3.org/1999/xhtml" />' },
    { mime: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" />' },
    { mime: 'image/svg+xml; charset=utf-8', body: Readable.from(['<svg />']) },
    { mime: 'text/css', body: 'body { color: red; }' },
    { mime: 'application/javascript', body: 'globalThis.loaded = true;' },
    { mime: 'image/png', body: Buffer.from([137, 80, 78, 71]) },
    { mime: 'application/json; charset=utf-8', body: { ok: true } },
  ];
  const app = Fastify();
  t.after(() => app.close());
  await app.register(securityHeadersPlugin);
  await app.register(pluginWebhookForwardingRoutes, {
    webhooks: {
      resolvePluginWebhook: (_pluginId, path) => ({
        contributionId: path,
        path,
        methods: ['GET'],
        anonymous: true,
      }),
      callPluginWebhook: async (_pluginId, id) => {
        const value = responses[Number(id)];
        assert.ok(value);
        return { status: 200, headers: { 'content-type': value.mime }, body: value.body };
      },
    },
  });
  for (const [index, value] of responses.entries()) {
    const response = await app.inject(`/api/plugins/dev.fixture/${index}`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], value.mime);
    const expected =
      value.body instanceof Readable
        ? Buffer.from('<svg />')
        : Buffer.isBuffer(value.body)
          ? value.body
          : Buffer.from(typeof value.body === 'string' ? value.body : JSON.stringify(value.body));
    assert.deepEqual(response.rawPayload, expected);
    assert.equal(
      response.headers['content-security-policy'],
      "sandbox allow-scripts; frame-ancestors 'none'",
      value.mime,
    );
  }
});

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
  await app.register(securityHeadersPlugin);
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
  assert.equal(page.headers['content-security-policy'], "sandbox allow-scripts; frame-ancestors 'none'");
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

test('authenticated panel work outlives the ordinary webhook budget', async (t) => {
  const ui = new DeclaredPluginUi();
  ui.activate({
    instance: { pluginInstanceId: 'fixture' },
    packageRecord: {
      pluginId: 'dev.fixture',
      manifest: {
        contributions: [
          { type: 'ui', id: 'open', kind: 'command', action: { method: 'panel' } },
          { type: 'ui', id: 'entry', kind: 'slot-item', command: 'open', group: 'activity-bar.bottom' },
          { type: 'webhook', id: 'page', path: 'panel', methods: ['GET'], action: { method: 'panel' } },
        ],
      },
    },
  } as unknown as PluginRuntimeAdmission);
  const [entry] = ui.list();
  assert.ok(entry);
  let release = () => {};
  const work = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  let ready = () => {};
  const running = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const app = Fastify();
  t.after(() => {
    release();
    t.mock.timers.reset();
    return app.close();
  });
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = 'owner';
  });
  await app.register(pluginWebhookForwardingRoutes, {
    ui,
    webhooks: {
      resolvePluginWebhook: (_pluginId, path) => ({
        contributionId: path,
        path,
        methods: ['POST'],
        anonymous: true,
        requestBodyLimitBytes: 1024 * 1024,
      }),
      callPluginWebhook: async () => {
        if (++entered === 2) ready();
        await work;
        return { status: 200, body: { completed: true } };
      },
    },
  });
  await app.ready();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [
    { method: 'POST' as const, url: '/api/plugins/dev.fixture/anonymous', payload: {} },
    {
      method: 'POST' as const,
      url: '/api/plugins/dev.fixture/feedback',
      payload: {},
      headers: {
        origin: 'http://localhost:5173',
        'x-clowder-plugin-ui-instance': 'fixture',
        'x-clowder-plugin-ui-generation': entry.generation,
      },
    },
  ];
  const completed = requests.map(() => false);
  const responses = requests.map((request, index) =>
    Promise.resolve(app.inject(request)).then((response) => {
      completed[index] = true;
      return response;
    }),
  );
  await running;
  t.mock.timers.tick(30_001);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed[0], true, 'ordinary webhooks retain the 30 second budget');
  assert.equal(completed[1], false, 'the authenticated panel keeps its interactive request alive');
  release();
  const [anonymous, panel] = await Promise.all(responses);
  assert.ok(anonymous && panel);
  assert.equal(anonymous.statusCode, 504);
  assert.equal(panel.statusCode, 200);
  assert.deepEqual(panel.json(), { completed: true });
});
