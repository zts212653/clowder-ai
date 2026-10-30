import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { currentPluginOwnerRequestContext } from '../src/domains/plugin/carrier/plugin-owner-request-context.js';
import type { PluginRuntimeAdmission } from '../src/domains/plugin/carrier/runtime-carrier.js';
import { DeclaredPluginUi } from '../src/domains/plugin/declared/declared-plugin-ui.js';
import { pluginUiRoutes } from '../src/routes/plugin/plugin-ui-routes.js';

const admission = {
  instance: { pluginInstanceId: 'fixture' },
  packageRecord: {
    pluginId: 'official.fixture',
    manifest: {
      contributions: [
        { type: 'ui', id: 'open', kind: 'command', action: { method: 'panel' } },
        {
          type: 'ui',
          id: 'entry',
          kind: 'slot-item',
          label: '问题反馈',
          command: 'open',
          group: 'activity-bar.bottom',
        },
        { type: 'ui', id: 'unrelated', kind: 'slot-item', label: 'Other', command: 'open', group: 'composer.actions' },
      ],
    },
  },
} as unknown as PluginRuntimeAdmission;

test('two ordinary packages can use the same sidebar registry', () => {
  const ui = new DeclaredPluginUi(async () => undefined);
  ui.activate(admission);
  ui.activate({
    ...admission,
    instance: { ...admission.instance, pluginInstanceId: 'second' },
    packageRecord: { ...admission.packageRecord, pluginId: 'dev.unrelated' },
  });
  assert.deepEqual(
    ui.list().map((entry) => entry.instanceId),
    ['fixture', 'second'],
  );
});

test('installed UI dispatch derives owner facts, rejects anonymous/stale calls and fences retained authority', async () => {
  let retained: ReturnType<typeof currentPluginOwnerRequestContext>;
  let calls = 0;
  const ui = new DeclaredPluginUi(async (id, method) => {
    calls++;
    retained = currentPluginOwnerRequestContext(id);
    assert.equal(method, 'panel');
    assert.equal(retained?.userId, 'fixture-owner');
    return { html: '<p>panel</p>' };
  });
  ui.activate(admission);
  const generation = ui.list()[0]!.generation;
  assert.equal(ui.list().length, 1);
  await assert.rejects(ui.call('fixture', 'open', generation, {}), /owner request/);
  const app = Fastify();
  app.decorateRequest('sessionUserId', undefined);
  app.addHook('onRequest', async (request) => {
    if (request.headers['x-fixture-owner']) request.sessionUserId = 'fixture-owner';
  });
  await app.register(pluginUiRoutes, { ui });
  try {
    const url = '/api/plugin-ui/fixture/open';
    const payload = { generation, input: { op: 'open', userId: 'forged' } };
    assert.ok([401, 403].includes((await app.inject({ method: 'POST', url, payload })).statusCode));
    const result = await app.inject({
      method: 'POST',
      url,
      payload,
      headers: { 'x-fixture-owner': 'yes', origin: 'http://localhost:5173' },
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(calls, 1);
    await assert.rejects(retained!.assertCurrent(), /no longer current/);
    ui.deactivate('fixture');
    assert.deepEqual(ui.list(), []);
    ui.activate(admission);
    const stale = await app.inject({
      method: 'POST',
      url,
      payload,
      headers: { 'x-fixture-owner': 'yes', origin: 'http://localhost:5173' },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});
