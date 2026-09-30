/**
 * F202 W2-6b — what the Host knows about a failure is stored beside `lastRuntimeError`, never inside it
 * (ledger「W2-6b」(3); astra's design review P2, Host thread …000091).
 *
 * The core record keeps its four fields and legacy codes, so a Host from before W2-6b still reads the
 * inventory (its instance parser keeps only the fields it knows). The detail is checked strictly by
 * this Host, bound to the failure it explains, and written and cleared with it everywhere.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';
import { pluginRuntimeDiagnostic } from '../dist/domains/plugin/diagnostics/plugin-runtime-diagnostic.js';
import { projectRuntimeCrash } from '../dist/domains/plugin/external-runtime/runtime-crash-projection.js';
import { setRuntimeState } from '../dist/domains/plugin/external-runtime/runtime-state-projection.js';
import {
  currentRuntimeErrorDetail,
  withoutRuntimeFailure,
  withRuntimeFailure,
} from '../dist/domains/plugin/host-inventory/runtime-failure-record.js';
import { parsePluginInventorySnapshot } from '../dist/domains/plugin/host-inventory/snapshot.js';
import { hostCapabilityRefusal } from '../dist/domains/plugin/host-surface/host-capability-refusal.js';
import {
  BundledPluginRuntimeCarrier,
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
} from '../dist/domains/plugin/index.js';

const DIGEST = `sha512-${createHash('sha512').update('w26b-record').digest('base64')}`;
const OTHER_DIGEST = `sha512-${createHash('sha512').update('w26b-record-other-version').digest('base64')}`;
const CONTRACT = { manifestContractVersions: ['0.1.0'], validateEffectiveGrants, validateManifest };
const FAILURE = { code: 'UNEXPECTED_RUNTIME_FAILURE', exitCode: null, signal: null, occurredAt: 5_000 };
const DETAIL = {
  kind: 'capability_not_granted',
  capability: 'thread.listMetadata',
  occurredAt: 5_000,
  packageDigest: DIGEST,
};

async function inventory() {
  const store = new MemoryPluginInventoryStore();
  const control = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_w26b', now: () => 1 });
  await control.installPackage({
    manifest: {
      pluginId: 'dev.example.w26b',
      version: '0.1.0',
      contractVersion: '0.1.0',
      name: 'W2-6b',
      features: [{ id: 'main', name: 'Main', resources: [], capabilities: ['thread.listMetadata'] }],
      runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
    },
    computedPackageDigest: DIGEST,
    expectedPackageDigest: DIGEST,
    packagePluginId: 'dev.example.w26b',
    effectiveGrants: [],
  });
  return store;
}

/** The stored JSON with the one instance changed by `change`. */
async function storedWith(change) {
  const raw = JSON.parse(JSON.stringify(await (await inventory()).snapshot()));
  raw.instances[0] = change(raw.instances[0]);
  return raw;
}

test('a bound detail is read back; the core record keeps exactly its four legacy fields', async () => {
  const raw = await storedWith((instance) => ({
    ...instance,
    lastRuntimeError: FAILURE,
    lastRuntimeErrorDetail: DETAIL,
  }));
  assert.deepEqual(Object.keys(raw.instances[0].lastRuntimeError).sort(), ['code', 'exitCode', 'occurredAt', 'signal']);

  const [instance] = parsePluginInventorySnapshot(raw, CONTRACT).instances;
  assert.deepEqual(instance.lastRuntimeError, FAILURE);
  assert.deepEqual(instance.lastRuntimeErrorDetail, DETAIL);
});

test('what an older Host relies on: an instance field the parser does not know is ignored, not refused', async () => {
  const raw = await storedWith((instance) => ({
    ...instance,
    lastRuntimeError: FAILURE,
    fieldFromANewerHost: { x: 1 },
  }));
  const [instance] = parsePluginInventorySnapshot(raw, CONTRACT).instances;
  assert.deepEqual(instance.lastRuntimeError, FAILURE);
  assert.equal('fieldFromANewerHost' in instance, false);
});

test('an inventory from before W2-6b is read unchanged and projects its legacy diagnostic', async () => {
  const raw = await storedWith((instance) => ({ ...instance, lastRuntimeError: FAILURE }));
  const [instance] = parsePluginInventorySnapshot(raw, CONTRACT).instances;
  assert.equal(instance.lastRuntimeErrorDetail, undefined);
  assert.deepEqual(pluginRuntimeDiagnostic(instance, { requestedCapabilities: ['thread.listMetadata'] }), {
    code: 'UNEXPECTED_RUNTIME_FAILURE',
    message: 'Plugin runtime reported UNEXPECTED_RUNTIME_FAILURE.',
    occurredAt: 5_000,
    revision: instance.lifecycleRevision,
  });
});

test('a stale detail is dropped on read, never a reason to refuse the inventory', async () => {
  const other = await storedWith((instance) => ({
    ...instance,
    lastRuntimeError: FAILURE,
    lastRuntimeErrorDetail: { ...DETAIL, occurredAt: 4_000 },
  }));
  assert.equal(parsePluginInventorySnapshot(other, CONTRACT).instances[0].lastRuntimeErrorDetail, undefined);

  const orphan = await storedWith((instance) => ({ ...instance, lastRuntimeErrorDetail: DETAIL }));
  assert.equal(parsePluginInventorySnapshot(orphan, CONTRACT).instances[0].lastRuntimeErrorDetail, undefined);

  const anotherPackage = await storedWith((instance) => ({
    ...instance,
    lastRuntimeError: FAILURE,
    lastRuntimeErrorDetail: { ...DETAIL, packageDigest: OTHER_DIGEST },
  }));
  assert.equal(
    parsePluginInventorySnapshot(anotherPackage, CONTRACT).instances[0].lastRuntimeErrorDetail,
    undefined,
    'a reason about another version of the package never explains this one',
  );
});

test('a malformed detail is a corrupt snapshot, like any other malformed field', async () => {
  const malformed = [
    'not an object',
    { ...DETAIL, extra: true },
    { kind: 'capability_not_granted', capability: 'thread.listMetadata' },
    { ...DETAIL, kind: 'permission_denied' },
    { ...DETAIL, capability: 'thread.everything' },
    { ...DETAIL, occurredAt: -1 },
    { ...DETAIL, packageDigest: 42 },
    { ...DETAIL, packageDigest: '' },
  ];
  for (const detail of malformed) {
    const raw = await storedWith((instance) => ({
      ...instance,
      lastRuntimeError: FAILURE,
      lastRuntimeErrorDetail: detail,
    }));
    assert.throws(
      () => parsePluginInventorySnapshot(raw, CONTRACT),
      (error) => error.code === 'CORRUPT_SNAPSHOT' && /lastRuntimeErrorDetail/u.test(error.message),
      JSON.stringify(detail),
    );
  }
});

test('a failure and its detail are written together, replaced together and cleared together', async () => {
  const [base] = (await (await inventory()).snapshot()).instances;
  const failed = withRuntimeFailure(base, FAILURE, DETAIL);
  assert.deepEqual(currentRuntimeErrorDetail(failed), DETAIL);

  const replaced = withRuntimeFailure(failed, { ...FAILURE, code: 'UPDATE_RESUME_FAILED', occurredAt: 6_000 });
  assert.equal(replaced.lastRuntimeError.code, 'UPDATE_RESUME_FAILED');
  assert.equal('lastRuntimeErrorDetail' in replaced, false, 'a new failure never inherits the old reason');

  const mismatched = withRuntimeFailure(base, FAILURE, { ...DETAIL, occurredAt: 4_000 });
  assert.equal('lastRuntimeErrorDetail' in mismatched, false, 'a detail explaining another failure is not attached');
  const otherPackage = withRuntimeFailure(base, FAILURE, { ...DETAIL, packageDigest: OTHER_DIGEST });
  assert.equal('lastRuntimeErrorDetail' in otherPackage, false, 'nor one about another version of the package');
  assert.equal(currentRuntimeErrorDetail({ ...failed, packageDigest: OTHER_DIGEST }), undefined);

  const cleared = withoutRuntimeFailure(failed);
  assert.equal('lastRuntimeError' in cleared, false);
  assert.equal('lastRuntimeErrorDetail' in cleared, false);
});

test('a process crash and a new start clear an earlier detail', async () => {
  const store = await inventory();
  const seed = async (patch) =>
    store.transaction((transaction) => {
      const [instance] = transaction.instances.list();
      transaction.instances.put({ ...withRuntimeFailure(instance, FAILURE, DETAIL), ...patch });
    });
  const current = async () => (await store.snapshot()).instances[0];

  // A commit already drops a detail whose instant differs from the failure's; one from the same
  // instant would still look bound, so only the writer's own clearing keeps it off the new failure.
  await seed({ runtimeState: 'stopped' });
  await projectRuntimeCrash(
    store,
    { pluginInstanceId: 'pi_w26b', packageDigest: DIGEST, started: false, exit: { code: 1, signal: null } },
    () => FAILURE.occurredAt,
  );
  assert.equal((await current()).lastRuntimeError.exitCode, 1);
  assert.equal((await current()).lastRuntimeErrorDetail, undefined, 'a crash is never explained by an earlier refusal');

  await seed({ configReadiness: 'ready', activationState: 'enabled', runtimeState: 'stopped' });
  await setRuntimeState(
    { inventory: store, now: () => 8_000 },
    { pluginInstanceId: 'pi_w26b', packageDigest: DIGEST },
    'starting',
  );
  assert.equal((await current()).lastRuntimeError, undefined);
  assert.equal((await current()).lastRuntimeErrorDetail, undefined);
});

test('the in-Host carrier records the reason with its own failure write, and a new start clears both', async () => {
  const store = await inventory();
  await store.transaction((transaction) => {
    const [instance] = transaction.instances.list();
    transaction.instances.put({
      ...withRuntimeFailure(instance, FAILURE, DETAIL),
      configReadiness: 'ready',
      activationState: 'enabled',
      runtimeState: 'stopped',
    });
  });
  let refuse = false;
  const carrier = new BundledPluginRuntimeCarrier({
    inventory: store,
    now: () => 9_000,
    runtimes: [
      {
        claims: () => true,
        async start() {
          if (refuse)
            throw new Error('bind failed', { cause: hostCapabilityRefusal(new Error('lacks'), 'thread.write') });
        },
        async stop() {},
      },
    ],
  });
  const current = async () => (await store.snapshot()).instances[0];

  await carrier.start('pi_w26b');
  assert.equal((await current()).lastRuntimeError, undefined);
  assert.equal((await current()).lastRuntimeErrorDetail, undefined, 'the stale reason goes with the stale failure');
  await carrier.stop('pi_w26b');

  refuse = true;
  await assert.rejects(carrier.start('pi_w26b'), /bind failed/u);
  assert.equal((await current()).lastRuntimeError.code, 'UNEXPECTED_RUNTIME_FAILURE');
  assert.deepEqual((await current()).lastRuntimeErrorDetail, {
    kind: 'capability_not_granted',
    capability: 'thread.write',
    occurredAt: 9_000,
    packageDigest: DIGEST,
  });
});

test('the owner is told what was refused, without being told to upgrade or to edit a policy', async () => {
  const [base] = (await (await inventory()).snapshot()).instances;
  const failed = withRuntimeFailure(base, FAILURE, DETAIL);

  const declared = pluginRuntimeDiagnostic(failed, {
    requestedCapabilities: ['thread.listMetadata'],
    effectiveGrants: [],
  });
  assert.equal(declared.code, 'CAPABILITY_NOT_GRANTED');
  assert.equal(declared.capability, 'thread.listMetadata');
  assert.equal(declared.occurredAt, 5_000);
  assert.match(declared.message, /uses thread\.listMetadata, which the current Host policy does not grant it/u);
  assert.match(declared.message, /compatible with this Host, or contact the plugin maintainer/u);
  assert.doesNotMatch(declared.message, /upgrade|update/iu);

  const undeclared = pluginRuntimeDiagnostic(failed, { requestedCapabilities: [], effectiveGrants: [] });
  assert.match(undeclared.message, /uses thread\.listMetadata without declaring it, which is a defect in the plugin/u);

  // Granted since the failure — say so, not that the policy refuses it.
  const grantedNow = pluginRuntimeDiagnostic(failed, {
    requestedCapabilities: ['thread.listMetadata'],
    effectiveGrants: ['thread.listMetadata'],
  });
  assert.equal(grantedNow.capability, 'thread.listMetadata');
  assert.match(grantedNow.message, /refused this plugin version thread\.listMetadata when it last started/u);
  assert.match(grantedNow.message, /granted now, so enable the plugin again/u);
  assert.doesNotMatch(grantedNow.message, /does not grant/u);

  const stale = pluginRuntimeDiagnostic({ ...failed, lastRuntimeErrorDetail: { ...DETAIL, occurredAt: 1 } }, undefined);
  assert.equal(stale.code, 'UNEXPECTED_RUNTIME_FAILURE');
  const otherVersion = pluginRuntimeDiagnostic({ ...failed, packageDigest: OTHER_DIGEST }, undefined);
  assert.equal(otherVersion.code, 'UNEXPECTED_RUNTIME_FAILURE', 'never read against another version');
});
