/**
 * F202 W2-3: the Host consumes plugin contract beta.24 (ledger「W2-3 契约冻结」; canonical verified by
 * Fable). beta.24 lets an operation declare `render: 'row'` actions for h1. A row action is only
 * callable from a row of the same operation's `rows` result, with that row's input (h1 ①), so the
 * Host's operation projection never offers it as a standalone button.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { HostPluginConfigurationService } from '../dist/domains/plugin/manager/plugin-manager-configuration.js';

const pluginId = 'dev.clowder.row-action-fixture';
const roots = [];

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

function manifest() {
  return {
    pluginId,
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Row action fixture',
    configuration: [
      {
        key: 'authorization',
        label: 'Authorized conversations',
        kind: 'operation',
        required: false,
        actions: [
          {
            id: 'list',
            label: 'List',
            render: 'status',
            resultRender: 'rows',
            action: { method: 'authorization.list' },
          },
          {
            id: 'revoke',
            label: 'Revoke',
            render: 'row',
            confirm: 'Stop routing this conversation to Clowder?',
            action: { method: 'authorization.revoke' },
            next: 'list',
          },
        ],
      },
    ],
    features: [{ id: 'main', name: 'Main', capabilities: [], resources: [], contributions: [] }],
    runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
  };
}

function inventory(manifestValue) {
  return {
    async snapshot() {
      return {
        schemaVersion: 1,
        packages: [
          {
            packageDigest: 'sha512-fixture',
            pluginId,
            version: '1.0.0',
            contractVersion: '0.1.0',
            manifest: manifestValue,
            signalSchemas: {},
            packageState: 'installed',
            verifiedAt: 1,
            updatedAt: 1,
          },
        ],
        instances: [
          {
            pluginInstanceId: 'pi_row_fixture',
            pluginId,
            packageDigest: 'sha512-fixture',
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
    },
  };
}

test('beta.24 admits a row action, and the Host never projects it as a standalone button', async () => {
  const value = manifest();
  const validation = validateManifest(value);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));

  const projectRoot = await mkdtemp(join(tmpdir(), 'f202-w2-3-row-'));
  roots.push(projectRoot);
  const service = new HostPluginConfigurationService({ projectRoot, inventory: inventory(value) });
  const operation = (await service.fields(pluginId)).find((field) => field.key === 'authorization');

  assert.deepEqual(operation.actions, [{ id: 'list', label: 'List', render: 'status', resultRender: 'rows' }]);
});
