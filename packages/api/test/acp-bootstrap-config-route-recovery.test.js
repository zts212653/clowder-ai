import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import Fastify from 'fastify';
import { registerPluginManagerConfigurationRoute } from '../dist/routes/plugin-manager-configuration-route.js';
import { rootRecoveryFixture } from './helpers/acp-root-recovery-fixture.js';

const keys = [
  'DEFAULT_OWNER_USER_ID',
  'API_SERVER_HOST',
  'CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE',
  'CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE',
];
let original;
beforeEach(() => {
  original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.DEFAULT_OWNER_USER_ID = 'root-recovery-owner';
  process.env.API_SERVER_HOST = '127.0.0.1';
  process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = 'trusted-host';
  process.env.CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE = 'warn-bootstrap-root';
});
afterEach(() => {
  for (const key of keys)
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
});

async function harness(t) {
  const f = await rootRecoveryFixture();
  let fail = true;
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    if (request.headers['x-fixture-session']) request.sessionUserId = request.headers['x-fixture-session'];
    if (request.headers['x-fixture-callback'])
      request.callbackPrincipal = { userId: 'root-recovery-owner', catId: 'codeagent' };
  });
  registerPluginManagerConfigurationRoute(
    app,
    {
      manager: {
        configure: async (id, mutation) => {
          await f.service.configure(id, f.instance.pluginInstanceId, mutation);
          return { pluginId: id };
        },
        configureBootstrapRoot: async (id, mutation) => {
          await f.service.configureBootstrapRoot(id, f.instance.pluginInstanceId, mutation);
          return { pluginId: id };
        },
      },
    },
    {
      append: async () => {
        if (fail) throw Object.assign(new Error('audit failure'), { code: 'EPERM' });
      },
    },
  );
  t.after(() => app.close());
  const headers = {
    host: 'localhost:4512',
    origin: 'http://localhost:4511',
    'x-fixture-session': 'root-recovery-owner',
  };
  const save = (extra = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/test.acp-library/contributions/configuration',
      remoteAddress: '127.0.0.1',
      headers,
      payload: f.request(),
      ...extra,
    });
  return {
    f,
    headers,
    save,
    restoreAudit: () => {
      fail = false;
    },
  };
}

test(
  'only an owner human can use audit recovery; next audited save clears the warning',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const h = await harness(t);
    for (const extra of [
      { headers: { ...h.headers, 'x-fixture-callback': '1' } },
      { headers: { host: 'localhost:4512', origin: h.headers.origin, 'x-fixture-callback': '1' } },
      { remoteAddress: '10.0.0.5' },
      { headers: { ...h.headers, origin: 'https://evil.invalid' } },
      { headers: { ...h.headers, 'x-fixture-session': 'someone-else' } },
    ])
      assert.ok((await h.save(extra)).statusCode >= 400);
    delete process.env.DEFAULT_OWNER_USER_ID;
    assert.equal((await h.save()).statusCode, 503);
    process.env.DEFAULT_OWNER_USER_ID = 'root-recovery-owner';
    const saved = await h.save();
    assert.equal(saved.statusCode, 200, saved.body);
    assert.match(saved.json().warning, /引导目录.*审计/);
    assert.equal((await h.save()).statusCode, 409, 'stale request cannot use previous admission');
    h.restoreAudit();
    const recovered = await h.save({
      payload: { ...h.f.request(), expectedRevision: (await h.f.inventory.snapshot()).instances[0].lifecycleRevision },
    });
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal(recovered.json().warning, undefined);
  },
);
