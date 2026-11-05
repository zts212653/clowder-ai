import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { CollectiveArtifactOwnerPort } from '../src/domains/collaborative-content/collective-artifact/owner-port.js';
import { createCollectiveArtifactOwnerProxy } from '../src/domains/plugin/host-surface/collective-artifact-owner.js';
import { baseConstraint } from './collective-markdown.fixture.js';

const operation = () => ({
  requestId: 'req-one',
  relayRef: 'relay-one',
  expiresAt: Date.now() + 60000,
  constraint: { ...baseConstraint, expiresAt: Date.now() + 60000 },
  payload: {},
});

test('one stable proxy rejects startup gap, then reaches the late owner without restart', async () => {
  let owner: CollectiveArtifactOwnerPort | undefined;
  const proxy = createCollectiveArtifactOwnerProxy({ owner: () => owner, assertCurrent: async () => {} });
  const op = operation();
  const authority = { reauthorize: async () => op.constraint };
  await assert.rejects(proxy.execute(op, authority), /owner_unavailable/);
  owner = {
    execute: async (input, auth) => {
      assert.notEqual(input, op);
      assert.deepEqual(await auth.reauthorize(), op.constraint);
      return { status: 'ok', ownerDecisionRef: 'decision', value: { requestId: input.requestId } };
    },
  };
  assert.equal((await proxy.execute(op, authority)).status, 'ok');
});

test('replacement or disable while reauthorizing fences the effect', async () => {
  let current = true;
  let effects = 0;
  const owner: CollectiveArtifactOwnerPort = {
    execute: async (_input, auth) => {
      await auth.reauthorize();
      effects++;
      return { status: 'ok', ownerDecisionRef: 'effect', value: {} };
    },
  };
  const proxy = createCollectiveArtifactOwnerProxy({
    owner: () => owner,
    assertCurrent: async () => {
      if (!current) throw new Error('activation changed');
    },
  });
  const op = operation();
  await assert.rejects(
    proxy.execute(op, {
      reauthorize: async () => {
        current = false;
        return op.constraint;
      },
    }),
    /activation changed/,
  );
  assert.equal(effects, 0);
});

test('activation abort cancels an idle media source and closes the exposed stream', async () => {
  const activation = new AbortController();
  const source = new PassThrough();
  const owner: CollectiveArtifactOwnerPort = {
    execute: async () => ({ status: 'error', error: { code: 'unsupported_operation' } }),
    media: {
      read: async () => ({
        status: 'ok',
        body: source,
        descriptor: {
          contentRef: baseConstraint.contentRef,
          ownerRevision: 1,
          blobDigest: baseConstraint.blobDigest,
          ownerReceiptRef: 'receipt',
          mediaType: 'image/png',
          byteLength: 100,
          status: 200,
        },
      }),
    },
  };
  const proxy = createCollectiveArtifactOwnerProxy({
    owner: () => owner,
    assertCurrent: async () => {},
    signal: activation.signal,
  });
  const { requestId: _id, payload: _payload, ...op } = operation();
  const result = await proxy.media!.read(op, { reauthorize: async () => op.constraint }, new AbortController().signal);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  const closed = once(result.body, 'close');
  activation.abort();
  await closed;
  assert.equal(source.destroyed, true);
  assert.equal(result.body.destroyed, true);
});

test('an in-flight result cannot escape after owner holder replacement', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first: CollectiveArtifactOwnerPort = {
    execute: async () => {
      await pending;
      return { status: 'ok', ownerDecisionRef: 'stale', value: {} };
    },
  };
  let owner = first;
  const proxy = createCollectiveArtifactOwnerProxy({ owner: () => owner, assertCurrent: async () => {} });
  const op = operation();
  const result = proxy.execute(op, { reauthorize: async () => op.constraint });
  await new Promise((resolve) => setImmediate(resolve));
  owner = { execute: async () => ({ status: 'error', error: { code: 'owner_unavailable' } }) };
  release();
  await assert.rejects(result, /owner_unavailable/);
});

test('verified installation selects the owner port; unrelated plugins and replaced grants cannot use it', async () => {
  const { HostInventoryControlPlane, MemoryPluginInventoryStore } = await import(
    '../src/domains/plugin/host-inventory/index.js'
  );
  const { createPluginNeutralHost } = await import('../src/domains/plugin/host-surface/plugin-neutral-host.js');
  const store = new MemoryPluginInventoryStore();
  const ids = ['official.collective-connector', 'dev.example.other'];
  const owner: CollectiveArtifactOwnerPort = {
    execute: async (_op, auth) => {
      await auth.reauthorize();
      return { status: 'ok', ownerDecisionRef: 'background-read', value: {} };
    },
  };
  for (const [i, pluginId] of ids.entries()) {
    const instanceId = `pi_owner_${i}`;
    const digest = `sha512-${Buffer.alloc(64, i + 1).toString('base64')}`;
    const control = new HostInventoryControlPlane(store, { createInstanceId: () => instanceId });
    await control.installPackage({
      manifest: {
        pluginId,
        version: '1.0.0',
        contractVersion: '0.1.0',
        name: 'Owner fixture',
        runtime: { transport: 'builtin' },
        features: [{ id: 'main', name: 'Main', resources: [], capabilities: [] }],
      },
      computedPackageDigest: digest,
      expectedPackageDigest: digest,
      packagePluginId: pluginId,
      signalSchemas: {},
    });
    await store.transaction((tx) => {
      const instance = tx.instances.get(instanceId)!;
      tx.instances.put({ ...instance, configReadiness: 'ready', activationState: 'enabled' });
    });
    const host = await createPluginNeutralHost({
      inventory: store,
      pluginInstanceId: instanceId,
      packageDigest: digest,
      assertActivation: () => {},
      collectiveArtifactOwner: { current: owner },
    });
    if (i !== 0) {
      assert.equal(host.collectiveArtifactOwner, undefined);
      continue;
    }
    const op = operation();
    assert.equal(
      (await host.collectiveArtifactOwner!.execute(op, { reauthorize: async () => op.constraint })).status,
      'ok',
    );
    await store.transaction((tx) => {
      const instance = tx.instances.get(instanceId)!;
      tx.instances.put({ ...instance, activationState: 'disabled', lifecycleRevision: instance.lifecycleRevision + 1 });
    });
    await assert.rejects(
      host.collectiveArtifactOwner!.execute(op, { reauthorize: async () => op.constraint }),
      /no longer current/,
    );
  }
});

test('retained media cannot borrow a background or legacy owner identity', async () => {
  const owner: CollectiveArtifactOwnerPort = {
    execute: async () => ({ status: 'error', error: { code: 'owner_unavailable' } }),
  };
  const proxy = createCollectiveArtifactOwnerProxy({
    owner: () => owner,
    assertCurrent: async () => {},
    pluginInstanceId: 'pi_collective',
  });
  assert.equal(typeof proxy.media?.listRetained, 'function');
  await assert.rejects(
    proxy.media!.listRetained!(
      {},
      {
        reauthorize: async () => ({
          serviceInstanceId: 's',
          collectiveId: 'c',
          connectionId: 'conn',
          authorizedHumanId: 'h',
        }),
      },
    ),
    /owner.*request/i,
  );
});
