import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCollectiveAccountabilitySource,
  readCollectiveAccountabilityAttentionSource,
  readOptionalCollectiveAccountabilityAttentionSource,
} from '../src/routes/companion-collective-accountability-source.js';
import { snapshotInventoryFixture } from './helpers/snapshot-inventory-fixture.js';

const data = {
  items: [],
  reasons: [],
  state: {
    coverage: 'pending_f290_collective_accountability_requests',
    startedAt: 1,
    observedAt: 2,
    status: 'available',
    exhaustiveness: 'complete',
  },
};

test('Dot retains partial source evidence from the installed action', async () => {
  const result = await readCollectiveAccountabilityAttentionSource(async (userId) => {
    assert.equal(userId, 'owner');
    return {
      status: 200,
      body: {
        data: { ...data, reasons: ['connection_read_failed'], state: { ...data.state, exhaustiveness: 'partial' } },
      },
    };
  }, 'owner');
  assert.equal(result.state.status, 'available');
  assert.equal(result.state.exhaustiveness, 'partial');
  assert.deepEqual(result.reasons, ['connection_read_failed']);
});
for (const status of [404, 409, 502]) {
  test(`active plugin failure (${status}) never becomes empty complete`, async () => {
    const result = await readCollectiveAccountabilityAttentionSource(
      async () => ({ matched: true, status, body: { error: 'unavailable' } }),
      'owner',
    );
    assert.ok(result);
    assert.equal(result.state.status, 'unavailable');
    assert.equal(result.state.exhaustiveness, 'unknown');
    assert.deepEqual(result.items, []);
  });
}
test('uncomposed, uninstalled, or explicitly owner-disabled plugin contributes no active failure source', async (t) => {
  assert.equal((await readCollectiveAccountabilityAttentionSource(undefined, 'owner')).state.status, 'unavailable');
  assert.equal(await readOptionalCollectiveAccountabilityAttentionSource(undefined, 'owner'), undefined);
  assert.equal(
    await readOptionalCollectiveAccountabilityAttentionSource(
      async () => ({ matched: false, status: 404, body: { error: 'not installed' } }),
      'owner',
    ),
    undefined,
  );
  assert.equal(
    await readOptionalCollectiveAccountabilityAttentionSource(
      async () => ({ matched: true, disabled: true, status: 409, body: { error: 'not enabled' } }),
      'owner',
    ),
    undefined,
  );

  const Fastify = (await import('fastify')).default;
  const { readCompanionDecisionProjection } = await import('../src/routes/companion-decision-read-service.js');
  const app = Fastify();
  t.after(() => app.close());
  app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  for (const reader of [
    undefined,
    async () => ({ matched: false, status: 404, body: { error: 'not installed' } }),
    async () => ({ matched: true, disabled: true, status: 409, body: { error: 'not enabled' } }),
  ]) {
    const projection = await readCompanionDecisionProjection(
      app,
      'owner',
      { offset: 0, limit: 20 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reader,
    );
    assert.equal(projection.status, 'available');
    assert.equal(projection.consistency.state, 'verified');
    assert.equal(projection.totalCount, 0);
    assert.equal(projection.sources.collectiveAccountabilityRequests, undefined);
  }
});
test('remote connection authority unavailability inside an authenticated owner read maps to source unavailability while Host 401 stays unauthenticated', async () => {
  const remoteAuthority = await readCollectiveAccountabilityAttentionSource(
    async () => ({
      matched: true,
      status: 200,
      body: {
        data: {
          ...data,
          reasons: ['collective_accountability_connection_authority_unavailable'],
          state: { ...data.state, status: 'unauthenticated', exhaustiveness: 'partial' },
        },
      },
    }),
    'owner',
  );
  assert.ok(remoteAuthority);
  assert.equal(remoteAuthority.state.status, 'unavailable');
  assert.equal(remoteAuthority.state.exhaustiveness, 'partial');
  assert.deepEqual(remoteAuthority.reasons, ['collective_accountability_connection_authority_unavailable']);

  const hostUnauthenticated = await readCollectiveAccountabilityAttentionSource(
    async () => ({ matched: true, status: 401, body: { error: 'unauthorized' } }),
    'owner',
  );
  assert.ok(hostUnauthenticated);
  assert.equal(hostUnauthenticated.state.status, 'unauthenticated');
});
test('malformed plugin attention payload cannot reach Dot projection', async () => {
  const result = await readCollectiveAccountabilityAttentionSource(
    async () => ({ status: 200, body: { data: { ...data, items: [{ subjectRef: 'forged' }] } } }),
    'owner',
  );
  assert.ok(result);
  assert.equal(result.state.status, 'invalid');
  assert.deepEqual(result.items, []);
});

// Exercise the actual Manager admission and carrier, not a prefilled projection fixture.
test('Dot → Manager declaration → module owner context remains fenced to the installed instance', async () => {
  const { InstalledPluginOperations } = await import('../src/domains/plugin/operations/plugin-operation-routes.js');
  const { createModuleHostInvocation } = await import(
    '../src/domains/plugin/builtin-runtime/carriers/module-host-invocation.js'
  );
  const pluginId = 'official.collective-connector';
  const pluginInstanceId = 'pi_attention_fixture';
  const snapshot = {
    schemaVersion: 1 as const,
    packages: [
      {
        packageDigest: 'sha512-test',
        pluginId,
        version: '1.0.0',
        contractVersion: '0.1.0',
        manifest: {
          pluginId,
          version: '1.0.0',
          contractVersion: '0.1.0',
          name: 'Attention fixture',
          runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
          features: [{ id: 'main', name: 'Main', capabilities: [], contributions: [] }],
          configuration: [
            {
              key: 'accountability',
              label: 'Accountability',
              kind: 'operation',
              required: false,
              actions: [
                {
                  id: 'attention',
                  label: 'Attention',
                  render: 'button',
                  action: { method: 'collective.owner.accountability-attention' },
                },
              ],
            },
          ],
        },
        signalSchemas: {},
        packageState: 'installed',
        verifiedAt: 1,
        updatedAt: 1,
      },
    ],
    instances: [
      {
        pluginInstanceId,
        pluginId,
        packageDigest: 'sha512-test',
        lifecycleState: 'installed',
        configReadiness: 'ready',
        activationState: 'enabled',
        runtimeState: 'healthy',
        lifecycleRevision: 1,
        installedAt: 1,
        updatedAt: 1,
      },
    ],
    grants: [],
  };
  let calls = 0;
  interface OwnerContext {
    readonly kind: string;
    readonly userId: string;
    readonly pluginInstanceId: string;
    assertCurrent(): Promise<void>;
  }
  const actions = {
    'collective.owner.accountability-attention': async (params: unknown, native: unknown, owner: OwnerContext) => {
      calls++;
      assert.equal(native, undefined);
      assert.deepEqual(params, { input: {} });
      assert.equal(owner.kind, 'owner-operation');
      assert.equal(owner.userId, 'owner');
      assert.equal(owner.pluginInstanceId, pluginInstanceId);
      await owner.assertCurrent();
      return { render: 'status', data };
    },
  };
  const operations = new InstalledPluginOperations({
    inventory: snapshotInventoryFixture({ snapshot: async () => snapshot }),
    invocation: createModuleHostInvocation({ runtime: { actions: () => actions } }),
    configuration: {
      readActionInput: async () => ({}),
      readOperationState: async () => undefined,
      writeOperationState: async () => {},
      clearOperationState: async () => {},
      configureOperationTargets: async () => [],
    },
  });
  const read = createCollectiveAccountabilitySource(operations, 'owner');
  assert.equal((await read('foreign')).status, 403);
  assert.equal(calls, 0);
  assert.equal(
    (await readOptionalCollectiveAccountabilityAttentionSource(read, 'owner'))?.state.exhaustiveness,
    'complete',
  );
  assert.equal(calls, 1);
  const instance = snapshot.instances[0];
  assert.ok(instance);
  instance.activationState = 'disabled';
  instance.runtimeState = 'stopped';
  const dormant = await readOptionalCollectiveAccountabilityAttentionSource(read, 'owner');
  assert.equal(dormant, undefined);
  assert.equal(calls, 1, 'a disabled instance must never be invoked');

  instance.activationState = 'enabled';
  instance.runtimeState = 'crashed';
  const crashed = await readOptionalCollectiveAccountabilityAttentionSource(read, 'owner');
  assert.ok(crashed);
  assert.equal(crashed.state.status, 'unavailable');
  assert.equal(crashed.state.exhaustiveness, 'unknown');
  assert.equal(calls, 1, 'an unhealthy instance fails closed without invoking');

  instance.activationState = 'error';
  instance.runtimeState = 'stopped';
  const errored = await readOptionalCollectiveAccountabilityAttentionSource(read, 'owner');
  assert.ok(errored);
  assert.equal(errored.state.status, 'unavailable');
  assert.equal(errored.state.exhaustiveness, 'unknown');
});

test('real incompatible inventory omits both Collective readers when owner-disabled while keeping enabled/error incompatible installs fail-closed and preserving HTTP 409', async (t) => {
  const { createHash } = await import('node:crypto');
  const Fastify = (await import('fastify')).default;
  const { MemoryPluginInventoryStore } = await import('../src/domains/plugin/host-inventory/stores.js');
  const { InstalledPluginOperations, pluginOperationRoutes } = await import(
    '../src/domains/plugin/operations/plugin-operation-routes.js'
  );
  const { createCollectiveWorkResultAttentionSource, readCollectiveWorkResultAttention } = await import(
    '../src/domains/plugin/host-surface/collective-work-result-attention.js'
  );
  const { F290CollectiveWorkResultPluginAdapter } = await import(
    '../src/domains/growing/F290CollectiveWorkResultPluginAdapter.js'
  );
  const { readCompanionDecisionProjection } = await import('../src/routes/companion-decision-read-service.js');

  const pluginId = 'official.collective-connector';
  const packageDigest = `sha512-${createHash('sha512').update('incompatible-collective').digest('base64')}`;
  const rawIncompatibleManifest = {
    pluginId,
    version: '0.9.0',
    contractVersion: '9.0.0',
    name: 'Collective Connector',
    features: [{ id: 'collective', name: 'Collective', resources: [], capabilities: [] }],
    runtime: { transport: 'builtin', entrypoint: 'dist/entrypoint.js' },
  };
  const buildStore = (activationState: 'disabled' | 'enabled' | 'error') =>
    new MemoryPluginInventoryStore({
      schemaVersion: 1,
      packages: [
        {
          packageDigest,
          pluginId,
          version: rawIncompatibleManifest.version,
          contractVersion: rawIncompatibleManifest.contractVersion,
          manifest: rawIncompatibleManifest,
          signalSchemas: {},
          packageState: 'installed',
          verifiedAt: 1,
          updatedAt: 1,
        },
      ],
      instances: [
        {
          pluginInstanceId: 'pi_collective_incompat',
          pluginId,
          packageDigest,
          lifecycleState: 'installed',
          configReadiness: 'ready',
          activationState,
          runtimeState: 'stopped',
          lifecycleRevision: 2,
          installedAt: 1,
          updatedAt: 2,
        },
      ],
    });

  const configuration = {
    readActionInput: async () => ({}),
    readOperationState: async () => undefined,
    writeOperationState: async () => {},
    clearOperationState: async () => {},
    configureOperationTargets: async () => [],
  };
  const invocation = {
    invoke: async () => {
      throw new Error('incompatible package must never invoke');
    },
  };

  const disabledInventory = buildStore('disabled');
  assert.equal((await disabledInventory.snapshot()).packages[0]?.manifest, null);
  const disabledOps = new InstalledPluginOperations({
    inventory: disabledInventory,
    configuration,
    invocation,
  });

  const ownerId = process.env.DEFAULT_OWNER_USER_ID?.trim() || 'owner';
  const app = Fastify();
  t.after(() => app.close());
  app.decorateRequest('sessionUserId', undefined);
  app.addHook('onRequest', async (request) => {
    const headerUser = request.headers['x-cat-cafe-user'];
    if (typeof headerUser === 'string') (request as unknown as { sessionUserId?: string }).sessionUserId = headerUser;
  });
  app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  await app.register(pluginOperationRoutes, { operations: disabledOps });

  const disabledAccountability = createCollectiveAccountabilitySource(disabledOps, ownerId);
  const disabledWorkResult = createCollectiveWorkResultAttentionSource(disabledOps, ownerId);
  const disabledWorkAdapter = new F290CollectiveWorkResultPluginAdapter(disabledWorkResult);

  assert.equal(await readOptionalCollectiveAccountabilityAttentionSource(disabledAccountability, ownerId), undefined);
  assert.deepEqual(await readCollectiveWorkResultAttention(disabledWorkResult, ownerId), []);
  assert.deepEqual(await disabledWorkAdapter.listCurrentReceipts(ownerId), []);

  const disabledProjection = await readCompanionDecisionProjection(
    app,
    ownerId,
    { offset: 0, limit: 20 },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    disabledAccountability,
  );
  assert.equal(disabledProjection.status, 'available');
  assert.equal(disabledProjection.consistency.state, 'verified');
  assert.equal(disabledProjection.sources.collectiveAccountabilityRequests, undefined);

  // Settings / HTTP action route still preserves exact 409 incompatible error body without leaking internal flags.
  const httpRes = await app.inject({
    method: 'POST',
    url: '/api/plugins/official.collective-connector/actions/accountability/attention',
    remoteAddress: '127.0.0.1',
    headers: {
      host: 'localhost:3004',
      origin: 'http://localhost:3004',
      'x-cat-cafe-user': ownerId,
    },
    payload: {},
  });
  assert.equal(httpRes.statusCode, 409);
  assert.deepEqual(httpRes.json(), { error: 'Plugin version is incompatible; update or reinstall it' });

  // Enabled or errored incompatible installs must remain fail-closed on both Collective readers.
  for (const activeState of ['enabled', 'error'] as const) {
    const activeOps = new InstalledPluginOperations({
      inventory: buildStore(activeState),
      configuration,
      invocation,
    });
    const activeAccountability = createCollectiveAccountabilitySource(activeOps, ownerId);
    const activeWorkResult = createCollectiveWorkResultAttentionSource(activeOps, ownerId);
    const activeWorkAdapter = new F290CollectiveWorkResultPluginAdapter(activeWorkResult);

    const activeRead = await readOptionalCollectiveAccountabilityAttentionSource(activeAccountability, ownerId);
    assert.ok(activeRead);
    assert.equal(activeRead.state.status, 'unavailable');
    assert.equal(activeRead.state.exhaustiveness, 'unknown');

    const activeProjection = await readCompanionDecisionProjection(
      app,
      ownerId,
      { offset: 0, limit: 20 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      activeAccountability,
    );
    assert.equal(activeProjection.status, 'partial');
    assert.equal(activeProjection.consistency.state, 'uncertain');
    assert.deepEqual(activeProjection.consistency.reasons, ['collective_accountability_plugin_unavailable']);

    await assert.rejects(readCollectiveWorkResultAttention(activeWorkResult, ownerId), /unavailable/);
    await assert.rejects(activeWorkAdapter.listCurrentReceipts(ownerId), /unavailable/);
  }

  // Compatible disabled plugin with settingsInvocation keeps Settings actions working while unhandled runtime reads omit.
  const compatibleDigest = `sha512-${createHash('sha512').update('compatible-collective').digest('base64')}`;
  const compatibleDisabledStore = new MemoryPluginInventoryStore({
    schemaVersion: 1,
    packages: [
      {
        packageDigest: compatibleDigest,
        pluginId,
        version: '1.0.0',
        contractVersion: '0.1.0',
        manifest: {
          pluginId,
          version: '1.0.0',
          contractVersion: '0.1.0',
          name: 'Collective Connector',
          runtime: { transport: 'builtin', entrypoint: 'dist/entrypoint.js' },
          features: [{ id: 'collective', name: 'Collective', resources: [], capabilities: [] }],
          configuration: [
            {
              key: 'accountability',
              label: 'Accountability',
              kind: 'operation',
              required: false,
              actions: [
                {
                  id: 'attention',
                  label: 'Attention',
                  render: 'button',
                  action: { method: 'collective.owner.accountability-attention' },
                },
                {
                  id: 'pair',
                  label: 'Pair',
                  render: 'button',
                  action: { method: 'collective.settings.pair' },
                },
              ],
            },
          ],
        },
        signalSchemas: {},
        packageState: 'installed',
        verifiedAt: 1,
        updatedAt: 1,
      },
    ],
    instances: [
      {
        pluginInstanceId: 'pi_collective_compat_disabled',
        pluginId,
        packageDigest: compatibleDigest,
        lifecycleState: 'installed',
        configReadiness: 'ready',
        activationState: 'disabled',
        runtimeState: 'stopped',
        lifecycleRevision: 1,
        installedAt: 1,
        updatedAt: 1,
      },
    ],
  });
  const settingsOps = new InstalledPluginOperations({
    inventory: compatibleDisabledStore,
    configuration,
    invocation,
    settingsInvocation: async ({ method }) =>
      method === 'collective.settings.pair'
        ? { handled: true, result: { render: 'status', data: { ok: true } } }
        : { handled: false },
  });
  const pairRes = await settingsOps.runAction(pluginId, 'accountability', 'pair', {});
  assert.equal(pairRes.status, 200);
  assert.equal(pairRes.disabled, undefined);
  assert.equal(
    await readOptionalCollectiveAccountabilityAttentionSource(
      createCollectiveAccountabilitySource(settingsOps, ownerId),
      ownerId,
    ),
    undefined,
  );
});
