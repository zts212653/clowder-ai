import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModuleHostInvocation } from '../dist/domains/plugin/builtin-runtime/carriers/module-host-invocation.js';
import {
  createCollectiveMaterialSourceProxy,
  createInstalledCollectiveMaterialSource,
} from '../dist/domains/plugin/host-surface/collective-material-source.js';
import { InstalledPluginOperations } from '../dist/domains/plugin/operations/plugin-operation-routes.js';

const operation = {
  relayRef: 'relay-test',
  action: 'read',
  publication: {
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    connectionId: 'con_aaaaaaaa',
    publicationId: 'publication-test',
    roadmapId: 'roadmap_aaaaaaaa',
    channelId: 'general',
    sourceEventId: 'evt_aaaaaaaa',
    humanId: 'human_aaaaaaaa',
    provider: 'github',
    sourceId: 'issue:org/repo#4',
    actor: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner' },
    publishedAt: '2026-10-26T00:00:00Z',
    state: 'published',
  },
};
const material = {
  status: 'available',
  sourceKey: 'issue:org/repo#4',
  sourceRef: 'https://github.com/org/repo/issues/4',
  witness: { digest: 'a'.repeat(64), readAt: '2026-10-26T00:00:00Z' },
  material: {
    kind: 'issue',
    title: 'Current source title',
    clauses: [{ clauseId: 'subject', text: 'Source body remains transient' }],
  },
};

test('actual installed owner operation carries a source read with config/state metadata and stores no source content', async () => {
  const pluginId = 'official.github-operations',
    instanceId = 'pi_source_test',
    states = [];
  let enabled = true,
    calls = 0;
  const manifest = {
    pluginId,
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Source fixture',
    features: [{ id: 'source', name: 'Source', contributions: [] }],
    runtime: { transport: 'builtin', entrypoint: 'plugin.mjs' },
    configuration: [
      {
        key: 'sourceMaterial',
        label: 'Project sharing',
        kind: 'operation',
        required: false,
        actions: [{ id: 'invoke', label: 'Source', render: 'status', action: { method: 'github.sourceMaterial' } }],
      },
    ],
  };
  const packageRecord = {
    packageDigest: 'sha512-source-fixture',
    pluginId,
    version: '1.0.0',
    contractVersion: '0.1.0',
    manifest,
    signalSchemas: {},
    packageState: 'installed',
    verifiedAt: 1,
    updatedAt: 1,
  };
  const instance = {
    pluginInstanceId: instanceId,
    pluginId,
    packageDigest: packageRecord.packageDigest,
    lifecycleState: 'installed',
    configReadiness: 'ready',
    activationState: 'enabled',
    runtimeState: 'healthy',
    lifecycleRevision: 3,
    installedAt: 1,
    updatedAt: 1,
  };
  const actions = {
    'github.sourceMaterial': async (params, native, owner) => {
      assert.equal(native, undefined);
      assert.equal(owner.kind, 'owner-operation');
      assert.equal(owner.userId, 'owner');
      assert.equal(owner.pluginInstanceId, instanceId);
      assert.equal(owner.operationKey, 'sourceMaterial');
      await owner.assertCurrent();
      assert.equal(params.input.configured, 'provider-owned');
      assert.deepEqual(params.input.operation, operation);
      if (calls++) assert.equal(params.operationState.currentAction, 'invoke');
      return { render: 'status', data: material };
    },
  };
  const operations = new InstalledPluginOperations({
    inventory: {
      snapshot: async () => ({
        schemaVersion: 1,
        packages: [packageRecord],
        instances: [
          {
            ...instance,
            activationState: enabled ? 'enabled' : 'disabled',
            runtimeState: enabled ? 'healthy' : 'stopped',
          },
        ],
      }),
    },
    configuration: {
      readActionInput: async () => ({ configured: 'provider-owned' }),
      readOperationState: async () => states.at(-1),
      writeOperationState: async (_plugin, _key, state) => {
        states.push(state);
      },
      clearOperationState: async () => {},
      configureOperationTargets: async () => {
        throw new Error('Source reads cannot configure credentials');
      },
    },
    invocation: createModuleHostInvocation({ runtime: { actions: () => actions } }),
  });
  const source = createInstalledCollectiveMaterialSource(operations, 'owner');
  const authority = { reauthorize: async () => operation.publication };
  assert.deepEqual(await source.execute(operation, authority), material);
  assert.deepEqual(await source.execute(operation, authority), material);
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(states).includes('Source body'), false);
  assert.equal(JSON.stringify(states).includes('Current source title'), false);
  enabled = false;
  assert.equal((await source.execute(operation, authority)).status, 'unavailable');
  assert.equal(calls, 2);
});

test('the Collective activation refuses source results after its owner or installation lifetime changes', async () => {
  let current = true,
    finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const owner = {
    execute: async (_operation, authority) => {
      await authority.reauthorize();
      await pending;
      return material;
    },
  };
  const proxy = createCollectiveMaterialSourceProxy({
    owner: () => owner,
    assertCurrent: async () => {
      if (!current) throw new Error('Installation revoked');
    },
  });
  const read = proxy.execute(operation, { reauthorize: async () => operation.publication });
  await new Promise((resolve) => setImmediate(resolve));
  current = false;
  finish();
  await assert.rejects(read, /Installation revoked/);
});
