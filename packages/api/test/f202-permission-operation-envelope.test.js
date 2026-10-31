import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import {
  consumeOwnerOperationInvocation,
  withOwnerOperationRequest,
} from '../dist/domains/plugin/carrier/plugin-owner-operation-context.js';
import { InstalledPluginOperations } from '../dist/domains/plugin/operations/plugin-operation-routes.js';

test('declared operation transports a raw import envelope and a no-PII receipt without a dedicated Host API', async () => {
  const manifest = {
    pluginId: 'dev.clowder.report-fixture',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Report fixture',
    features: [{ id: 'main', name: 'Main', capabilities: [], contributions: [], resources: [] }],
    runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
    configuration: [
      {
        key: 'report_import',
        label: 'One-time report import',
        kind: 'operation',
        required: false,
        actions: [
          {
            id: 'import',
            label: 'Import',
            render: 'button',
            confirm: 'Import existing report data?',
            action: { method: 'reports.import' },
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
    snapshot: { config: { privateReportName: '[]' }, groups: {} },
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
        schemaVersion: 1,
        grants: [],
        packages: [{ packageDigest: 'fixture-digest', manifest }],
        instances: [
          {
            pluginId: manifest.pluginId,
            pluginInstanceId: 'fixture-instance',
            packageDigest: 'fixture-digest',
            lifecycleState: 'installed',
            activationState: 'enabled',
            runtimeState: 'healthy',
            lifecycleRevision: 1,
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
      invoke: async (instance, method, params) =>
        consumeOwnerOperationInvocation(
          instance,
          method,
          undefined,
          () => {},
          async () => {
            assert.equal(instance, 'fixture-instance');
            assert.equal(method, 'reports.import');
            assert.deepEqual(params, { input: { existingConfig: 'config stays in action input', ...envelope } });
            if (fail) throw new Error('invalid report import');
            return receipt;
          },
        ),
    },
  });
  const runConfirmed = () =>
    withOwnerOperationRequest(
      {
        pluginId: manifest.pluginId,
        operationKey: 'report_import',
        actionId: 'import',
        userId: 'fixture-owner',
        requestId: 'fixture-request',
        confirmed: true,
        signal: new AbortController().signal,
        assertCurrent() {},
      },
      () => operations.runAction(manifest.pluginId, 'report_import', 'import', envelope),
    );
  assert.equal((await operations.runAction(manifest.pluginId, 'report_import', 'import', envelope)).status, 400);
  assert.equal(saved.length, 0, 'a declared confirmation is required before any action or state write');
  const response = await runConfirmed();
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.data, receipt.data);
  assert.equal(saved.length, 1);
  assert.equal(JSON.stringify(response).includes('privateReportName'), false);
  fail = true;
  assert.equal((await runConfirmed()).status, 502);
  assert.equal(saved.length, 1, 'a rejected package import must not persist a success operation state');
});
