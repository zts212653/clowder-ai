/**
 * F202 W2-6b — a refusal explains the package version it happened to, never the next one (astra's
 * review of `b9bbbf5c3a`, Host thread …000100, P2).
 *
 * The reason is bound to the failing package. Updating the instance to another version — here through
 * the real official-catalog update path — leaves the old failure record but drops its reason, so the
 * new version, which has not even run, is never described by what the old one did. An update that
 * is refused changes nothing, reason included.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pluginRuntimeDiagnostic } from '../dist/domains/plugin/diagnostics/plugin-runtime-diagnostic.js';
import { startFailureRecord } from '../dist/domains/plugin/diagnostics/plugin-start-failure.js';
import { ExternalPluginRuntimeError } from '../dist/domains/plugin/external-runtime/types.js';
import { withRuntimeFailure } from '../dist/domains/plugin/host-inventory/runtime-failure-record.js';
import { hostCapabilityRefusal } from '../dist/domains/plugin/host-surface/host-capability-refusal.js';
import { OfficialPluginPackageInstaller } from '../dist/domains/plugin/official-package-installer.js';
import {
  catalogEntry,
  harness,
  isInstallError,
  manifest,
  packageArchive,
  releaseFence,
} from './plugin-official-package-installer.fixture.js';

const BOUND = ['events.publish'];
const requesting = (capabilities, version) =>
  manifest({ version, features: [{ id: 'source', name: 'Source', resources: [], capabilities }] });

async function release(version, capabilities) {
  const archive = await packageArchive({ packageManifest: requesting(capabilities, version) });
  const entry = catalogEntry(archive.integrity, {
    version,
    effectiveGrants: BOUND,
    archiveUrl: `https://registry.npmjs.org/@clowder-ai/official-test-source/-/official-test-source-${version}.tgz`,
  });
  return { archive, entry };
}

/** Version 0.1.0-alpha.1 installed, asking for thread.listMetadata, and refused it when it started. */
async function failedInstall() {
  const first = await release('0.1.0-alpha.1', ['events.publish', 'thread.listMetadata']);
  const { store, inventory, packagesRoot, installer } = await harness(first.archive, first.entry);
  await installer.install(first.entry.catalogId, releaseFence(first.entry));
  await store.transaction((transaction) => {
    const [instance] = transaction.instances.list();
    const refusal = hostCapabilityRefusal(
      new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${instance.pluginId} lacks thread.listMetadata`),
      'thread.listMetadata',
    );
    const { record, detail } = startFailureRecord(refusal, 20_000, instance.packageDigest);
    transaction.instances.put({ ...withRuntimeFailure(instance, record, detail), activationState: 'error' });
  });
  const current = async () => {
    const snapshot = await store.snapshot();
    const instance = snapshot.instances.find((candidate) => candidate.lifecycleState === 'installed');
    const grant = snapshot.grants.find((candidate) => candidate.pluginInstanceId === instance.pluginInstanceId);
    return { instance, grant, diagnostic: pluginRuntimeDiagnostic(instance, grant) };
  };
  const updater = (next) =>
    new OfficialPluginPackageInstaller({
      inventory,
      packagesRoot,
      catalog: [next.entry],
      fetchArchive: async () => next.archive.bytes,
    });
  return { current, updater };
}

test('before any update, the refusal explains the version that failed', async () => {
  const { current } = await failedInstall();
  const { diagnostic } = await current();
  assert.equal(diagnostic.code, 'CAPABILITY_NOT_GRANTED');
  assert.equal(diagnostic.capability, 'thread.listMetadata');
  assert.match(diagnostic.message, /current Host policy does not grant it/u);
});

test('after an update to a version that no longer uses it, the old refusal is not blamed on the new version', async () => {
  const { current, updater } = await failedInstall();
  const next = await release('0.1.0-alpha.2', ['events.publish']);
  const before = await current();

  await updater(next).update(
    next.entry.catalogId,
    before.instance.pluginInstanceId,
    before.instance.lifecycleRevision,
    releaseFence(next.entry),
  );

  const after = await current();
  assert.notEqual(after.instance.packageDigest, before.instance.packageDigest, 'the package was swapped');
  assert.deepEqual(after.grant.requestedCapabilities, ['events.publish']);
  assert.equal(after.instance.lastRuntimeErrorDetail, undefined, 'the reason did not survive the swap');
  assert.equal(after.diagnostic.capability, undefined);
  assert.doesNotMatch(after.diagnostic.message, /thread\.listMetadata|defect/u);
  assert.equal(
    after.diagnostic.code,
    after.instance.lastRuntimeError.code,
    'the old failure record itself is untouched',
  );
});

test('an update that is refused leaves the failure and its reason as they were', async () => {
  const { current, updater } = await failedInstall();
  const next = await release('0.1.0-alpha.2', ['events.publish']);
  const before = await current();

  await assert.rejects(
    updater(next).update(
      next.entry.catalogId,
      before.instance.pluginInstanceId,
      before.instance.lifecycleRevision + 1,
      releaseFence(next.entry),
    ),
    isInstallError('STALE_REVISION'),
  );

  const after = await current();
  assert.deepEqual(after.instance, before.instance);
  assert.deepEqual(after.diagnostic, before.diagnostic);
});
