import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { readSessionContractSettings } from '../dist/domains/cats/services/agents/session-contract/session-contract-settings.js';
import { DotConnectionRuntime } from '../dist/domains/cats/services/cloud-bridge/dot/DotConnectionRuntime.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { declaredAgentSessionProviders } from '../dist/domains/plugin/declared/declared-agent-session-providers.js';
import { FilesystemVerifiedPluginPackageLocator } from '../dist/domains/plugin/external-runtime/filesystem-package-locator.js';
import { createDormantPluginRuntimeComposition } from '../dist/domains/plugin/index.js';

// Historical Host-bundled Dot inventory predates archive-backed package admission.
const manifest = {
  pluginId: 'official.chatgpt-dot',
  version: '0.1.0',
  contractVersion: '0.1.0',
  name: 'ChatGPT dot',
  features: [{ id: 'dot-connection', name: 'dot connection', resources: [], capabilities: [] }],
  runtime: { transport: 'builtin' },
};
const digest = 'sha512-rfRBkiyXSymsZRAlDManBVU3Mpql1Gffe4R9uwpTRRvQUOcNi2Z+pCoUIce+xeMIvL2o29FwyhqufPC1KGJq3g==';

function agentProviders(packages) {
  return declaredAgentSessionProviders({
    settings: readSessionContractSettings({}),
    packages,
    registry: new SessionImplementationRegistry(),
    services: new Map(),
    createProvider: () => assert.fail('Dot must not create an ACP provider'),
  });
}

async function recoveryHarness(t, provenance) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'plugin-legacy-dot-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const failures = [];
  let connectionChecks = 0;
  const options = {
    projectRoot,
    messageStore: new MessageStore(),
    agentSessionProviders: agentProviders,
    onPluginStartFailure: (report) => failures.push(report),
    builtinRuntimes: new Map([
      [
        manifest.pluginId,
        new DotConnectionRuntime(
          () => ({
            async status() {
              connectionChecks += 1;
              return { credentialActive: true, paired: true, subscription: 'active', replyAt: 1 };
            },
          }),
          async () => true,
        ),
      ],
    ]),
  };
  const initial = createDormantPluginRuntimeComposition(options);
  const installed = await initial.inventory.installPackage({
    manifest,
    computedPackageDigest: digest,
    expectedPackageDigest: digest,
    packagePluginId: manifest.pluginId,
    signalSchemas: {},
    ...(provenance ? { provenance } : {}),
  });
  await initial.inventoryStore.transaction((transaction) => {
    transaction.instances.put({
      ...transaction.instances.get(installed.pluginInstanceId),
      configReadiness: 'ready',
      activationState: 'enabled',
      runtimeState: 'healthy',
    });
  });
  const before = await initial.inventoryStore.snapshot();
  return { options, before, failures, connectionChecks: () => connectionChecks };
}

test('default Agent Session discovery preserves legacy bundled Dot intent across durable restarts without an archive', async (t) => {
  const h = await recoveryHarness(t);
  for (let restart = 0; restart < 2; restart += 1) {
    const runtime = createDormantPluginRuntimeComposition(h.options);
    try {
      assert.equal((await runtime.recoverAfterRestart()).resumeRequested, 1);
      await runtime.lifecycle.drainRestartRecovery();
      const after = await runtime.inventoryStore.snapshot();
      assert.deepEqual(h.failures, [], JSON.stringify(h.failures));
      assert.equal(after.instances[0].activationState, 'enabled');
      assert.equal(after.instances[0].runtimeState, 'healthy');
      assert.equal(after.instances[0].pluginInstanceId, h.before.instances[0].pluginInstanceId);
      assert.equal(after.instances[0].lifecycleRevision, h.before.instances[0].lifecycleRevision);
      assert.equal(after.instances[0].lastRuntimeError, undefined);
      assert.deepEqual(after.packages, h.before.packages, 'immutable package admission must stay unchanged');
      assert.deepEqual(after.grants, h.before.grants);
    } finally {
      await runtime.shutdown();
    }
  }
  assert.equal(h.connectionChecks(), 2, 'both restarts still require the real Dot readiness checks');
  assert.deepEqual(h.failures, []);
});

test('archive-backed bundled Dot still fails closed when its admitted package archive is missing', async (t) => {
  const h = await recoveryHarness(t, {
    kind: 'catalog',
    catalogId: 'chatgpt-dot',
    packageName: '@cat-cafe/chatgpt-dot',
  });
  const runtime = createDormantPluginRuntimeComposition(h.options);
  try {
    await runtime.recoverAfterRestart();
    await runtime.lifecycle.drainRestartRecovery();
    const after = await runtime.inventoryStore.snapshot();
    assert.equal(after.instances[0].activationState, 'error');
    assert.equal(after.instances[0].runtimeState, 'stopped');
    assert.equal(h.failures[0].category.code, 'PACKAGE_AUTHORITY_MISMATCH');
    assert.equal(h.failures[0].error.cause.code, 'ENOENT');
  } finally {
    await runtime.shutdown();
  }
});

test('legacy archive exemption excludes static declarations and executable builtin modules', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-agent-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = agentProviders(new FilesystemVerifiedPluginPackageLocator(root));
  for (const runtime of [undefined, { transport: 'builtin', entrypoint: 'dist/plugin.js' }]) {
    await assert.rejects(
      host.activate({
        packageRecord: { pluginId: manifest.pluginId, packageDigest: digest, manifest: { ...manifest, runtime } },
      }),
      (error) => error.code === 'PACKAGE_AUTHORITY_MISMATCH' && error.cause?.code === 'ENOENT',
    );
  }
});
