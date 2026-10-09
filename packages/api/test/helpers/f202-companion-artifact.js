/** Pinned companion through real admission, integrity verification, lifecycle and ModulePluginRuntime. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BundledPluginRuntimeCarrier } from '../../dist/domains/plugin/builtin-runtime/carriers/bundled-runtime-carrier.js';
import { ModulePluginRuntime } from '../../dist/domains/plugin/builtin-runtime/carriers/module-plugin-runtime.js';
import { PluginRuntimeCarrierRouter } from '../../dist/domains/plugin/carrier/runtime-carrier.js';
import { CloudConversationHostRegistry } from '../../dist/domains/plugin/declared/cloud-conversation-host-registry.js';
import { FilesystemVerifiedPluginPackageLocator } from '../../dist/domains/plugin/external-runtime/filesystem-package-locator.js';
import {
  ExternalPluginLifecycleService,
  HostInventoryControlPlane,
  LocalPluginPackageAdmission,
  MemoryPluginInventoryStore,
} from '../../dist/domains/plugin/index.js';
import { resolveLocalPluginEffectiveGrants } from '../../dist/domains/plugin/manager/machine-catalog-provider.js';
import { OFFICIAL_PLUGIN_HOST_POLICIES } from '../../dist/domains/plugin/manager/official-plugin-host-policies.js';
import { COMPANION_ARTIFACT } from './f202-companion-artifact-pins.js';

export const ARCHIVE = process.env.F202_COMPANION_ARCHIVE;
export const SHA256 = COMPANION_ARTIFACT.sha256;
export const METHOD = 'personal-chrome-host.';

export async function companionHarness(t) {
  assert.ok(ARCHIVE, 'F202_COMPANION_ARCHIVE must name the pinned companion archive');
  assert.equal(
    createHash('sha256')
      .update(await readFile(ARCHIVE))
      .digest('hex'),
    SHA256,
  );
  // A short socket path on macOS, never the running Host's data directory.
  const root = await mkdtemp('/tmp/f202-h3c3-');
  const packagesRoot = join(root, 'packages');
  const dataDirectoryParent = join(root, 'plugin-host');
  const dataDirectory = join(dataDirectoryParent, 'personal-chrome-host');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store);
  const admission = new LocalPluginPackageAdmission({
    inventory,
    packagesRoot,
    grantPolicy: (manifest) => resolveLocalPluginEffectiveGrants(OFFICIAL_PLUGIN_HOST_POLICIES, manifest),
  });
  const registry = new CloudConversationHostRegistry();
  let lifecycle;
  let instanceId;
  const revision = async () => (await store.snapshot()).instances.find((row) => row.pluginInstanceId === instanceId);
  t.after(async () => {
    const row = instanceId && (await revision());
    if (row?.activationState === 'enabled') await lifecycle.disable(instanceId, row.lifecycleRevision);
    await rm(root, { recursive: true, force: true });
  });
  const installed = await admission.install({ kind: 'local-archive', path: ARCHIVE });
  instanceId = installed.pluginInstanceId;
  const record = (await store.snapshot()).packages.find((row) => row.packageDigest === installed.packageDigest);
  assert.equal(record.provenance.dependencyClosure, 'shipped');
  assert.equal(record.manifest.version, COMPANION_ARTIFACT.version);
  const grant = (await store.snapshot()).grants.find((row) => row.pluginInstanceId === instanceId);
  assert.deepEqual([...grant.effectiveGrants].sort(), ['cloud.conversation.host', 'data.directory']);
  const packages = new FilesystemVerifiedPluginPackageLocator(packagesRoot);
  const configuration = { readConfig: async () => undefined, readSecret: async () => undefined };
  const logs = [];
  const runtime = new ModulePluginRuntime({
    packages,
    configuration,
    dataDirectoryParent,
    log: (...args) => logs.push(args),
  });
  const router = new PluginRuntimeCarrierRouter(store, undefined, {
    packages,
    configuration,
    cloudConversationHosts: registry,
  });
  router.register(new BundledPluginRuntimeCarrier({ inventory: store, runtimes: [runtime] }));
  lifecycle = new ExternalPluginLifecycleService({ store, supervisor: router });
  return {
    root,
    dataDirectory,
    registry,
    logs,
    record,
    invoke: (method, input = {}) => router.invoke(instanceId, METHOD + method, input),
    async enable() {
      const prepared = await lifecycle.prepare(instanceId, (await revision()).lifecycleRevision);
      return lifecycle.enable(instanceId, prepared.lifecycleRevision);
    },
    async disable() {
      return lifecycle.disable(instanceId, (await revision()).lifecycleRevision);
    },
  };
}
