import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCollectiveAccountabilitySource,
  readCollectiveAccountabilityAttentionSource,
} from '../src/routes/companion-collective-accountability-source.js';

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
  test(`missing/disabled/failed plugin (${status}) never becomes empty complete`, async () => {
    const result = await readCollectiveAccountabilityAttentionSource(
      async () => ({ status, body: { error: 'unavailable' } }),
      'owner',
    );
    assert.equal(result.state.status, 'unavailable');
    assert.equal(result.state.exhaustiveness, 'unknown');
    assert.deepEqual(result.items, []);
  });
}
test('malformed plugin attention payload cannot reach Dot projection', async () => {
  const result = await readCollectiveAccountabilityAttentionSource(
    async () => ({ status: 200, body: { data: { ...data, items: [{ subjectRef: 'forged' }] } } }),
    'owner',
  );
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
  const actions = {
    'collective.owner.accountability-attention': async (params: unknown, native: unknown, owner: any) => {
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
    inventory: { snapshot: async () => snapshot as any },
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
  assert.equal((await readCollectiveAccountabilityAttentionSource(read, 'owner')).state.exhaustiveness, 'complete');
  assert.equal(calls, 1);
  snapshot.instances[0]!.activationState = 'disabled';
  const unavailable = await readCollectiveAccountabilityAttentionSource(read, 'owner');
  assert.equal(unavailable.state.status, 'unavailable');
  assert.equal(unavailable.state.exhaustiveness, 'unknown');
  assert.equal(calls, 1, 'a disabled instance must never be invoked');
});
