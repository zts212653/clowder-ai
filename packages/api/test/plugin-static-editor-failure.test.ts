import assert from 'node:assert/strict';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { ContentEditorPluginRuntime } from '../src/domains/plugin/content-editor-runtime/runtime.js';
import { FilesystemVerifiedPluginPackageLocator } from '../src/domains/plugin/external-runtime/filesystem-package-locator.js';
import { HostBrokerControlPlane } from '../src/domains/plugin/host-broker/control-plane.js';
import { MemoryHostBrokerStore } from '../src/domains/plugin/host-broker/stores.js';
import { HostBrokerError } from '../src/domains/plugin/host-broker/types.js';
import { staticEditorFixture, staticEditorManifest } from './plugin-static-editor.fixture.js';

async function heartbeatFixture(t: TestContext, stage: 'package-verification' | 'lease-renew', observerThrows = false) {
  const f = await staticEditorFixture(staticEditorManifest());
  const installed = await f.install();
  const id = installed.pluginInstanceId;
  await f.store.transaction(async (tx) => {
    const instance = await tx.instances.get(id);
    assert.ok(instance);
    await tx.instances.put({
      ...instance,
      activationState: 'enabled',
      configReadiness: 'ready',
      runtimeState: 'healthy',
      lifecycleRevision: 2,
    });
  });
  const store = new MemoryHostBrokerStore();
  let now = 1_000;
  const broker = new HostBrokerControlPlane({ inventory: f.store, store, now: () => now });
  const locator = new FilesystemVerifiedPluginPackageLocator(join(f.root, 'cache'));
  let armed = false;
  let verificationGate: Promise<void> | undefined;
  let entered!: () => void;
  const verificationEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const secret = 'fixture-private-document-token';
  const fault =
    stage === 'lease-renew'
      ? new HostBrokerError('AUTHORITY_CHANGED', secret, undefined, 'runtime_lease_expired')
      : Object.assign(new Error(secret), { code: 'EIO' });
  const packages = {
    resolveInstalledPackage: async (digest: string) => {
      const pkg = await locator.resolveInstalledPackage(digest);
      const verifyStaticIntegrity = pkg.verifyStaticIntegrity?.bind(pkg);
      const verify = async (work: () => Promise<void>) => {
        if (armed && stage === 'package-verification') {
          entered();
          await verificationGate;
          throw fault;
        }
        await work();
      };
      return {
        ...pkg,
        verifyIntegrity: () => verify(() => pkg.verifyIntegrity()),
        ...(verifyStaticIntegrity ? { verifyStaticIntegrity: () => verify(verifyStaticIntegrity) } : {}),
      };
    },
  };
  const renew = broker.renewRuntimeLease.bind(broker);
  t.mock.method(broker, 'renewRuntimeLease', async (connectionId: string) => {
    if (armed && stage === 'lease-renew') throw fault;
    return renew(connectionId);
  });
  const reports: unknown[] = [];
  const runtime = new ContentEditorPluginRuntime({
    inventory: f.store,
    brokerStore: store,
    broker,
    packages,
    parentOrigin: 'http://localhost:4179',
    now: () => now,
    onFailure: (report: unknown) => {
      reports.push(report);
      if (observerThrows) throw new Error('diagnostic observer failure');
    },
  });
  t.after(async () => {
    await runtime.stop(id, 'test_cleanup');
    await f.cleanup();
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await runtime.start(id);
  const handle = await runtime.resolve(id, 'docx');
  assert.ok(handle);
  return {
    f,
    id,
    store,
    broker,
    runtime,
    reports,
    secret,
    handle,
    verificationEntered,
    arm: () => {
      armed = true;
    },
    setTime: (value: number) => {
      now = value;
    },
    holdVerification: () => {
      let release!: () => void;
      verificationGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    disarm: () => {
      armed = false;
    },
  };
}

async function waitForCrash(f: Awaited<ReturnType<typeof heartbeatFixture>>) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const instance = (await f.f.store.snapshot()).instances.find((x) => x.pluginInstanceId === f.id);
    if (instance?.runtimeState === 'crashed') return instance;
    await turn();
  }
  assert.fail('the failed heartbeat must revoke the editor and persist the crashed state');
}

for (const stage of ['package-verification', 'lease-renew'] as const) {
  test(`static editor ${stage} failure retains one safe diagnostic and its occurrence`, async (t) => {
    const f = await heartbeatFixture(t, stage);
    f.arm();
    t.mock.timers.tick(10_000);
    const instance = await waitForCrash(f);
    assert.equal(instance.lastRuntimeError?.code, 'UNEXPECTED_RUNTIME_FAILURE');
    assert.equal(instance.lastRuntimeError?.occurredAt, 1_000);
    assert.equal(f.reports.length, 1, 'asynchronous editor failure must reach the Host observer');
    const report = f.reports[0] as {
      pluginInstanceId: string;
      lifecycleRevision: number;
      occurredAt: number;
      phase: string;
      failedStage: string;
      stages: { stage: string; status: string; elapsedMs: number }[];
      error: { origin: string; code?: string };
    };
    assert.equal(report.pluginInstanceId, f.id);
    assert.equal(report.lifecycleRevision, 2);
    assert.equal(report.occurredAt, instance.lastRuntimeError?.occurredAt);
    assert.equal(report.phase, 'heartbeat');
    assert.equal(report.failedStage, stage);
    assert.equal(report.stages.at(-1)?.status, 'failed');
    assert.ok(report.stages.every((x) => Number.isFinite(x.elapsedMs) && x.elapsedMs >= 0));
    assert.equal(report.error.code, stage === 'lease-renew' ? 'AUTHORITY_CHANGED' : 'EIO');
    assert.equal(report.error.origin, stage === 'lease-renew' ? 'host' : 'unverified');
    assert.ok(!JSON.stringify(f.reports).includes(f.secret), 'no raw exception message or stack text');
    assert.equal(await f.runtime.resolve(f.id, 'docx'), undefined);
    await assert.rejects(f.runtime.features.run(f.handle.executionLease, async () => assert.fail('stale edit')));
    assert.ok((await f.store.snapshot()).sessions.every((x) => x.phase === 'closed'));
    t.mock.timers.tick(60_000);
    await turn();
    assert.equal(f.reports.length, 1, 'a terminal failure cannot start another heartbeat');
  });
}

test('diagnostic observer failure cannot prevent editor revocation or the durable error', async (t) => {
  const f = await heartbeatFixture(t, 'package-verification', true);
  f.arm();
  t.mock.timers.tick(10_000);
  const instance = await waitForCrash(f);
  assert.equal(instance.lastRuntimeError?.code, 'UNEXPECTED_RUNTIME_FAILURE');
  assert.equal(f.reports.length, 1);
  assert.equal(await f.runtime.resolve(f.id, 'docx'), undefined);
});

test('an overdue heartbeat reports timer delay separately from a real expired Broker lease', async (t) => {
  const f = await heartbeatFixture(t, 'lease-renew');
  // No injected exception: the actual Broker rejects renewal after its authority expires.
  f.setTime(71_000);
  t.mock.timers.tick(10_000);
  const instance = await waitForCrash(f);
  const report = f.reports[0] as {
    timerLagMs: number;
    failedStage: string;
    occurredAt: number;
    error: { code: string };
  };
  assert.equal(report.timerLagMs, 60_000);
  assert.equal(report.failedStage, 'lease-renew');
  assert.equal(report.error.code, 'SESSION_NOT_ACTIVE');
  assert.equal(report.occurredAt, 71_000);
  assert.equal(instance.lastRuntimeError?.occurredAt, report.occurredAt);
});

test('a failed heartbeat released after stop cannot diagnose or crash the replacement generation', async (t) => {
  const f = await heartbeatFixture(t, 'package-verification');
  const release = f.holdVerification();
  t.after(release);
  f.arm();
  t.mock.timers.tick(10_000);
  await f.verificationEntered;
  await f.runtime.stop(f.id, 'test_replace');
  f.disarm();
  await f.f.store.transaction(async (tx) => {
    const instance = await tx.instances.get(f.id);
    assert.ok(instance);
    await tx.instances.put({ ...instance, lifecycleRevision: 3, runtimeState: 'healthy' });
  });
  await f.runtime.start(f.id);
  release();
  await turn();
  const current = (await f.f.store.snapshot()).instances.find((x) => x.pluginInstanceId === f.id);
  assert.equal(current?.lifecycleRevision, 3);
  assert.equal(current?.runtimeState, 'healthy');
  assert.equal(current?.lastRuntimeError, undefined);
  assert.equal(f.reports.length, 0);
  assert.ok(await f.runtime.resolve(f.id, 'docx'));
});

test('an intentional stop in progress is not diagnosed as a runtime loss', async (t) => {
  const f = await heartbeatFixture(t, 'package-verification');
  const releaseVerification = f.holdVerification();
  t.after(releaseVerification);
  f.arm();
  t.mock.timers.tick(10_000);
  await f.verificationEntered;
  let releaseClose!: () => void;
  let closing!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    closing = resolve;
  });
  const close = f.broker.close.bind(f.broker);
  t.mock.method(f.broker, 'close', async (connectionId: string, reason?: string) => {
    closing();
    await held;
    return close(connectionId, reason);
  });
  const stop = f.runtime.stop(f.id, 'owner_disable');
  try {
    await entered;
    releaseVerification();
    await turn();
    assert.equal(f.reports.length, 0, 'owner stop already owns this teardown');
  } finally {
    releaseClose();
    await stop;
  }
});
