import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { validateEventsPublishInput, validateEventsPublishResult } from '@clowder-ai/plugin-contract';
import { MAX_NDJSON_FRAME_BYTES } from '@clowder-ai/plugin-contract/conformance';
import { ExternalPluginRuntimeSupervisor } from '../dist/domains/plugin/external-runtime/index.js';
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
