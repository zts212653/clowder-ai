import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FilePluginCapabilityKeyring } from '../src/domains/plugin/capability-token/plugin-capability-token.js';
import {
  MemoryPluginExternalAccessStore,
  PluginExternalAccessService,
} from '../src/domains/plugin/external-access/plugin-external-access.js';

const packageDigest = `sha512-${Buffer.alloc(64).toString('base64')}`;
const instance = {
  pluginInstanceId: 'instance-a',
  pluginId: 'fixture.plugin',
  packageDigest,
  lifecycleState: 'installed',
  configReadiness: 'ready',
  activationState: 'enabled',
  runtimeState: 'healthy',
  lifecycleRevision: 1,
  installedAt: 1,
  updatedAt: 1,
};
const manifest = {
  pluginId: 'fixture.plugin',
  version: '1.0.0',
  contractVersion: '0.3.1-candidate.2',
  name: 'Fixture',
  contributions: [{ type: 'external-request', id: 'fixture-mcp' }],
  features: [
    { id: 'main', name: 'Main', resources: [], contributions: [{ type: 'external-request', id: 'fixture-mcp' }] },
  ],
};

test('a signed credential transition retires only the same installation legacy bearer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-signed-retirement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new MemoryPluginExternalAccessStore();
  await store.adopt('instance-a', 'legacy-token');
  const tokens = new FilePluginCapabilityKeyring({ path: join(root, 'keyring.json') });
  let transition = false;
  const service = new PluginExternalAccessService({
    endpoint: '/api/plugin-runtime/handle',
    store,
    tokens,
    inventory: {
      snapshot: async () =>
        ({
          schemaVersion: 1,
          packages: [{ packageDigest, pluginId: 'fixture.plugin', manifest }],
          grants: [],
          instances: [instance],
        }) as never,
    },
    handler: {
      async handle(_instanceId, _request, credential) {
        return transition
          ? { status: 200, body: { ok: true }, hostEffects: { retireLegacyCredential: { tokenId: credential?.jti } } }
          : { status: 200, body: { ok: false } };
      },
    },
  });
  const issued = await service.issueExternal('instance-a', { capabilityId: 'fixture-mcp', ttlSeconds: 60 });
  await service.handle(issued.token, { method: 'POST', headers: {}, body: {} });
  assert.equal(await store.resolve('legacy-token'), 'instance-a');
  transition = true;
  assert.deepEqual(await service.handle(issued.token, { method: 'POST', headers: {}, body: {} }), {
    status: 200,
    body: { ok: true },
  });
  assert.equal(await store.resolve('legacy-token'), undefined);
});
