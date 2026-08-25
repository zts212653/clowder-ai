import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { validateEventsPublishInput, validateEventsPublishResult } from '@clowder-ai/plugin-contract';
import { MAX_NDJSON_FRAME_BYTES } from '@clowder-ai/plugin-contract/conformance';
import { ExternalPluginRuntimeSupervisor } from '../dist/domains/plugin/external-runtime/index.js';
import { MemoryHostBrokerStore } from '../dist/domains/plugin/host-broker/index.js';
import {
  completeExternalHandshake,
  createExternalRuntimeHarness,
  EXTERNAL_INSTANCE_ID,
  externalCandidate,
  externalManifest,
  externalPublishInput,
  FakePluginProcessAdapter,
  readFrame,
  sendFrame,
  wireRequest,
} from './plugin-external-runtime-helpers.js';

function eventsHandler(dispatches) {
  return {
    method: 'events.publish',
    validateInput(value) {
      const validation = validateEventsPublishInput(value);
      return validation.valid ? { valid: true, value: validation.value } : { valid: false };
    },
    validateResult(value) {
      return validateEventsPublishResult(value).valid;
    },
    settlementKey(_context, input) {
      return `${input.signalType}:${input.idempotencyKey}`;
    },
    async dispatch(_context, input) {
      dispatches.push(structuredClone(input));
      return { publicationId: 'publication-1', disposition: 'accepted' };
    },
    async lookupSettlement() {
      return null;
    },
    serializePreEffectError() {
      return null;
    },
    restoreSettledError(error) {
      return new Error(error.message);
    },
  };
}

async function runningHarness() {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-stdio-'));
  const dispatches = [];
  const harness = await createExternalRuntimeHarness({ rootDir, methods: [eventsHandler(dispatches)] });
  const processes = new FakePluginProcessAdapter();
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: harness.inventory,
    broker: harness.broker,
    packages: {
      async resolveInstalledPackage() {
        return {
          rootDir,
          manifest: externalManifest(),
          verifyIntegrity: async () => undefined,
          release: async () => undefined,
        };
      },
    },
    processes,
  });
  const starting = supervisor.start(EXTERNAL_INSTANCE_ID);
  const child = await processes.nextProcess();
  const handshake = await completeExternalHandshake(child);
  const handle = await starting;
  return { ...harness, child, dispatches, handle, processes, supervisor, handshake };
}

test('stdio hello/ready and events.publish use the existing Broker session and ledger', async () => {
  const harness = await runningHarness();
  assert.equal(harness.handshake.hello.result.pluginInstanceId, EXTERNAL_INSTANCE_ID);
  assert.equal(harness.handshake.ready.result, null);

  sendFrame(harness.child, wireRequest('publish-1', 'events.publish', externalPublishInput()));
  assert.deepEqual(await readFrame(harness.child), {
    jsonrpc: '2.0',
    id: 'publish-1',
    result: { publicationId: 'publication-1', disposition: 'accepted' },
  });
  assert.equal(harness.dispatches.length, 1);

  const snapshot = await harness.brokerStore.snapshot();
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].transportKind, 'stdio');
  assert.equal(snapshot.sessions[0].phase, 'active');
  assert.equal(snapshot.calls[0].phase, 'settled_success');
  await harness.supervisor.stop(EXTERNAL_INSTANCE_ID);
});

test('reserved rows receive the contract classifier response and never dispatch', async () => {
  const harness = await runningHarness();
  sendFrame(harness.child, wireRequest('reserved-1', 'messaging.send', {}));
  const response = await readFrame(harness.child);
  assert.equal(response.id, 'reserved-1');
  assert.equal(response.error.code, -32602);
  assert.equal(harness.dispatches.length, 0);
  assert.equal(harness.child.terminateCalls, 0);
  await harness.supervisor.stop(EXTERNAL_INSTANCE_ID);
});

test('non-canonical and oversized frames close authority with zero business dispatch', async (t) => {
  await t.test('non-canonical', async () => {
    const harness = await runningHarness();
    harness.child.stdout.write(
      '{ "jsonrpc":"2.0","id":"publish-1","method":"events.publish","params":{"meta":{"deadlineUnixMs":1},"input":{}}}\n',
    );
    await harness.child.exited;
    assert.equal(harness.child.terminateCalls, 1);
    assert.equal(harness.dispatches.length, 0);
    const snapshot = await harness.brokerStore.snapshot();
    assert.equal(snapshot.sessions[0].phase, 'closed');
  });

  await t.test('oversized', async () => {
    const harness = await runningHarness();
    harness.child.stdout.write(Buffer.alloc(MAX_NDJSON_FRAME_BYTES + 2, 0x61));
    harness.child.stdout.write('\n');
    await harness.child.exited;
    assert.equal(harness.child.terminateCalls, 1);
    assert.equal(harness.dispatches.length, 0);
  });
});

test('unexpected child exit closes the Broker session and marks runtime crashed', async () => {
  const harness = await runningHarness();
  harness.child.exit({
    code: 17,
    signal: null,
    diagnostic: { code: 'EVENT_BUS_CONFLICT' },
  });
  await harness.handle.closed;

  const broker = await harness.brokerStore.snapshot();
  assert.equal(broker.sessions[0].phase, 'closed');
  assert.equal(broker.sessions[0].closeReason, 'process_exit');
  const inventory = await harness.inventory.snapshot();
  assert.equal(inventory.instances[0].activationState, 'error');
  assert.equal(inventory.instances[0].runtimeState, 'crashed');
  assert.equal(inventory.instances[0].lifecycleRevision, 2);
  assert.deepEqual(inventory.instances[0].lastRuntimeError, {
    code: 'EVENT_BUS_CONFLICT',
    exitCode: 17,
    signal: null,
    occurredAt: inventory.instances[0].updatedAt,
  });
});

test('Windows process exit codes remain durable when the runtime crashes', async () => {
  const harness = await runningHarness();
  harness.child.exit({ code: 0xc0000005, signal: null });
  await harness.handle.closed;

  const inventory = await harness.inventory.snapshot();
  assert.equal(inventory.instances[0].activationState, 'error');
  assert.equal(inventory.instances[0].runtimeState, 'crashed');
  assert.deepEqual(inventory.instances[0].lastRuntimeError, {
    code: 'UNEXPECTED_RUNTIME_FAILURE',
    exitCode: 0xc0000005,
    signal: null,
    occurredAt: inventory.instances[0].updatedAt,
  });
});

test('typed exit before broker.ready fails startup immediately and retains the safe diagnostic', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-pre-ready-exit-'));
  const harness = await createExternalRuntimeHarness({ rootDir });
  const processes = new FakePluginProcessAdapter();
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: harness.inventory,
    broker: harness.broker,
    packages: {
      async resolveInstalledPackage() {
        return {
          rootDir,
          manifest: externalManifest(),
          verifyIntegrity: async () => undefined,
          release: async () => undefined,
        };
      },
    },
    processes,
    handshakeTimeoutMs: 5_000,
  });
  const starting = supervisor.start(EXTERNAL_INSTANCE_ID);
  const child = await processes.nextProcess();
  sendFrame(child, wireRequest('hello-pre-ready', 'broker.hello', externalCandidate()));
  await readFrame(child);
  child.exit({ code: 17, signal: null, diagnostic: { code: 'EVENT_BUS_CONFLICT' } });

  await assert.rejects(starting, (error) => error?.code === 'PROCESS_EXITED');
  const inventory = await harness.inventory.snapshot();
  assert.equal(inventory.instances[0].runtimeState, 'crashed');
  assert.equal(inventory.instances[0].lastRuntimeError.code, 'EVENT_BUS_CONFLICT');
  assert.equal(inventory.instances[0].lastRuntimeError.exitCode, 17);
});

test('authority revocation closes transport on the next call with zero new effect', async () => {
  const harness = await runningHarness();
  await harness.inventory.transaction((transaction) => {
    const grants = transaction.grants.get(EXTERNAL_INSTANCE_ID);
    transaction.grants.put({ ...grants, effectiveGrants: [], grantRevision: grants.grantRevision + 1 });
  });
  sendFrame(harness.child, wireRequest('publish-revoked', 'events.publish', externalPublishInput()));
  const response = await readFrame(harness.child);
  assert.equal(response.error.code, -32603);
  await harness.child.exited;
  assert.equal(harness.child.terminateCalls, 1);
  assert.equal(harness.dispatches.length, 0);
  const broker = await harness.brokerStore.snapshot();
  assert.equal(broker.sessions[0].phase, 'closed');
});

test('Host pings the active child and renews the exact runtime lease before idle expiry', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-heartbeat-'));
  const dispatches = [];
  const harness = await createExternalRuntimeHarness({
    rootDir,
    methods: [eventsHandler(dispatches)],
    activeLeaseTtlMs: 120,
  });
  const processes = new FakePluginProcessAdapter();
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: harness.inventory,
    broker: harness.broker,
    packages: {
      async resolveInstalledPackage() {
        return {
          rootDir,
          manifest: externalManifest(),
          verifyIntegrity: async () => undefined,
          release: async () => undefined,
        };
      },
    },
    processes,
    heartbeatIntervalMs: 20,
    heartbeatTimeoutMs: 40,
  });
  const starting = supervisor.start(EXTERNAL_INSTANCE_ID);
  const child = await processes.nextProcess();
  await completeExternalHandshake(child);
  const handle = await starting;
  const initialExpiry = (await harness.brokerStore.snapshot()).runtimeLeases[0].expiresAt;

  const ping = await readFrame(child);
  assert.equal(ping.method, 'host.lifecycle.ping');
  assert.equal(ping.params.input.nonce, ping.id);
  sendFrame(child, { jsonrpc: '2.0', id: ping.id, result: { nonce: ping.id } });

  await new Promise((resolve) => setTimeout(resolve, 5));
  const renewed = await harness.brokerStore.snapshot();
  assert.ok(renewed.runtimeLeases[0].expiresAt > initialExpiry);
  assert.equal(renewed.sessions[0].activeLeaseExpiresAt, renewed.runtimeLeases[0].expiresAt);

  sendFrame(child, wireRequest('publish-after-idle', 'events.publish', externalPublishInput()));
  assert.deepEqual(await readFrame(child), {
    jsonrpc: '2.0',
    id: 'publish-after-idle',
    result: { publicationId: 'publication-1', disposition: 'accepted' },
  });
  assert.equal(dispatches.length, 1);
  await supervisor.stop(EXTERNAL_INSTANCE_ID);
  await handle.closed;
});

test('wall-clock lease expiry after system suspend replaces the session without revoking enabled intent', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-suspend-recovery-'));
  const dispatches = [];
  let now = 1_000;
  const harness = await createExternalRuntimeHarness({
    rootDir,
    methods: [eventsHandler(dispatches)],
    activeLeaseTtlMs: 100,
    now: () => now,
  });
  const processes = new FakePluginProcessAdapter();
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: harness.inventory,
    broker: harness.broker,
    packages: {
      async resolveInstalledPackage() {
        return {
          rootDir,
          manifest: externalManifest(),
          verifyIntegrity: async () => undefined,
          release: async () => undefined,
        };
      },
    },
    processes,
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 20,
    now: () => now,
  });
  const starting = supervisor.start(EXTERNAL_INSTANCE_ID);
  const original = await processes.waitForProcess(0);
  await completeExternalHandshake(original);
  const originalHandle = await starting;

  const ping = await readFrame(original);
  now = 1_200;
  sendFrame(original, { jsonrpc: '2.0', id: ping.id, result: { nonce: ping.id } });
  await originalHandle.closed;

  const replacement = await processes.waitForProcess(1);
  await completeExternalHandshake(replacement);
  await new Promise((resolve) => setImmediate(resolve));

  const broker = await harness.brokerStore.snapshot();
  assert.equal(broker.sessions.length, 2);
  assert.equal(broker.sessions[0].phase, 'closed');
  assert.equal(broker.sessions[0].closeReason, 'runtime_lease_expired');
  assert.equal(broker.sessions[1].phase, 'active');
  assert.notEqual(broker.sessions[0].runtimeLeaseId, broker.sessions[1].runtimeLeaseId);
  assert.equal(original.terminateCalls, 1);
  const inventory = await harness.inventory.snapshot();
  assert.equal(inventory.instances[0].activationState, 'enabled');
  assert.equal(inventory.instances[0].runtimeState, 'healthy');

  sendFrame(replacement, wireRequest('publish-after-resume', 'events.publish', externalPublishInput()));
  assert.equal((await readFrame(replacement)).result.disposition, 'accepted');
  assert.equal(dispatches.length, 1);
  await supervisor.stop(EXTERNAL_INSTANCE_ID);
});

test('late lease-expiry close during heartbeat renewal creates exactly one replacement', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-late-renewal-close-'));
  const delegate = new MemoryHostBrokerStore();
  let beforeTransaction;
  const brokerStore = {
    snapshot: () => delegate.snapshot(),
    transaction: async (work) => {
      const hook = beforeTransaction;
      beforeTransaction = undefined;
      if (hook) await hook();
      return delegate.transaction(work);
    },
  };
  const harness = await createExternalRuntimeHarness({ rootDir, activeLeaseTtlMs: 100, brokerStore });
  const processes = new FakePluginProcessAdapter();
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: harness.inventory,
    broker: harness.broker,
    packages: {
      async resolveInstalledPackage() {
        return {
          rootDir,
          manifest: externalManifest(),
          verifyIntegrity: async () => undefined,
          release: async () => undefined,
        };
      },
    },
    processes,
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 20,
  });
  const starting = supervisor.start(EXTERNAL_INSTANCE_ID);
  const original = await processes.waitForProcess(0);
  await completeExternalHandshake(original);
  const originalHandle = await starting;

  const ping = await readFrame(original);
  beforeTransaction = async () => {
    const session = (await delegate.snapshot()).sessions[0];
    await harness.broker.close(session.connectionId, 'runtime_lease_expired');
  };
  sendFrame(original, { jsonrpc: '2.0', id: ping.id, result: { nonce: ping.id } });
  await originalHandle.closed;

  const replacement = await processes.waitForProcess(1);
  await completeExternalHandshake(replacement);
  await new Promise((resolve) => setImmediate(resolve));

  const broker = await delegate.snapshot();
  assert.equal(broker.sessions.length, 2);
  assert.equal(broker.sessions[0].closeReason, 'runtime_lease_expired');
  assert.equal(broker.sessions[1].phase, 'active');
  assert.equal(processes.processes.length, 2);
  const inventory = await harness.inventory.snapshot();
  assert.equal(inventory.instances[0].activationState, 'enabled');
  assert.equal(inventory.instances[0].runtimeState, 'healthy');
  await supervisor.stop(EXTERNAL_INSTANCE_ID);
});

test('wall-clock lease expiry during an unanswered ping timeout replaces the session after resume', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-suspend-ping-timeout-recovery-'));
  let now = 1_000;
  const harness = await createExternalRuntimeHarness({ rootDir, activeLeaseTtlMs: 100, now: () => now });
  const processes = new FakePluginProcessAdapter();
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: harness.inventory,
    broker: harness.broker,
    packages: {
      async resolveInstalledPackage() {
        return {
          rootDir,
          manifest: externalManifest(),
          verifyIntegrity: async () => undefined,
          release: async () => undefined,
        };
      },
    },
    processes,
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 20,
    now: () => now,
  });
  const starting = supervisor.start(EXTERNAL_INSTANCE_ID);
  const original = await processes.waitForProcess(0);
  await completeExternalHandshake(original);
  const originalHandle = await starting;

  const ping = await readFrame(original);
  assert.equal(ping.method, 'host.lifecycle.ping');
  now = 1_200;
  await originalHandle.closed;

  let broker = await harness.brokerStore.snapshot();
  assert.equal(broker.sessions[0].phase, 'closed');
  assert.equal(broker.sessions[0].closeReason, 'runtime_lease_expired');

  const replacement = await processes.waitForProcess(1);
  await completeExternalHandshake(replacement);
  await new Promise((resolve) => setImmediate(resolve));

  broker = await harness.brokerStore.snapshot();
  assert.equal(broker.sessions.length, 2);
  assert.equal(broker.sessions[1].phase, 'active');
  assert.notEqual(broker.sessions[0].runtimeLeaseId, broker.sessions[1].runtimeLeaseId);
  const inventory = await harness.inventory.snapshot();
  assert.equal(inventory.instances[0].activationState, 'enabled');
  assert.equal(inventory.instances[0].runtimeState, 'healthy');
  await supervisor.stop(EXTERNAL_INSTANCE_ID);
});

test('Host shutdown during replacement handshake preserves enabled intent for the next boot', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-suspend-replacement-shutdown-'));
  let now = 1_000;
  const harness = await createExternalRuntimeHarness({ rootDir, activeLeaseTtlMs: 100, now: () => now });
  const processes = new FakePluginProcessAdapter();
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: harness.inventory,
    broker: harness.broker,
    packages: {
      async resolveInstalledPackage() {
        return {
          rootDir,
          manifest: externalManifest(),
          verifyIntegrity: async () => undefined,
          release: async () => undefined,
        };
      },
    },
    processes,
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 20,
    now: () => now,
  });
  const starting = supervisor.start(EXTERNAL_INSTANCE_ID);
  const original = await processes.waitForProcess(0);
  await completeExternalHandshake(original);
  const originalHandle = await starting;
  const initialRevision = (await harness.inventory.snapshot()).instances[0].lifecycleRevision;

  const ping = await readFrame(original);
  assert.equal(ping.method, 'host.lifecycle.ping');
  now = 1_200;
  await originalHandle.closed;

  const replacement = await processes.waitForProcess(1);
  sendFrame(replacement, wireRequest('hello-replacement', 'broker.hello', externalCandidate()));
  const hello = await readFrame(replacement);
  assert.equal(hello.result.pluginInstanceId, EXTERNAL_INSTANCE_ID);

  await supervisor.stopAll();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const broker = await harness.brokerStore.snapshot();
  assert.equal(broker.sessions.length, 2);
  assert.equal(broker.sessions[1].phase, 'closed');
  assert.equal(broker.sessions[1].closeReason, 'host_shutdown');
  assert.equal(processes.processes.length, 2);
  assert.equal(replacement.terminateCalls, 1);
  const inventory = await harness.inventory.snapshot();
  assert.equal(inventory.instances[0].activationState, 'enabled');
  assert.equal(inventory.instances[0].runtimeState, 'stopped');
  assert.equal(inventory.instances[0].lifecycleRevision, initialRevision);
});

test('failed replacement after lease expiry projects an owner-visible error instead of false recovery', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-suspend-recovery-failure-'));
  let now = 1_000;
  let resolutions = 0;
  const harness = await createExternalRuntimeHarness({ rootDir, activeLeaseTtlMs: 100, now: () => now });
  const processes = new FakePluginProcessAdapter();
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: harness.inventory,
    broker: harness.broker,
    packages: {
      async resolveInstalledPackage() {
        resolutions += 1;
        if (resolutions > 1) throw new Error('replacement package unavailable');
        return {
          rootDir,
          manifest: externalManifest(),
          verifyIntegrity: async () => undefined,
          release: async () => undefined,
        };
      },
    },
    processes,
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 20,
    now: () => now,
  });
  const starting = supervisor.start(EXTERNAL_INSTANCE_ID);
  const original = await processes.waitForProcess(0);
  await completeExternalHandshake(original);
  const originalHandle = await starting;

  const ping = await readFrame(original);
  now = 1_200;
  sendFrame(original, { jsonrpc: '2.0', id: ping.id, result: { nonce: ping.id } });
  await originalHandle.closed;

  const deadline = Date.now() + 1_000;
  let failed;
  do {
    failed = (await harness.inventory.snapshot()).instances[0];
    if (failed.activationState === 'error') break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  } while (Date.now() < deadline);
  assert.equal(failed.activationState, 'error');
  assert.equal(failed.runtimeState, 'stopped');
  assert.equal(processes.processes.length, 1);
  const broker = await harness.brokerStore.snapshot();
  assert.equal(broker.sessions.length, 1);
  assert.equal(broker.sessions[0].closeReason, 'runtime_lease_expired');
});

test('missing Host ping response crashes and closes a runtime instead of projecting false healthy', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-heartbeat-timeout-'));
  const harness = await createExternalRuntimeHarness({ rootDir, activeLeaseTtlMs: 100 });
  const processes = new FakePluginProcessAdapter();
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: harness.inventory,
    broker: harness.broker,
    packages: {
      async resolveInstalledPackage() {
        return {
          rootDir,
          manifest: externalManifest(),
          verifyIntegrity: async () => undefined,
          release: async () => undefined,
        };
      },
    },
    processes,
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 10,
  });
  const starting = supervisor.start(EXTERNAL_INSTANCE_ID);
  const child = await processes.nextProcess();
  await completeExternalHandshake(child);
  const handle = await starting;

  const ping = await readFrame(child);
  assert.equal(ping.method, 'host.lifecycle.ping');
  await handle.closed;

  assert.equal(child.terminateCalls, 1);
  const broker = await harness.brokerStore.snapshot();
  assert.equal(broker.sessions[0].phase, 'closed');
  assert.equal(broker.sessions[0].closeReason, 'heartbeat_failure');
  const inventory = await harness.inventory.snapshot();
  assert.equal(inventory.instances[0].activationState, 'error');
  assert.equal(inventory.instances[0].runtimeState, 'crashed');
});

test('missing Host ping response after authority revocation never restarts the runtime', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-heartbeat-authority-change-'));
  const harness = await createExternalRuntimeHarness({ rootDir, activeLeaseTtlMs: 100 });
  const processes = new FakePluginProcessAdapter();
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: harness.inventory,
    broker: harness.broker,
    packages: {
      async resolveInstalledPackage() {
        return {
          rootDir,
          manifest: externalManifest(),
          verifyIntegrity: async () => undefined,
          release: async () => undefined,
        };
      },
    },
    processes,
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 10,
  });
  const starting = supervisor.start(EXTERNAL_INSTANCE_ID);
  const child = await processes.nextProcess();
  await completeExternalHandshake(child);
  const handle = await starting;

  const ping = await readFrame(child);
  assert.equal(ping.method, 'host.lifecycle.ping');
  await harness.inventory.transaction((transaction) => {
    const grants = transaction.grants.get(EXTERNAL_INSTANCE_ID);
    transaction.grants.put({ ...grants, effectiveGrants: [], grantRevision: grants.grantRevision + 1 });
  });
  await handle.closed;

  const broker = await harness.brokerStore.snapshot();
  assert.equal(broker.sessions[0].phase, 'closed');
  assert.equal(broker.sessions[0].closeReason, 'authority_changed');
  assert.equal(processes.processes.length, 1);
  const inventory = await harness.inventory.snapshot();
  assert.equal(inventory.instances[0].activationState, 'error');
  assert.equal(inventory.instances[0].runtimeState, 'crashed');
});
