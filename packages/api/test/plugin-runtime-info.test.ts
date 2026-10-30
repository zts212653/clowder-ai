import assert from 'node:assert/strict';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import {
  withPluginOwnerRequest,
  withPluginOwnerWebhook,
} from '../src/domains/plugin/carrier/plugin-owner-request-context.js';
import { createPluginNeutralHost } from '../src/domains/plugin/host-surface/plugin-neutral-host.js';
import { createPluginThreadHost } from '../src/domains/plugin/host-surface/plugin-thread-host.js';

test('runtime-info returns only current instance facts under an owner request', async () => {
  let active = true;
  const deps = {
    pluginInstanceId: 'fixture',
    packageDigest: 'digest',
    assertActivation: () => {
      if (!active) throw new Error('stopped');
    },
    inventory: {
      snapshot: async () => ({
        instances: [
          {
            pluginInstanceId: 'fixture',
            pluginId: 'dev.fixture',
            packageDigest: 'digest',
            lifecycleState: 'installed',
            activationState: 'enabled',
            configReadiness: 'ready',
          },
        ],
        packages: [{ pluginId: 'dev.fixture', packageDigest: 'digest', packageState: 'installed' }],
      }),
    },
    runtimeInfo: () => ({
      version: 'revision',
      platform: 'win32',
      architecture: 'x64',
      nodeVersion: '22',
      projectRoot: 'local-project',
      logDirectory: 'current-instance-logs',
      secret: 'must-not-be-projected',
    }),
  } as unknown as Parameters<typeof createPluginNeutralHost>[0];
  const host = await createPluginNeutralHost(deps);
  await assert.rejects(host.runtimeInfo!.get(), /owner request/);
  const info = await withPluginOwnerRequest(
    {
      pluginId: 'dev.fixture',
      contributionId: 'open',
      userId: 'owner',
      operation: 'read',
      signal: new AbortController().signal,
      requestIdentity: {
        requestId: 'request',
        transportRequestId: 'request',
        method: 'POST',
        declaredPath: '/ui',
        path: '/ui',
        bodyDigest: 'digest',
        queryDigest: 'digest',
      },
    },
    () =>
      withPluginOwnerWebhook(
        'dev.fixture',
        'open',
        'fixture',
        false,
        async () => {},
        () => host.runtimeInfo!.get(),
      ),
  );
  assert.equal(info.logDirectory, 'current-instance-logs');
  assert.ok(!JSON.stringify(info).includes('must-not-be-projected'));
  active = false;
  await assert.rejects(host.runtimeInfo!.get(), /stopped/);
});

test('ordinary thread projectRef validates directories and preserves parent semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-project-test-'));
  const store = new ThreadStore();
  const host = createPluginThreadHost({
    pluginId: 'dev.fixture',
    ownerUserId: 'owner',
    projectPath: '/default',
    threadStore: store,
    threadDeepLinkUrl: (id) => `https://local.test/thread/${id}`,
  });
  try {
    const thread = await host.create({ title: 'project selection', projectRef: root });
    assert.equal(thread.projectRef, root);
    const child = await host.create({ title: 'inherit project', parentThreadId: thread.id });
    assert.equal(child.projectRef, root);
    await assert.rejects(host.create({ title: 'missing', projectRef: join(root, 'not-existing') }), /projectRef/);
    await assert.rejects(host.create({ title: 'ambiguous', parentThreadId: thread.id, projectRef: root }), /not both/);
  } finally {
    await rmdir(root);
  }
});
