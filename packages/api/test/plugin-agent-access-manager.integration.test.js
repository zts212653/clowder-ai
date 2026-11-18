import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { roleConfigurationRevision } from '@clowder-ai/agent-access/roles/write-role';
import { validateManifest } from '@clowder-ai/plugin-contract';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  withPluginOwnerRequest,
  withPluginOwnerWebhook,
} from '../dist/domains/plugin/carrier/plugin-owner-request-context.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { registerAgentAccessRoutes } from '../dist/routes/agent-access-routes.js';
import { tarArchive } from '../scripts/bundled-plugin-artifacts.mjs';
import { canonicalGzip } from '../scripts/canonical-gzip.mjs';

test('Agent access discovery executes the same standalone entrypoint from a Manager archive across replacement and rollback', async (t) => {
  const pluginId = 'official.agent-access';
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-access-manager-'));
  const app = Fastify();
  const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
  process.env.CAT_CAFE_CONFIG_ROOT = projectRoot;
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    messageStore: new MessageStore(),
    contract: { manifestContractRange: '0.4.0-candidate.0', validateManifest },
  });
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
    else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
    await app.close();
    await runtime.shutdown();
    await rm(projectRoot, { recursive: true, force: true });
  });

  const manager = createPluginManagerRuntimeComposition({
    runtime,
    catalogManifests: [],
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 0 }) },
  }).manager;
  const owner = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = owner;
  });
  registerAgentAccessRoutes(app, { inventory: runtime.inventoryStore, runtime: runtime.supervisor });
  const scan = async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/agent-access/v1/detect',
      headers: { host: 'localhost:3004' },
      remoteAddress: '127.0.0.1',
      payload: { refresh: true },
    });
    assert.equal(result.statusCode, 200, result.payload);
    return result.json();
  };

  const entrypoint = await readFile(new URL('../../agent-access-plugin/dist/plugin/entrypoint.mjs', import.meta.url));
  async function archive(version) {
    const manifest = {
      pluginId,
      version,
      contractVersion: '0.4.0-candidate.0',
      name: 'Agent access discovery',
      features: [{ id: 'discovery', name: 'Client discovery', capabilities: [], resources: [] }],
      runtime: { transport: 'builtin', entrypoint: 'entrypoint.mjs' },
    };
    assert.deepEqual(validateManifest(manifest).errors ?? [], []);
    const output = join(projectRoot, `agent-access-${version}.tgz`);
    await writeFile(
      output,
      canonicalGzip(
        tarArchive([
          { name: 'package/manifest.json', bytes: Buffer.from(JSON.stringify(manifest)) },
          { name: 'package/entrypoint.mjs', bytes: entrypoint },
          {
            name: 'package/package.json',
            bytes: Buffer.from(JSON.stringify({ name: '@clowder-ai/agent-access', version, type: 'module' })),
          },
        ]),
      ),
    );
    return output;
  }
  const previous = await archive('1.0.0');
  const next = await archive('1.0.1');
  const install = (path) => manager.install({ source: { kind: 'local-archive', path } });
  assert.equal((await scan()).readiness.state, 'missing');
  const installed = await install(previous);
  await manager.setEnabled(pluginId, {
    enabled: true,
    expectedRevision: (await manager.get(pluginId)).plugin.lifecycleRevision,
  });
  const first = await scan();
  assert.equal(first.readiness.state, 'ready', JSON.stringify(first.readiness));
  assert.ok(first.candidates.some((candidate) => candidate.id === 'codex'));

  const catalogPath = join(projectRoot, '.cat-cafe', 'cat-catalog.json');
  await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
  await writeFile(catalogPath, JSON.stringify({ version: 1, breeds: [] }));
  const readCatalog = async () => JSON.parse(await readFile(catalogPath, 'utf8'));
  const request = {
    kind: 'create',
    input: {
      catId: 'isolated-role',
      name: 'Isolated role',
      displayName: 'Isolated role',
      avatar: '/avatars/default.png',
      color: { primary: '#101010', secondary: '#eeeeee' },
      mentionPatterns: ['@isolated-role'],
      roleDescription: 'Plugin-owned role write',
      clientId: 'openai',
      carrier: 'cli',
      defaultModel: 'fixture',
      mcpSupport: false,
      cli: { command: 'codex', outputFormat: 'json' },
    },
  };
  await assert.rejects(runtime.supervisor.invoke(installed.pluginInstanceId, 'writeRole', request));
  assert.equal((await readCatalog()).breeds.length, 0);

  const mutate = (input) =>
    withPluginOwnerRequest(
      {
        pluginId,
        contributionId: 'writeRole',
        userId: owner,
        operation: 'write',
        signal: new AbortController().signal,
      },
      () =>
        withPluginOwnerWebhook(
          pluginId,
          'writeRole',
          installed.pluginInstanceId,
          false,
          () => {},
          () => runtime.supervisor.invoke(installed.pluginInstanceId, 'writeRole', input),
        ),
    );
  assert.deepEqual(await mutate(request), { status: 'committed', catId: request.input.catId });
  assert.equal((await readCatalog()).breeds[0].catId, request.input.catId);
  const before = roleConfigurationRevision(await readCatalog(), request.input.catId);

  const latest = await install(next);
  assert.equal(latest.pluginInstanceId, installed.pluginInstanceId);
  assert.equal((await scan()).readiness.state, 'ready');
  assert.equal((await manager.get(pluginId)).plugin.installedVersion, '1.0.1');

  assert.deepEqual(
    await mutate({
      kind: 'update',
      catId: request.input.catId,
      expectedRevision: before,
      patch: { displayName: 'Renamed during upgrade' },
    }),
    { status: 'committed', catId: request.input.catId },
  );
  assert.deepEqual(
    await mutate({
      kind: 'delete',
      catId: request.input.catId,
      expectedRevision: before,
    }),
    { status: 'conflict' },
  );

  await install(previous);
  assert.equal((await manager.get(pluginId)).plugin.installedVersion, '1.0.0');
  assert.equal((await scan()).readiness.state, 'ready');
  const restored = await readCatalog();
  assert.equal(restored.breeds[0].displayName, 'Renamed during upgrade');
  assert.deepEqual(
    await mutate({
      kind: 'delete',
      catId: request.input.catId,
      expectedRevision: roleConfigurationRevision(restored, request.input.catId),
    }),
    { status: 'committed', catId: request.input.catId },
  );
  assert.equal((await readCatalog()).breeds.length, 0);
});
