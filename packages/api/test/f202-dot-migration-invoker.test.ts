import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  type OwnerOperationRequest,
  withOwnerOperationRequest,
} from '../src/domains/plugin/carrier/plugin-owner-operation-context.js';
import type { PluginInventorySnapshot } from '../src/domains/plugin/host-inventory/types.js';
import {
  PluginMigrationInvocationError,
  PluginMigrationInvoker,
} from '../src/domains/plugin/migration/plugin-migration-invoker.js';

const packageDigest = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
const pluginInstanceId = 'pi_dot_reviewed';

function snapshot(): PluginInventorySnapshot {
  const manifest = {
    pluginId: 'official.chatgpt-dot',
    name: 'ChatGPT Dot',
    version: '0.2.0-alpha.1',
    contractVersion: '0.1.0',
    features: [],
    runtime: { transport: 'builtin' as const, entrypoint: 'dist/plugin-entrypoint.js' },
  };
  return {
    schemaVersion: 1,
    packages: [
      {
        packageDigest,
        pluginId: manifest.pluginId,
        version: manifest.version,
        contractVersion: manifest.contractVersion,
        manifest,
        signalSchemas: {},
        packageState: 'installed',
        verifiedAt: 1,
        updatedAt: 1,
      },
    ],
    instances: [
      {
        pluginInstanceId,
        pluginId: manifest.pluginId,
        packageDigest,
        lifecycleState: 'installed',
        configReadiness: 'ready',
        activationState: 'disabled',
        runtimeState: 'stopped',
        lifecycleRevision: 7,
        installedAt: 1,
        updatedAt: 1,
      },
    ],
    grants: [
      {
        pluginInstanceId,
        requestedCapabilities: [],
        effectiveGrants: [],
        grantRevision: 3,
        updatedAt: 1,
      },
    ],
  };
}

function ownerRequest(signal: AbortSignal): OwnerOperationRequest {
  return {
    pluginId: 'official.chatgpt-dot',
    operationKey: 'legacy-import',
    actionId: 'import',
    userId: 'owner-1',
    requestId: 'request-1',
    signal,
    assertCurrent() {
      if (signal.aborted) throw new Error('owner request expired');
    },
  };
}

async function harness(t: TestContext) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'f202-isolated-importer-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const rootDir = join(projectRoot, 'package');
  await mkdir(join(rootDir, 'dist'), { recursive: true });
  await writeFile(join(rootDir, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(
    join(rootDir, 'dist/migration.js'),
    `export async function importLegacyBatch(_host, input, context) {
      await context.assertCurrent();
      return { input, userId: context.userId, operationKey: context.operationKey, actionId: context.actionId };
    }`,
  );
  const current = snapshot();
  const installedManifest = current.packages[0]?.manifest;
  assert.ok(installedManifest);
  let released = 0;
  const invoker = new PluginMigrationInvoker({
    inventory: { snapshot: async () => current },
    packages: {
      resolveInstalledPackage: async () => ({
        rootDir,
        manifest: installedManifest,
        verifyIntegrity: async () => {},
        release: async () => {
          released += 1;
        },
      }),
    },
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
    projectRoot,
    log: () => {},
  });
  return { invoker, released: () => released };
}

test('isolated legacy adapter calls the package importer without a manifest action name', async (t) => {
  const { invoker, released } = await harness(t);
  const controller = new AbortController();
  const input = { version: 1, dispatches: [] };
  const result = await withOwnerOperationRequest(ownerRequest(controller.signal), () =>
    invoker.invoke({
      pluginId: 'official.chatgpt-dot',
      expectedPluginInstanceId: pluginInstanceId,
      expectedPackageDigest: packageDigest,
      payload: input,
    }),
  );
  assert.deepEqual(result, {
    input,
    userId: 'owner-1',
    operationKey: 'legacy-import',
    actionId: 'import',
  });
  assert.equal(released(), 1);
});

test('isolated legacy adapter rejects stale instance/package bindings', async (t) => {
  const { invoker } = await harness(t);
  const controller = new AbortController();
  await assert.rejects(
    withOwnerOperationRequest(ownerRequest(controller.signal), () =>
      invoker.invoke({
        pluginId: 'official.chatgpt-dot',
        expectedPluginInstanceId: pluginInstanceId,
        expectedPackageDigest: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
        payload: {},
      }),
    ),
    (error: unknown) => error instanceof PluginMigrationInvocationError && error.code === 'MIGRATION_BINDING_CHANGED',
  );
});

test('isolated legacy adapter is unavailable outside its owner-only compatibility carrier', async (t) => {
  const { invoker } = await harness(t);
  await assert.rejects(
    invoker.invoke({
      pluginId: 'official.chatgpt-dot',
      expectedPluginInstanceId: pluginInstanceId,
      expectedPackageDigest: packageDigest,
      payload: {},
    }),
    (error: unknown) => error instanceof PluginMigrationInvocationError && error.code === 'OWNER_AUTHORITY_REQUIRED',
  );
});
