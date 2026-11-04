import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { FilesystemVerifiedPluginPackageLocator } from '../dist/domains/plugin/external-runtime/filesystem-package-locator.js';
import {
  HostInventoryControlPlane,
  LocalPluginPackageAdmission,
  MemoryPluginInventoryStore,
} from '../dist/domains/plugin/index.js';
import { registerAgentClientLibraryRoutes } from '../dist/routes/agent-client-library-routes.js';

test('plugin model discovery resolves only verified enabled owner packages and is scoped to saved launch revisions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-model-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await cp(new URL('./fixtures/agent-session-reference/plugin/', import.meta.url), source, { recursive: true });
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  manifest.configuration = [{ key: 'connection', kind: 'string', label: 'Connection', required: false, default: '{}' }];
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(
    join(source, 'agent-provider.json'),
    JSON.stringify({
      id: 'agent',
      transport: 'acp',
      configurationKey: 'connection',
      acp: { command: 'codeagent', startupArgs: ['--acp'] },
    }),
  );
  const store = new MemoryPluginInventoryStore();
  const packagesRoot = join(root, 'packages');
  await new LocalPluginPackageAdmission({ inventory: new HostInventoryControlPlane(store), packagesRoot }).install({
    kind: 'local-directory',
    path: source,
  });
  const registry = new SessionImplementationRegistry();
  const ref = { pluginId: manifest.pluginId, contributionId: 'agent' };
  const unregister = registry.register(ref, () => {
    throw new Error('model discovery must not run a member');
  });
  t.after(unregister);
  const calls = [];
  let config = '{}';
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session-user'];
  });
  registerAgentClientLibraryRoutes(app, {
    inventory: store,
    packages: new FilesystemVerifiedPluginPackageLocator(packagesRoot),
    registry,
    configuration: { readConfig: async () => config },
    projectRoot: () => root,
    probe: async (target) => {
      calls.push(target);
      return {
        status: 'live',
        models: [{ value: 'model-a', label: 'A' }],
        defaultModel: 'model-a',
        defaultModelStatus: 'reported',
      };
    },
  });
  t.after(() => app.close());
  const headers = { host: 'localhost:4312', 'x-test-session-user': process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user' };
  const payload = { ref: `plugin:${ref.pluginId}/${ref.contributionId}` };
  const request = (body = payload, requestHeaders = headers) =>
    app.inject({ method: 'POST', url: '/api/agent-providers/models', headers: requestHeaders, payload: body });
  assert.equal((await request(payload, { host: 'localhost:4312' })).statusCode, 401);
  assert.equal((await request({ ...payload, command: 'untrusted' })).statusCode, 400);
  assert.equal((await request()).statusCode, 409, 'disabled plugin does not start a probe');
  assert.equal(calls.length, 0);
  await store.transaction((tx) => {
    const instance = tx.instances.list()[0];
    tx.instances.put({ ...instance, activationState: 'enabled', configReadiness: 'ready' });
  });
  const ready = await request();
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.json().defaultModel, 'model-a');
  assert.equal(ready.json().contextDelivery, 'prompt_compatibility');
  assert.equal(calls[0].command, 'codeagent');
  await request();
  assert.equal(calls.length, 1, 'same admitted source uses bounded cached discovery');
  config = JSON.stringify({ command: process.execPath, startupArgs: ['--different'] });
  await request();
  assert.equal(calls.length, 2, 'saved launch values invalidate model discovery even without a lifecycle revision');
  assert.equal(calls[1].command, process.execPath);
  config = '{';
  assert.equal(
    (await request()).statusCode,
    409,
    'invalid saved configuration remains repairable without starting a probe',
  );
  assert.equal(calls.length, 2);
  config = '{}';
  assert.equal((await request()).statusCode, 200);
  unregister();
  assert.equal((await request()).statusCode, 409, 'cached models do not bypass a removed registration');
  assert.equal(calls.length, 2);
});
