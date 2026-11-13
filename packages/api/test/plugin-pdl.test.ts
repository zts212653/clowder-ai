import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import { type PluginPdlFragment } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { validateHostPluginManifest } from '../src/domains/plugin/desktop-window-runtime/presentation-manifest.js';
import {
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  parsePluginInventorySnapshot,
} from '../src/domains/plugin/host-inventory/index.js';
import { PluginManagerService } from '../src/domains/plugin/manager/plugin-manager-service.js';
import { registerPluginManagerRoutes } from '../src/routes/plugin-manager-routes.js';

const pdl: PluginPdlFragment = {
  id: 'test.spaces',
  inserts: [
    {
      id: 'test.space',
      anchor: 'rail.top',
      at: 'inside',
      node: { title: 'Space', icon: 'box', open: { node: 'test.client' } },
    },
  ],
  views: {
    'test.page': { route: 'test-view', vm: 'chatHeader', blocks: [{ type: 'text', text: 'Plugin-owned PDL content' }] },
    'test.client': { type: 'frame', route: 'plug-test', src: 'https://plugin.test/' },
  },
};
const manifest = {
  pluginId: 'dev.clowder.spaces',
  version: '1.0.0',
  contractVersion: '0.1.0',
  name: 'Spaces',
  features: [{ id: 'messaging', name: 'Messaging', resources: [], capabilities: ['messaging.send'] }],
  runtime: { transport: 'builtin' },
  pdl,
};

it('admits the PDL manifest extension without weakening base manifest or package identity checks', async () => {
  const accepted = validateHostPluginManifest(manifest);
  assert.equal(accepted.valid, true);
  assert.equal(
    validateHostPluginManifest({ ...manifest, runtime: { transport: 'stdio', entrypoint: '../outside.js' } }).valid,
    false,
  );
  assert.equal(validateHostPluginManifest({ ...manifest, pdl: { id: 'bad', views: [] } }).valid, false);
  assert.equal(validateHostPluginManifest({ ...manifest, unexpected: true }).valid, false);
  const inventory = new MemoryPluginInventoryStore();
  const control = new HostInventoryControlPlane(inventory);
  const digest = `sha512-${createHash('sha512').update('pdl-archive-bytes').digest('base64')}`;
  const otherDigest = `sha512-${createHash('sha512').update('different-archive').digest('base64')}`;
  await assert.rejects(
    control.installPackage({
      manifest,
      packagePluginId: manifest.pluginId,
      computedPackageDigest: digest,
      expectedPackageDigest: otherDigest,
    }),
    { code: 'PACKAGE_DIGEST_MISMATCH' },
  );
  await control.installPackage({
    manifest,
    packagePluginId: manifest.pluginId,
    computedPackageDigest: digest,
    expectedPackageDigest: digest,
  });
  const snapshot = await inventory.snapshot();
  const restored = parsePluginInventorySnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored.packages[0]!.manifest, manifest);
});

it('exposes only current admitted installed fragments through the authenticated manager endpoint', async () => {
  const inventory = new MemoryPluginInventoryStore();
  const control = new HostInventoryControlPlane(inventory);
  const digest = `sha512-${createHash('sha512').update('spaces').digest('base64')}`;
  await control.installPackage({
    manifest,
    packagePluginId: manifest.pluginId,
    computedPackageDigest: digest,
    expectedPackageDigest: digest,
  });
  let snapshot = await inventory.snapshot();
  const manager = new PluginManagerService({
    inventory: { snapshot: async () => snapshot },
    catalog: { snapshot: async () => ({ candidates: [], status: 'fresh', refreshedAt: 1 }) },
  });
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    if (request.headers['x-test-session-user'] === 'owner') request.sessionUserId = 'owner';
  });
  registerPluginManagerRoutes(app, { manager });
  try {
    const url = '/api/plugin-manager/pdl';
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
    const response = await app.inject({ method: 'GET', url, headers: { 'x-test-session-user': 'owner' } });
    assert.equal(response.statusCode, 200, response.body);
    // The index registers at start: view content waits in the subtree, read on first projection.
    const { subtree: revision, ...index } = response.json().fragments[manifest.pluginId];
    assert.deepEqual(index, {
      ...pdl,
      views: { 'test.page': { route: 'test-view' }, 'test.client': pdl.views!['test.client'] },
    });
    assert.match(revision, /^[0-9a-f]{64}$/);
    const subtree = await app.inject({
      method: 'GET',
      url: `${url}/${manifest.pluginId}`,
      headers: { 'x-test-session-user': 'owner' },
    });
    assert.equal(subtree.statusCode, 200, subtree.body);
    assert.deepEqual(subtree.json(), { views: pdl.views });
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `${url}/dev.clowder.absent`,
          headers: { 'x-test-session-user': 'owner' },
        })
      ).statusCode,
      404,
    );
    // Disabled intent does not discard the manifest: the engine owns enable/disable projection.
    assert.equal(snapshot.instances[0]!.activationState, 'disabled');
    const fragment = (await manager.pdl()).fragments[manifest.pluginId]!;
    fragment.id = 'mutated';
    assert.equal((await manager.pdl()).fragments[manifest.pluginId]!.id, pdl.id);
    snapshot = {
      ...snapshot,
      instances: snapshot.instances.map((instance) => ({ ...instance, lifecycleState: 'retired' as const })),
    };
    assert.deepEqual(await manager.pdl(), { fragments: {} });
  } finally {
    await app.close();
  }
});

it('serves an installed plugin console: the manifest pdl section with the package console files beside it', async () => {
  const inventory = new MemoryPluginInventoryStore();
  const control = new HostInventoryControlPlane(inventory);
  const github = {
    ...manifest,
    pluginId: 'official.github-operations',
    name: 'GitHub Operations',
    pdl: { ns: 'github', views: { 'github.community': { blocks: [{ type: 'text', text: 't:github.title' }] } } },
  };
  const digest = `sha512-${createHash('sha512').update('github-console').digest('base64')}`;
  await control.installPackage({
    manifest: github,
    packagePluginId: github.pluginId,
    computedPackageDigest: digest,
    expectedPackageDigest: digest,
  });
  const snapshot = await inventory.snapshot();
  const manager = new PluginManagerService({
    inventory: { snapshot: async () => snapshot },
    catalog: { snapshot: async () => ({ candidates: [], status: 'fresh', refreshedAt: 1 }) },
    consoleFiles: async (pluginId) =>
      pluginId === github.pluginId
        ? {
            components: { js: ["PDL_COMPONENTS['plugin:x/card'] = () => '';"], css: [] },
            i18n: { zh: { title: '社区' } },
          }
        : {},
  });
  const fragment = (await manager.pdl()).fragments[github.pluginId]!;
  assert.equal(fragment.ns, 'github');
  assert.equal((fragment.i18n!.zh as { title: unknown }).title, '社区');
  assert.equal(fragment.components, undefined);
  const subtree = await manager.pdlSubtree(github.pluginId);
  assert.ok(subtree.views!['github.community']!.blocks);
  assert.match(subtree.components!.js[0]!, /plugin:x\/card/);
});
