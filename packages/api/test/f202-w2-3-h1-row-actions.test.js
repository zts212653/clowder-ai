/**
 * F202 W2-3 h1 — per-row actions (ledger「W2-3 契约冻结」h1, contract beta.24).
 *
 * An operation can return a `rows` result whose rows carry actions. Those actions can only call
 * `render: 'row'` actions the manifest declares for the same operation, so runtime data can never
 * introduce a method (③). The Host validates every rows result with the contract's own validator
 * and rejects the whole result when anything is off. Clicking a row action calls the existing
 * action endpoint with that row's input as the body (④).
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { HostPluginConfigurationService } from '../dist/domains/plugin/manager/plugin-manager-configuration.js';
import { InstalledPluginOperations } from '../dist/domains/plugin/operations/plugin-operation-routes.js';

const pluginId = 'dev.clowder.authorization-fixture';
const pluginInstanceId = 'pi_authorization_fixture';
const roots = [];

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

function manifest() {
  return {
    pluginId,
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Authorization fixture',
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
          {
            id: 'reset',
            label: 'Reset all',
            render: 'button',
            confirm: 'Forget every authorization?',
            action: { method: 'authorization.reset' },
          },
        ],
      },
    ],
    features: [{ id: 'main', name: 'Main', capabilities: [], resources: [], contributions: [] }],
    runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
  };
}

function snapshot(manifestValue) {
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
        pluginInstanceId,
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
}

const row = (key, actions = [{ action: 'revoke', input: { conversationId: key } }]) => ({
  key,
  label: `Conversation ${key}`,
  detail: `https://chatgpt.com/c/${key}`,
  actions,
});

function harness(listResult) {
  const calls = [];
  let state;
  const operations = new InstalledPluginOperations({
    inventory: { snapshot: async () => snapshot(manifest()) },
    configuration: {
      readActionInput: async () => ({ account: 'owner@example.com' }),
      readOperationState: async () => state,
      writeOperationState: async (_pluginId, _key, next) => {
        state = structuredClone(next);
      },
      clearOperationState: async () => {
        state = undefined;
      },
      configureOperationTargets: async () => [],
    },
    invocation: {
      async invoke(instanceId, method, params) {
        calls.push({ instanceId, method, params: structuredClone(params) });
        if (method === 'authorization.list') return structuredClone(listResult);
        if (method === 'authorization.revoke') return { render: 'status', data: { status: 'ok' }, label: 'Revoked' };
        throw new Error(`unexpected method ${method}`);
      },
    },
    now: () => 10_000,
  });
  return {
    operations,
    calls,
    get state() {
      return state;
    },
  };
}

describe('F202 W2-3 h1 — rows results', () => {
  test('the fixture is a valid beta.24 manifest', () => {
    const validation = validateManifest(manifest());
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  });

  test('a valid rows result reaches the owner unchanged', async () => {
    const rows = { rows: [row('a1'), row('b2')], empty: 'No authorized conversations' };
    const h = harness({ render: 'rows', data: rows });

    const result = await h.operations.runAction(pluginId, 'authorization', 'list', undefined);

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.render, 'rows');
    assert.deepEqual(result.body.data, rows);
  });

  for (const [name, data] of [
    [
      'a row action the manifest does not declare',
      { rows: [row('a1', [{ action: 'delete', input: { conversationId: 'a1' } }])] },
    ],
    ['a row that calls a non-row action', { rows: [row('a1', [{ action: 'list', input: { conversationId: 'a1' } }])] }],
    ['two rows with the same key', { rows: [row('a1'), row('a1')] }],
    ['a row without a label', { rows: [{ key: 'a1', actions: [] }] }],
  ]) {
    test(`the whole result is rejected for ${name}`, async () => {
      const h = harness({ render: 'rows', data });

      const result = await h.operations.runAction(pluginId, 'authorization', 'list', undefined);

      assert.equal(result.status, 502, JSON.stringify(result.body));
      assert.equal(h.state, undefined, 'a rejected result never becomes operation state');
    });
  }
});

describe('F202 W2-3 h1 — invoking a row action', () => {
  test('without the row input it is refused before the plugin is called', async () => {
    for (const body of [undefined, {}]) {
      const h = harness({ render: 'rows', data: { rows: [] } });

      const result = await h.operations.runAction(pluginId, 'authorization', 'revoke', body);

      assert.equal(result.status, 400, JSON.stringify(result.body));
      assert.deepEqual(h.calls, []);
    }
  });

  test('with the row input it calls the declared method, then returns to the list', async () => {
    const h = harness({ render: 'rows', data: { rows: [] } });

    const result = await h.operations.runAction(pluginId, 'authorization', 'revoke', { conversationId: 'a1' });

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(
      h.calls.map(({ method, params }) => [method, params.input]),
      [['authorization.revoke', { account: 'owner@example.com', conversationId: 'a1' }]],
    );
    assert.equal(result.body.currentAction, 'list');
    assert.equal(result.body.advance, true);
  });
});

test('the projection gives the web each row action and every declared confirmation', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'f202-w2-3-h1-'));
  roots.push(projectRoot);
  const service = new HostPluginConfigurationService({
    projectRoot,
    inventory: { snapshot: async () => snapshot(manifest()) },
  });

  const operation = (await service.fields(pluginId)).find((field) => field.key === 'authorization');

  assert.deepEqual(operation.actions, [
    { id: 'list', label: 'List', render: 'status', resultRender: 'rows' },
    { id: 'reset', label: 'Reset all', render: 'button', confirm: 'Forget every authorization?' },
  ]);
  assert.deepEqual(operation.rowActions, [
    { id: 'revoke', label: 'Revoke', confirm: 'Stop routing this conversation to Clowder?', next: 'list' },
  ]);
});
