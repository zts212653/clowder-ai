/**
 * Trust-boundary unit tests for the stdio config/secret projection added by F202 C1 gap C.
 *
 * NOT part of the 8-case C1 exit gate (that lives in the two f202-c1-*.test.js files). The gate
 * pins the capability — "a migrated npm package receives its manifest-declared config/secrets".
 * These pin the boundary conditions that capability creates, which nothing else observes:
 *
 *  - `CLOWDER_*` is the Host's identity handshake with the child (supervisor.ts spawn env). Once
 *    a manifest key becomes an environment variable, a package declaring `CLOWDER_PLUGIN_ID` as
 *    configuration would restate its own Host-issued identity on spawn.
 *  - a declared field whose grant the instance does not hold must never be projected, even with a
 *    value in the store — the same rule the in-process module path enforces.
 *  - a required field with no stored value must refuse to start rather than hand a provider a
 *    runtime it cannot authenticate from.
 *
 * These drive `composition.supervisor.start()` — the component that owns the spawn — rather than
 * `lifecycle.enable()`, which deliberately collapses every start failure into one START_FAILED
 * message (external-plugin-lifecycle.ts:333) and so cannot distinguish these refusals.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { HostPluginConfigurationService } from '../dist/domains/plugin/manager/plugin-manager-configuration.js';
import { projectManifestConfigurationEnv } from '../dist/domains/plugin/manifest-configuration-projection.js';
import { productionComposition } from './f202-c1-production-composition-helpers.js';
import {
  EXTERNAL_PACKAGE_DIGEST,
  EXTERNAL_PLUGIN_ID,
  externalManifest,
  FakePluginProcessAdapter,
} from './plugin-external-runtime-helpers.js';

/**
 * Installs a stdio package declaring `configuration`, earns readiness through the real
 * configuration authority, then writes the enabled authority state directly — `lifecycle.enable`
 * blocks on a handshake the fixture process never completes.
 */
async function fixture(
  configuration,
  { grants = ['events.publish', 'secret.read'], store = true, onVerifyIntegrity } = {},
) {
  const projectRoot = await mkdtemp(resolve(tmpdir(), 'f202-c1-projection-guard-'));
  await mkdir(resolve(projectRoot, 'dist'), { recursive: true });
  await writeFile(resolve(projectRoot, 'dist/plugin.js'), '// fixture entrypoint\n', 'utf8');

  const base = externalManifest();
  const manifest = {
    ...base,
    features: base.features.map((feature) => ({
      ...feature,
      capabilities: [...feature.capabilities, 'secret.read'],
    })),
    configuration,
  };
  const processes = new FakePluginProcessAdapter();
  /**
   * `verifyIntegrity` is the last Host step before the configuration projection and the spawn, so
   * it is the exact seam a revoke-during-start race has to enter through.
   */
  const started = {};
  const packages = {
    async resolveInstalledPackage() {
      return {
        rootDir: projectRoot,
        manifest,
        verifyIntegrity: async () => {
          if (onVerifyIntegrity) await onVerifyIntegrity(started);
        },
        release: async () => undefined,
      };
    },
  };
  const { runtime } = await productionComposition(projectRoot, { processes, packages });
  const installed = await runtime.inventory.installPackage({
    manifest,
    computedPackageDigest: EXTERNAL_PACKAGE_DIGEST,
    expectedPackageDigest: EXTERNAL_PACKAGE_DIGEST,
    packagePluginId: EXTERNAL_PLUGIN_ID,
    effectiveGrants: grants,
    signalSchemas: {
      'schemas/external.signal.v1.schema.json': {
        type: 'object',
        properties: { payload: { type: 'object' }, source: { type: 'object' } },
        required: ['payload', 'source'],
      },
    },
  });

  const service = new HostPluginConfigurationService({ projectRoot, inventory: runtime.inventoryStore });
  const before = await runtime.inventoryStore.snapshot();
  const record = before.instances.find((i) => i.pluginInstanceId === installed.pluginInstanceId);
  if (store) {
    await service.configure(EXTERNAL_PLUGIN_ID, installed.pluginInstanceId, {
      expectedRevision: record.configRevision ?? record.lifecycleRevision,
      updates: configuration.map((field) => ({ key: field.key, value: `value-for-${field.key}` })),
    });
  }
  await service.reconcile(EXTERNAL_PLUGIN_ID, installed.pluginInstanceId);
  await runtime.inventoryStore.transaction((transaction) => {
    const instance = transaction.instances.get(installed.pluginInstanceId);
    transaction.instances.put({
      ...instance,
      configReadiness: 'ready',
      activationState: 'enabled',
      runtimeState: 'stopped',
      updatedAt: 5_001,
    });
  });
  started.runtime = runtime;
  started.pluginInstanceId = installed.pluginInstanceId;
  return { runtime, processes, pluginInstanceId: installed.pluginInstanceId };
}

/**
 * Returns whichever comes first: the supervisor refusing, or a spawned child. A successful spawn
 * never resolves `start()` here (the fixture process completes no handshake), so awaiting it
 * directly would hang for the whole pre-active timeout exactly when the projection is wrong.
 */
async function startOutcome(runtime, pluginInstanceId, processes, timeoutMs = 2_000) {
  let refusal;
  const starting = runtime.supervisor.start(pluginInstanceId).catch((error) => {
    refusal = error;
  });
  const deadline = Date.now() + timeoutMs;
  while (refusal === undefined && processes.specs.length === 0 && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 5));
  }
  return { refusal, spec: processes.specs[0], starting };
}

describe('F202 C1 gap C — stdio config projection trust boundary', () => {
  test('a manifest key inside the CLOWDER_ protocol namespace refuses to start', async () => {
    const { runtime, processes, pluginInstanceId } = await fixture([
      { key: 'CLOWDER_PLUGIN_ID', label: 'Shadowed protocol id', kind: 'string', required: true },
    ]);

    const { refusal, spec, starting } = await startOutcome(runtime, pluginInstanceId, processes);

    assert.equal(spec, undefined, 'the child must never be spawned with a shadowed protocol variable');
    assert.match(
      String(refusal?.message ?? refusal),
      /CLOWDER_/,
      'a package must not be able to restate its own Host-issued identity through configuration',
    );

    await runtime.shutdown('test');
    await starting;
  });

  test('a declared field the instance holds no grant for is never projected', async () => {
    const { runtime, processes, pluginInstanceId } = await fixture(
      [{ key: 'FEISHU_APP_SECRET', label: 'Feishu app secret', kind: 'secret', required: false }],
      { grants: ['events.publish'] },
    );

    const { spec, starting } = await startOutcome(runtime, pluginInstanceId, processes);

    assert.notEqual(spec, undefined, 'an optional ungranted field must not block activation');
    assert.deepEqual(
      Object.keys(spec.env ?? {}).filter((key) => !key.startsWith('CLOWDER_')),
      [],
      'projection is grant-checked: a stored value without secret.read must stay inside the Host',
    );

    await runtime.shutdown('test');
    await starting;
  });

  test('a required field with no stored value refuses to start', async () => {
    const { runtime, processes, pluginInstanceId } = await fixture(
      [{ key: 'FEISHU_APP_SECRET', label: 'Feishu app secret', kind: 'secret', required: true }],
      { store: false },
    );

    const { refusal, spec, starting } = await startOutcome(runtime, pluginInstanceId, processes);

    assert.equal(spec, undefined, 'no spawn may happen while a required value is unavailable');
    assert.match(
      String(refusal?.message ?? refusal),
      /FEISHU_APP_SECRET/,
      'a provider that cannot authenticate must fail closed and name the missing authority',
    );

    await runtime.shutdown('test');
    await starting;
  });

  /**
   * Sixth-round review P1. Rule 2 (skip an ungranted field) ran before rule 3 (a required field
   * must fail closed), so a required secret whose grant the instance does not hold disappeared
   * silently and the child started blind. Missing authority is not the same as an absent optional
   * value: the first must refuse, the second must still be omitted (the case above this one).
   */
  test('a required field whose grant the instance does not hold refuses to start', async () => {
    const { runtime, processes, pluginInstanceId } = await fixture(
      [{ key: 'FEISHU_APP_SECRET', label: 'Feishu app secret', kind: 'secret', required: true }],
      { grants: ['events.publish'] },
    );

    const { refusal, spec, starting } = await startOutcome(runtime, pluginInstanceId, processes);

    assert.equal(spec, undefined, 'a required authority the instance cannot read must never reach a spawn');
    assert.match(
      String(refusal?.message ?? refusal),
      /FEISHU_APP_SECRET/,
      'the refusal must name the required field whose grant is missing',
    );

    await runtime.shutdown('test');
    await starting;
  });

  /**
   * Sixth-round review P1. `startOwned()` snapshots the grant record once, then crosses package
   * resolution, integrity verification and the configuration read before spawning. A revoke landing
   * inside that window used to still hand the revoked secret to the child, because nothing
   * re-validated `grantRevision` before process authority received the environment.
   */
  test('a grant revoked inside the start window refuses before the child receives the secret', async () => {
    const { runtime, processes, pluginInstanceId } = await fixture(
      [{ key: 'FEISHU_APP_SECRET', label: 'Feishu app secret', kind: 'secret', required: true }],
      {
        async onVerifyIntegrity(started) {
          const snapshot = await started.runtime.inventoryStore.snapshot();
          const grants = snapshot.grants.find((candidate) => candidate.pluginInstanceId === started.pluginInstanceId);
          await started.runtime.inventory.revokeGrant({
            pluginInstanceId: started.pluginInstanceId,
            capability: 'secret.read',
            expectedGrantRevision: grants.grantRevision,
          });
        },
      },
    );

    const { refusal, spec, starting } = await startOutcome(runtime, pluginInstanceId, processes);

    assert.equal(spec, undefined, 'a revoked secret must never reach process authority');
    assert.notEqual(refusal, undefined, 'the supervisor must refuse once the authority it read has changed');

    await runtime.shutdown('test');
    await starting;
  });

  /**
   * Sixth-round review P1, at the level that decides it. A Host with no configuration port used to
   * return an empty environment before the manifest was consulted at all, so a package declaring a
   * required secret started blind. The composition always supplies a port, which is exactly why
   * this contract has to be pinned on the projector rather than only through the supervisor.
   */
  test('an unreadable configuration port still refuses a required field', async () => {
    const unreadable = { readConfig: async () => undefined, readSecret: async () => undefined };
    const manifest = {
      ...externalManifest(),
      configuration: [{ key: 'FEISHU_APP_SECRET', label: 'Feishu app secret', kind: 'secret', required: true }],
    };

    await assert.rejects(
      projectManifestConfigurationEnv({
        pluginInstanceId: 'inst-unreadable',
        manifest,
        effectiveGrants: ['secret.read'],
        configuration: unreadable,
      }),
      /FEISHU_APP_SECRET/,
      'a required field must refuse when nothing can read its value',
    );

    const optional = {
      ...externalManifest(),
      configuration: [{ key: 'FEISHU_APP_SECRET', label: 'Feishu app secret', kind: 'secret', required: false }],
    };
    assert.deepEqual(
      await projectManifestConfigurationEnv({
        pluginInstanceId: 'inst-unreadable',
        manifest: optional,
        effectiveGrants: ['secret.read'],
        configuration: unreadable,
      }),
      {},
      'an optional field with nothing to read is still omitted, not a refusal',
    );
  });
});
