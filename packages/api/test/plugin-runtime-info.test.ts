import assert from 'node:assert/strict';
import { mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_THREAD_ID, ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import {
  withPluginOwnerRequest,
  withPluginOwnerWebhook,
} from '../src/domains/plugin/carrier/plugin-owner-request-context.js';
import { createPluginNeutralHost } from '../src/domains/plugin/host-surface/plugin-neutral-host.js';
import { createPluginThreadHost } from '../src/domains/plugin/host-surface/plugin-thread-host.js';
import { snapshotInventoryFixture } from './helpers/snapshot-inventory-fixture.js';

test('runtime-info returns only current instance facts under an owner request', async () => {
  let active = true;
  const deps = {
    pluginInstanceId: 'fixture',
    packageDigest: 'digest',
    assertActivation: () => {
      if (!active) throw new Error('stopped');
    },
    inventory: snapshotInventoryFixture({
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
    }),
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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'plugin-project-test-')));
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

test('pinnedOnly paginates owner pins and excludes default/system/hub/foreign/deleted without changing page or candidates', async () => {
  const store = new ThreadStore();
  const host = createPluginThreadHost({
    pluginId: 'dev.fixture',
    ownerUserId: 'owner',
    projectPath: '/default',
    threadStore: store,
    threadDeepLinkUrl: (id) => `https://local.test/thread/${id}`,
  });
  const pinnedIds: string[] = [];
  for (let index = 0; index < 60; index += 1) {
    const thread = store.create('owner', `pinned-${index}`, '/default');
    store.updatePin(thread.id, true);
    pinnedIds.push(thread.id);
  }
  const system = store.create('owner', 'system thread', '/default');
  store.claimSystemKind(system.id, 'owner', 'memory_ops');
  store.updatePin(system.id, true);
  const evalDomain = store.create('owner', 'eval thread', '/default');
  store.claimSystemKind(evalDomain.id, 'owner', 'eval_domain');
  store.updatePin(evalDomain.id, true);
  const hub = store.create('owner', 'hub thread', '/default');
  store.claimSystemKind(hub.id, 'owner', 'connector_hub');
  store.updatePin(hub.id, true);
  const foreign = store.create('other', 'foreign thread', '/default');
  store.updatePin(foreign.id, true);
  const deleted = store.create('owner', 'deleted thread', '/default');
  store.updatePin(deleted.id, true);
  store.softDelete(deleted.id);
  const defaultThread = store.get(DEFAULT_THREAD_ID);
  if (!defaultThread) throw new Error('default thread unavailable');

  const first = await host.list({ pinnedOnly: true, limit: 50 });
  assert.equal(first.length, 50);
  const last = first[first.length - 1]!;
  const second = await host.list({
    pinnedOnly: true,
    limit: 50,
    before: { lastActiveAt: last.lastActiveAt, id: last.id },
  });
  assert.equal(second.length, 10);
  assert.equal(new Set([...first, ...second].map((thread) => thread.id)).size, 60);
  assert.equal(
    [...first, ...second].some((thread) =>
      [system.id, evalDomain.id, hub.id, foreign.id, deleted.id, defaultThread.id].includes(thread.id),
    ),
    false,
  );

  const normal = await host.list({ limit: 50 });
  assert.equal(normal.some((thread) => thread.id === system.id), true);
  assert.equal(normal.some((thread) => thread.id === evalDomain.id), true);
  assert.equal(normal.some((thread) => thread.id === hub.id), true);
  assert.equal(normal.some((thread) => thread.id === defaultThread.id), true);
  assert.equal(normal.some((thread) => thread.id === foreign.id), false);
  assert.equal(normal.some((thread) => thread.id === deleted.id), false);
  assert.equal((await host.list({ threadIds: [system.id] })).length, 1);
  assert.equal((await host.get(system.id))?.id, system.id);

  store.updatePin(pinnedIds[0]!, false);
  const afterUnpin = await host.list({ pinnedOnly: true, limit: 50 });
  assert.equal(afterUnpin.some((thread) => thread.id === pinnedIds[0]), false);

  await assert.rejects(host.list({ pinnedOnly: true, threadIds: [pinnedIds[1]!] }), /pinnedOnly|threadIds/);

  const beforeFirst = await host.list({
    pinnedOnly: true,
    limit: 50,
    before: { lastActiveAt: first[0]!.lastActiveAt, id: first[0]!.id },
  });
  assert.equal(beforeFirst.length, 50);
  assert.equal(beforeFirst.some((thread) => thread.id === first[0]!.id), false);
});
