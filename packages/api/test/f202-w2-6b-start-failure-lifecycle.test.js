/**
 * F202 W2-6b — every failed runtime start reaches the Host log, as a safe projection, and a Host
 * refusal is recorded as the reason (ledger「W2-6b」(1)(3)).
 *
 * The lifecycle has four places a start can fail — owner enable (and repair), resume after a Host
 * restart, and resume after maintenance or its rollback. Each tells its observer, which by default is
 * the Host's `plugin/lifecycle` error log. The observer never sees the raw error, and an observer
 * that throws changes nothing the lifecycle records or reports. All credentials below are fake.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { ExternalPluginRuntimeError } from '../dist/domains/plugin/external-runtime/types.js';
import { hostCapabilityRefusal } from '../dist/domains/plugin/host-surface/host-capability-refusal.js';
import {
  ExternalPluginLifecycleService,
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  PluginLifecycleError,
} from '../dist/domains/plugin/index.js';

const PLUGIN_ID = 'dev.example.w26b-lifecycle';
const INSTANCE_ID = 'pi_w26b';
const DIGEST = `sha512-${createHash('sha512').update('w26b-lifecycle').digest('base64')}`;

const roots = [];
after(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function refused(capability = 'thread.listMetadata') {
  return hostCapabilityRefusal(
    new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${PLUGIN_ID} lacks ${capability}`),
    capability,
  );
}

function leakyError() {
  const error = new Error('start failed', {
    cause: new Error('request failed https://example.invalid/?token=FAKE_W26B_QUERY'),
  });
  error.secret = 'FAKE_W26B_PROPERTY';
  error.config = { headers: { Authorization: 'Bearer FAKE_W26B_HEADER' } };
  return error;
}

async function harness({ start, observer } = {}) {
  let now = 1_000;
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => INSTANCE_ID, now: () => now++ });
  await inventory.installPackage({
    manifest: {
      pluginId: PLUGIN_ID,
      version: '0.1.0',
      contractVersion: '0.1.0',
      name: 'W2-6b lifecycle',
      features: [{ id: 'main', name: 'Main', resources: [], capabilities: ['thread.listMetadata'] }],
      runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
    },
    computedPackageDigest: DIGEST,
    expectedPackageDigest: DIGEST,
    packagePluginId: PLUGIN_ID,
    effectiveGrants: [],
  });
  const reports = [];
  const supervisor = { start: start ?? (async () => undefined), stop: async () => undefined };
  const lifecycle = new ExternalPluginLifecycleService({
    store,
    supervisor,
    now: () => now++,
    onStartFailure: observer ?? ((report) => reports.push(report)),
  });
  await lifecycle.prepare(INSTANCE_ID, 1);
  const instance = async () => (await store.snapshot()).instances[0];
  return { store, lifecycle, reports, instance };
}

test('an enable refused a capability: logged safely, recorded beside the legacy record, and named to the owner', async () => {
  const { lifecycle, reports, instance } = await harness({
    start: async () => {
      throw new Error('bind failed', { cause: refused() });
    },
  });

  await assert.rejects(
    lifecycle.enable(INSTANCE_ID, 2),
    (error) =>
      error instanceof PluginLifecycleError &&
      error.code === 'START_FAILED' &&
      error.message === 'official plugin runtime failed to start: the Host refused it thread.listMetadata',
  );

  const failed = await instance();
  assert.equal(failed.activationState, 'error');
  assert.deepEqual(failed.lastRuntimeError, {
    code: 'UNEXPECTED_RUNTIME_FAILURE',
    exitCode: null,
    signal: null,
    occurredAt: failed.lastRuntimeError.occurredAt,
  });
  assert.deepEqual(failed.lastRuntimeErrorDetail, {
    kind: 'capability_not_granted',
    capability: 'thread.listMetadata',
    occurredAt: failed.lastRuntimeError.occurredAt,
    packageDigest: DIGEST,
  });

  assert.equal(reports.length, 1);
  const [report] = reports;
  assert.deepEqual(
    { ...report, error: undefined },
    {
      pluginId: PLUGIN_ID,
      pluginInstanceId: INSTANCE_ID,
      phase: 'enable',
      occurredAt: failed.lastRuntimeError.occurredAt,
      category: { kind: 'capability_not_granted', capability: 'thread.listMetadata' },
      error: undefined,
    },
  );
  assert.deepEqual(
    { origin: report.error.origin, type: report.error.type, message: report.error.message },
    { origin: 'unverified', type: 'Error', message: undefined },
    'what the plugin wrote is not kept',
  );
  assert.deepEqual(
    { ...report.error.cause, at: undefined },
    {
      origin: 'host_refusal',
      type: 'ExternalPluginRuntimeError',
      code: 'DELIVERY_REJECTED',
      capability: 'thread.listMetadata',
      at: undefined,
    },
  );
  assert.ok(report.error.cause.at.length > 0, 'where the Host refused it');
});

test('any other failure keeps the legacy record and message; the observer gets only the safe projection', async () => {
  const { lifecycle, reports, instance } = await harness({
    start: async () => {
      throw leakyError();
    },
  });

  await assert.rejects(
    lifecycle.enable(INSTANCE_ID, 2),
    (error) => error.message === 'official plugin runtime failed to start',
  );

  const failed = await instance();
  assert.equal(failed.lastRuntimeError.code, 'UNEXPECTED_RUNTIME_FAILURE');
  assert.equal(failed.lastRuntimeErrorDetail, undefined);
  assert.deepEqual(reports[0].category, { kind: 'unclassified' });
  assert.doesNotMatch(JSON.stringify(reports), /FAKE_W26B/u);
  assert.deepEqual(Object.keys(reports[0].error.cause).sort(), ['at', 'origin', 'type']);
});

test("a Host runtime error is classified by its code; a plugin's lookalike of a refusal is not a refusal", async () => {
  const entrypoint = await harness({
    start: async () => {
      throw new ExternalPluginRuntimeError('INVALID_ENTRYPOINT', `${PLUGIN_ID} entrypoint must default-export`);
    },
  });
  await assert.rejects(entrypoint.lifecycle.enable(INSTANCE_ID, 2));
  assert.deepEqual(entrypoint.reports[0].category, { kind: 'host_runtime_error', code: 'INVALID_ENTRYPOINT' });

  const lookalike = await harness({
    start: async () => {
      throw Object.assign(new Error(`${PLUGIN_ID} lacks thread.listMetadata`), { code: 'DELIVERY_REJECTED' });
    },
  });
  await assert.rejects(lookalike.lifecycle.enable(INSTANCE_ID, 2), (error) => !/refused it/u.test(error.message));
  assert.deepEqual(lookalike.reports[0].category, { kind: 'unclassified' });
  assert.equal((await lookalike.instance()).lastRuntimeErrorDetail, undefined);
});

test('an observer that throws changes nothing the lifecycle records or reports', async () => {
  const { lifecycle, instance } = await harness({
    start: async () => {
      throw refused('plugin.state.get');
    },
    observer: () => {
      throw new Error('observer failed');
    },
  });

  await assert.rejects(
    lifecycle.enable(INSTANCE_ID, 2),
    (error) => error.code === 'START_FAILED' && /refused it plugin\.state\.get/u.test(error.message),
  );
  const failed = await instance();
  assert.equal(failed.activationState, 'error');
  assert.equal(failed.lastRuntimeErrorDetail.capability, 'plugin.state.get');
});

test('repair reports its own phase; a later successful start clears the failure and its detail', async () => {
  let fail = true;
  const { lifecycle, reports, instance } = await harness({
    start: async () => {
      if (fail) throw refused();
    },
  });
  await assert.rejects(lifecycle.enable(INSTANCE_ID, 2));
  await assert.rejects(lifecycle.repair(INSTANCE_ID, (await instance()).lifecycleRevision));
  assert.deepEqual(
    reports.map((report) => report.phase),
    ['enable', 'repair'],
  );

  fail = false;
  await lifecycle.repair(INSTANCE_ID, (await instance()).lifecycleRevision);
  const healthy = await instance();
  assert.equal(healthy.activationState, 'enabled');
  assert.equal(healthy.lastRuntimeError, undefined);
  assert.equal(healthy.lastRuntimeErrorDetail, undefined);
});

test('a resume after a Host restart that fails is reported and recorded the same way', async () => {
  let fail = false;
  const { store, lifecycle, reports, instance } = await harness({
    start: async () => {
      if (fail) throw refused('messaging.send');
    },
  });
  await lifecycle.enable(INSTANCE_ID, 2);
  await store.transaction((transaction) => {
    transaction.instances.put({ ...transaction.instances.get(INSTANCE_ID), runtimeState: 'stopped' });
  });

  fail = true;
  await lifecycle.recoverAfterRestart();
  for (let attempt = 0; attempt < 100 && (await instance()).activationState !== 'error'; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const failed = await instance();
  assert.equal(failed.activationState, 'error');
  assert.equal(failed.lastRuntimeError.code, 'UNEXPECTED_RUNTIME_FAILURE');
  assert.equal(failed.lastRuntimeErrorDetail.capability, 'messaging.send');
  assert.equal(reports.at(-1).phase, 'restart_resume');
  assert.equal(reports.at(-1).occurredAt, failed.lastRuntimeError.occurredAt);
});

test('maintenance resumes keep their own codes, drop an earlier detail, and are reported', async () => {
  let fail = false;
  const { lifecycle, reports, instance } = await harness({
    start: async () => {
      if (fail) throw refused();
    },
  });
  await lifecycle.enable(INSTANCE_ID, 2);

  fail = true;
  await assert.rejects(
    lifecycle.runWithRuntimeSuspended({
      instanceId: INSTANCE_ID,
      expectedRevision: (await instance()).lifecycleRevision,
      stopReason: 'meeting_catch_up',
      resumeFailureCode: 'CATCH_UP_RESUME_FAILED',
      operation: async () => 'caught up',
    }),
    (error) => error.code === 'CATCH_UP_RESUME_FAILED',
  );
  assert.equal((await instance()).lastRuntimeError.code, 'CATCH_UP_RESUME_FAILED');
  assert.equal((await instance()).lastRuntimeErrorDetail, undefined);
  assert.equal(reports.at(-1).phase, 'maintenance_resume');

  fail = false;
  await lifecycle.repair(INSTANCE_ID, (await instance()).lifecycleRevision);
  fail = true;
  await assert.rejects(
    lifecycle.runWithRuntimeSuspended({
      instanceId: INSTANCE_ID,
      expectedRevision: (await instance()).lifecycleRevision,
      stopReason: 'package_update',
      resumeFailureCode: 'UPDATE_RESUME_FAILED',
      operation: async () => {
        throw new Error('update failed');
      },
    }),
    (error) => error.code === 'UPDATE_ROLLBACK_RESUME_FAILED',
  );
  assert.equal((await instance()).lastRuntimeError.code, 'UPDATE_ROLLBACK_RESUME_FAILED');
  assert.equal(reports.at(-1).phase, 'maintenance_rollback_resume');
  assert.deepEqual(reports.at(-1).category, { kind: 'capability_not_granted', capability: 'thread.listMetadata' });
});

test('by default the failure goes to the Host log as one safe line', async () => {
  const logDir = await mkdtemp(join(tmpdir(), 'f202-w2-6b-log-'));
  roots.push(logDir);
  const dist = new URL('../dist/domains/plugin/', import.meta.url).href;
  const script = `
    const { createHash } = await import('node:crypto');
    const plugin = await import(${JSON.stringify(`${dist}index.js`)});
    const digest = 'sha512-' + createHash('sha512').update('w26b-log').digest('base64');
    const store = new plugin.MemoryPluginInventoryStore();
    const inventory = new plugin.HostInventoryControlPlane(store, { createInstanceId: () => 'pi_w26b_log', now: () => 1 });
    await inventory.installPackage({
      manifest: { pluginId: 'dev.example.w26b-log', version: '0.1.0', contractVersion: '0.1.0', name: 'log',
        features: [{ id: 'main', name: 'Main', resources: [], capabilities: [] }],
        runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' } },
      computedPackageDigest: digest, expectedPackageDigest: digest, packagePluginId: 'dev.example.w26b-log', effectiveGrants: [],
    });
    const lifecycle = new plugin.ExternalPluginLifecycleService({ store, supervisor: {
      start: async () => {
        const probe = new Error('start failed', { cause: new Error('request failed https://example.invalid/?token=FAKE_W26B_QUERY') });
        probe.secret = 'FAKE_W26B_PROPERTY';
        throw new AggregateError([
          new Error('Invalid password FAKE_CANARY_PASSWORD'),
          new Error('authentication failed\\n    at FAKE_CANARY_12345678901234567890'),
          probe,
        ], 'module startup rollback failed');
      },
      stop: async () => undefined,
    } });
    await lifecycle.prepare('pi_w26b_log', 1);
    await lifecycle.enable('pi_w26b_log', 2).catch(() => undefined);
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, NODE_ENV: 'test', LOG_DIR: logDir },
  });

  const written = await readFile(join(logDir, 'api.log'), 'utf8');
  assert.doesNotMatch(written, /FAKE_CANARY|FAKE_W26B/u, 'no canary anywhere on disk');
  const lines = written.split('\n').filter((line) => line.includes('plugin runtime failed to start'));
  assert.equal(lines.length, 1, 'one line per failed start');
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.module, 'plugin/lifecycle');
  assert.equal(entry.pluginId, 'dev.example.w26b-log');
  assert.equal(entry.pluginInstanceId, 'pi_w26b_log');
  assert.equal(entry.phase, 'enable');
  assert.deepEqual(entry.category, { kind: 'unclassified' });
  assert.equal(entry.error.type, 'AggregateError');
  assert.deepEqual(
    entry.error.errors.map((error) => error.type),
    ['Error', 'Error', 'Error'],
  );
  assert.ok(
    entry.error.errors.every((error) => error.at.every((location) => /:\d+:\d+$/u.test(location))),
    'each error keeps where it was thrown',
  );
});
