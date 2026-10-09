import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { InstalledPluginOperations } from '../dist/domains/plugin/operations/plugin-operation-routes.js';

test('declared operation transports a raw import envelope and a no-PII receipt without a dedicated Host API', async () => {
  const manifest = {
    pluginId: 'dev.clowder.permission-fixture',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Permission fixture',
    features: [{ id: 'main', name: 'Main', capabilities: [], contributions: [], resources: [] }],
    runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
    configuration: [
      {
        key: 'legacy_permissions',
        label: 'One-time permission import',
        kind: 'operation',
        required: false,
        actions: [
          {
            id: 'import',
            label: 'Import',
            render: 'button',
            confirm: 'Import existing permission data?',
            action: { method: 'permissions.importLegacy' },
          },
        ],
      },
    ],
  };
  assert.equal(validateManifest(manifest).valid, true);
  assert.equal(
    validateManifest({ ...manifest, configuration: [{ ...manifest.configuration[0], hidden: true }] }).valid,
    false,
  );
  const envelope = {
    protocolVersion: 1,
    sourceDigest: 'a'.repeat(64),
    snapshot: { config: { adminOpenIds: '[]' }, groups: {} },
  };
  const receipt = {
    render: 'status',
    data: {
      status: 'imported',
      protocolVersion: 1,
      sourceDigest: envelope.sourceDigest,
      stateRevision: 1,
      settingsFieldCount: 1,
      groupCount: 0,
    },
  };
  const saved = [];
  let fail = false;
  const operations = new InstalledPluginOperations({
    inventory: {
      snapshot: async () => ({
        packages: [{ packageDigest: 'fixture-digest', manifest }],
        instances: [
          {
            pluginId: manifest.pluginId,
            pluginInstanceId: 'fixture-instance',
            packageDigest: 'fixture-digest',
            lifecycleState: 'installed',
            activationState: 'enabled',
            runtimeState: 'healthy',
          },
        ],
      }),
    },
    configuration: {
      readActionInput: async () => ({ existingConfig: 'config stays in action input' }),
      readOperationState: async () => undefined,
      writeOperationState: async (...args) => saved.push(args),
      configureOperationTargets: async () => {
        throw new Error('no value backfill permitted');
      },
    },
    invocation: {
      invoke: async (instance, method, params) => {
        assert.equal(instance, 'fixture-instance');
        assert.equal(method, 'permissions.importLegacy');
        assert.deepEqual(params, { input: { existingConfig: 'config stays in action input', ...envelope } });
        if (fail) throw new Error('invalid permission import');
        return receipt;
      },
    },
  });
  const response = await operations.runAction(manifest.pluginId, 'legacy_permissions', 'import', envelope);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, receipt.data);
  assert.equal(saved.length, 1);
  assert.equal(JSON.stringify(response).includes('adminOpenIds'), false);
  fail = true;
  assert.equal((await operations.runAction(manifest.pluginId, 'legacy_permissions', 'import', envelope)).status, 502);
  assert.equal(saved.length, 1, 'a rejected package import must not persist a success operation state');
});
