import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeExternalPluginProcess, readFrame, sendFrame } from './plugin-external-runtime-helpers.js';

const DELIVER_INPUT = {
  deliveryId: 'delivery-1',
  threadHandle: { kind: 'thread_handle', handle: 'thread-handle-1' },
  envelope: {
    messageId: 'message-1',
    revision: 1,
    threadId: 'thread-1',
    actor: { kind: 'plugin', id: 'inst-source' },
    audience: { kind: 'public' },
    occurredAt: '2026-08-21T01:00:00.000Z',
    payload: {
      provenance: { origin: { kind: 'plugin', instanceId: 'inst-source' }, epistemicStatus: 'inference' },
      elements: [{ elementId: 'element-1', kind: 'text', payload: { text: 'hello' } }],
    },
  },
};

function fakeConnection() {
  return {
    hello: async () => null,
    ready: async () => null,
    call: async () => null,
    renewRuntimeLease: async () => 0,
    close: async () => undefined,
  };
}

test('stdio Host call validates host.messaging.deliver and returns the exact delivery receipt', async () => {
  const { createExternalStdioBrokerTransport } = await import(
    '../dist/domains/plugin/external-runtime/stdio-broker-transport.js'
  );
  const process = new FakeExternalPluginProcess();
  const transport = createExternalStdioBrokerTransport({
    process,
    connection: fakeConnection(),
    onReady() {},
    onFatal(error) {
      throw error;
    },
  });

  const pending = transport.call('host.messaging.deliver', DELIVER_INPUT);
  const request = await readFrame(process);
  assert.equal(request.method, 'host.messaging.deliver');
  assert.deepEqual(request.params.input, DELIVER_INPUT);
  sendFrame(process, { jsonrpc: '2.0', id: request.id, result: { deliveryId: DELIVER_INPUT.deliveryId } });
  assert.deepEqual(await pending, { deliveryId: DELIVER_INPUT.deliveryId });
  transport.close();
});

test('stdio Host call preserves delivery error typing when a malformed receipt fatals the transport', async () => {
  const { createExternalStdioBrokerTransport } = await import(
    '../dist/domains/plugin/external-runtime/stdio-broker-transport.js'
  );
  const process = new FakeExternalPluginProcess();
  let fatal;
  const transport = createExternalStdioBrokerTransport({
    process,
    connection: fakeConnection(),
    onReady() {},
    onFatal(error) {
      fatal = error;
    },
  });

  const pending = transport.call('host.messaging.deliver', DELIVER_INPUT);
  const request = await readFrame(process);
  sendFrame(process, { jsonrpc: '2.0', id: request.id, result: { deliveryId: 'delivery-other' } });
  await assert.rejects(
    pending,
    (error) => error?.code === 'DELIVERY_REJECTED' && error.cause?.code === 'PROTOCOL_VIOLATION',
  );
  assert.equal(fatal?.code, 'PROTOCOL_VIOLATION');
  transport.close();
});

test('stdio Host delivery reports delivery errors when the transport closes', async () => {
  const { createExternalStdioBrokerTransport } = await import(
    '../dist/domains/plugin/external-runtime/stdio-broker-transport.js'
  );
  const process = new FakeExternalPluginProcess();
  const transport = createExternalStdioBrokerTransport({
    process,
    connection: fakeConnection(),
    onReady() {},
    onFatal(error) {
      throw error;
    },
  });

  const pending = transport.call('host.messaging.deliver', DELIVER_INPUT);
  await readFrame(process);
  transport.close();

  await assert.rejects(pending, (error) => error?.code === 'DELIVERY_REJECTED');
  await assert.rejects(
    transport.call('host.messaging.deliver', DELIVER_INPUT),
    (error) => error?.code === 'DELIVERY_REJECTED',
  );
});
