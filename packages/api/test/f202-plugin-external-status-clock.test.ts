import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FilePluginCapabilityKeyring } from '../src/domains/plugin/capability-token/plugin-capability-token.js';
import {
  MemoryPluginExternalAccessStore,
  PluginExternalAccessService,
} from '../src/domains/plugin/external-access/plugin-external-access.js';

test('external token status uses the same authority clock as signing and verification', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-external-clock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const tokens = new FilePluginCapabilityKeyring({
    path: join(root, 'capability-keyring.json'),
    now: () => now,
  });
  const instance = {
    pluginInstanceId: 'instance-a',
    pluginId: 'fixture.plugin',
    packageDigest: `sha512-${Buffer.alloc(64).toString('base64')}`,
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
    name: 'Clock fixture',
    contributions: [{ type: 'external-request', id: 'fixture-mcp' }],
    features: [
      {
        id: 'main',
        name: 'Main',
        resources: [],
        contributions: [{ type: 'external-request', id: 'fixture-mcp' }],
      },
    ],
  };
  const service = new PluginExternalAccessService({
    endpoint: '/api/plugin-runtime/handle',
    store: new MemoryPluginExternalAccessStore(),
    tokens,
    now: () => now,
    inventory: {
      snapshot: async () =>
        ({
          schemaVersion: 1 as const,
          packages: [{ pluginId: 'fixture.plugin', packageDigest: instance.packageDigest, manifest }],
          grants: [],
          instances: [instance],
        }) as never,
    },
    handler: {
      async handle() {
        return { status: 200 };
      },
    },
  });

  const issued = await service.issueExternal('instance-a', {
    capabilityId: 'fixture-mcp',
    ttlSeconds: 3_600,
  });
  assert.equal(
    (
      await service.inspectExternal('instance-a', {
        token: issued.token,
        capabilityId: 'fixture-mcp',
      })
    ).remainingSeconds,
    3_600,
  );

  now += 1_800_000;
  assert.equal(
    (
      await service.inspectExternal('instance-a', {
        token: issued.token,
        capabilityId: 'fixture-mcp',
      })
    ).remainingSeconds,
    1_800,
  );
});
