import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { ENV_VARS, isEditableEnvVarName } from '../dist/config/env-registry.js';
import { PluginManagerServiceError } from '../dist/domains/plugin/index.js';
import { registerPluginManagerRoutes } from '../dist/routes/plugin-manager-routes.js';

const headers = {
  host: 'localhost:4312',
  origin: 'http://localhost:4311',
  'x-test-session-user': process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user',
};
test('compatibility is registered as an explicit restart-required deployment policy', () => {
  const policy = ENV_VARS.find((entry) => entry.name === 'CAT_CAFE_TRUSTED_HOST_COMPATIBILITY');
  assert.ok(policy);
  assert.equal(policy.defaultValue, '0');
  assert.equal(policy.restartRequired, true);
  assert.equal(isEditableEnvVarName(policy.name), false);
});
async function harness(t, { mode, configureError, auditFailures = Infinity } = {}) {
  const original = process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY;
  const originalOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = headers['x-test-session-user'];
  if (mode === undefined) delete process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY;
  else process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY = mode;
  t.after(() => {
    if (originalOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = originalOwner;
    if (original === undefined) delete process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY;
    else process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY = original;
  });
  const app = Fastify();
  const mutations = [];
  let audits = 0;
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session-user'];
  });
  registerPluginManagerRoutes(app, {
    manager: {
      configure: async (id, request) => {
        if (configureError) throw configureError;
        mutations.push({ id, request });
        return { pluginId: id, pluginInstanceId: 'compat-instance' };
      },
      setEnabled: async () => {
        throw new Error('must retain audit admission');
      },
    },
    auditLog: {
      append: async () => {
        if (++audits <= auditFailures) throw new Error('EPERM: do not expose raw audit payload');
      },
    },
  });
  t.after(() => app.close());
  await app.ready();
  const save = (overrides = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/official.acp-clients/contributions/configuration',
      headers,
      remoteAddress: '127.0.0.1',
      payload: { expectedRevision: 1, updates: [{ key: 'clients', value: 'private-value' }] },
      ...overrides,
    });
  return { save, mutations, audits: () => audits, app };
}

for (const mode of [undefined, 'true']) {
  test(`audit failure still rejects configuration without exact opt-in (${mode})`, async (t) => {
    const h = await harness(t, { mode });
    const response = await h.save();
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'AUDIT_UNAVAILABLE');
    assert.deepEqual(h.mutations, []);
  });
}
test('legacy compatibility never implicitly waives configuration audit', async (t) => {
  const h = await harness(t, { mode: '1' });
  const response = await h.save();
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(h.mutations.length, 0);
  assert.equal(h.audits(), 1);
  assert.equal(response.json().warning, undefined);
  assert.doesNotMatch(response.body, /private-value|raw audit payload/);
});
test('compatibility never converts a configuration failure into saved success', async (t) => {
  const h = await harness(t, {
    mode: '1',
    auditFailures: 0,
    configureError: new PluginManagerServiceError('INVALID_CONFIGURATION', 'invalid client'),
  });
  const response = await h.save();
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'INVALID_CONFIGURATION');
  assert.equal(response.json().warning, undefined);
  assert.deepEqual(h.mutations, []);
});
test('compatibility retains owner, origin and local-address admission', async (t) => {
  const h = await harness(t, { mode: '1' });
  for (const overrides of [
    { remoteAddress: '10.0.0.23' },
    { headers: { ...headers, origin: 'https://untrusted.invalid' } },
    { headers: { ...headers, 'x-test-session-user': 'someone-else' } },
  ]) {
    const response = await h.save(overrides);
    assert.equal(response.statusCode, 403, response.body);
  }
  assert.deepEqual(h.mutations, []);
  assert.equal(h.audits(), 0);
});
test('audit recovery clears warnings on the next explicit save', async (t) => {
  const h = await harness(t, { mode: '1', auditFailures: 1 });
  assert.equal((await h.save()).statusCode, 503);
  const recovered = await h.save();
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.json().warning, undefined);
  assert.equal(h.mutations.length, 1);
});
test('compatibility does not waive audit admission for plugin activation', async (t) => {
  const h = await harness(t, { mode: '1' });
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/plugin-manager/plugins/official.acp-clients/set-enabled',
    headers,
    remoteAddress: '127.0.0.1',
    payload: { enabled: true, expectedRevision: 1 },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, 'AUDIT_UNAVAILABLE');
});
