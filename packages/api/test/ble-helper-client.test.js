import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { BleHelperClient } from '../dist/domains/limb/ble/BleHelperClient.js';

class FakeStream extends EventEmitter {}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  killed = false;
  writes = [];

  stdin = {
    write: (line, callback) => {
      this.writes.push(line);
      this.onWrite?.(JSON.parse(line));
      callback?.();
      return true;
    },
  };

  send(message) {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`));
  }

  sendHello(version = 1) {
    this.send({ protocol: 'ble-helper', version, kind: 'hello' });
  }

  sendAdapterState(state = 'poweredOn') {
    this.send({ protocol: 'ble-helper', version: 1, kind: 'event', event: 'adapter.state', data: { state } });
  }

  crash(code = 1) {
    this.emit('exit', code, null);
  }

  kill() {
    this.killed = true;
    return true;
  }
}

function respondingProcess() {
  const process = new FakeProcess();
  process.onWrite = (request) => {
    queueMicrotask(() =>
      process.send({
        protocol: 'ble-helper',
        version: 1,
        kind: 'response',
        requestId: request.requestId,
        ok: true,
        data: { accepted: request.command },
      }),
    );
  };
  queueMicrotask(() => {
    process.sendHello();
    process.sendAdapterState();
  });
  return process;
}

describe('BleHelperClient', () => {
  it('spawns lazily and correlates responses', async () => {
    let spawnCount = 0;
    const process = respondingProcess();
    const client = new BleHelperClient({
      platform: 'darwin',
      spawnProcess: () => {
        spawnCount += 1;
        return process;
      },
    });

    assert.equal(client.status.state, 'idle');
    assert.equal(spawnCount, 0);
    const result = await client.request('scan.start', { sessionId: 'scan-1', timeoutMs: 30_000 });
    assert.deepEqual(result, { accepted: 'scan.start' });
    assert.equal(spawnCount, 1);
    assert.equal(client.status.state, 'ready');
  });

  it('waits for CoreBluetooth poweredOn before sending the first operational request', async () => {
    const process = new FakeProcess();
    process.onWrite = (request) => {
      queueMicrotask(() =>
        process.send({
          protocol: 'ble-helper',
          version: 1,
          kind: 'response',
          requestId: request.requestId,
          ok: true,
          data: { accepted: request.command },
        }),
      );
    };
    queueMicrotask(() => process.sendHello());
    const client = new BleHelperClient({ platform: 'darwin', spawnProcess: () => process });

    const request = client.request('scan.start', { sessionId: 'scan-powered-on', timeoutMs: 30_000 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(process.writes.length, 0);
    process.sendAdapterState('resetting');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(process.writes.length, 0);
    process.sendAdapterState('poweredOn');

    assert.deepEqual(await request, { accepted: 'scan.start' });
    assert.equal(process.writes.length, 1);
  });

  it('fails an operational request without writing when Bluetooth is powered off', async () => {
    const process = new FakeProcess();
    queueMicrotask(() => {
      process.sendHello();
      process.sendAdapterState('poweredOff');
    });
    const client = new BleHelperClient({ platform: 'darwin', spawnProcess: () => process });

    await assert.rejects(
      client.request('scan.start', { sessionId: 'scan-powered-off', timeoutMs: 30_000 }),
      /not powered on: poweredOff/,
    );
    assert.equal(process.writes.length, 0);
  });

  it('rejects an unknown handshake version without retrying', async () => {
    let spawnCount = 0;
    const process = new FakeProcess();
    const client = new BleHelperClient({
      platform: 'darwin',
      spawnProcess: () => {
        spawnCount += 1;
        queueMicrotask(() => process.sendHello(2));
        return process;
      },
      sleep: async () => {},
    });

    await assert.rejects(client.start(), /Unsupported BLE helper protocol version/);
    assert.equal(spawnCount, 1);
    assert.equal(process.killed, true);
    assert.equal(client.status.state, 'degraded');
  });

  it('recovers from a crash after 1 second and keeps the API caller alive', async () => {
    const firstProcess = respondingProcess();
    let spawnCount = 0;
    const delays = [];
    const client = new BleHelperClient({
      platform: 'darwin',
      spawnProcess: () => {
        spawnCount += 1;
        return spawnCount === 1 ? firstProcess : respondingProcess();
      },
      sleep: async (ms) => delays.push(ms),
    });

    await client.start();
    const first = client.currentProcessForTest;
    first.crash();
    const result = await client.request('scan.start', { sessionId: 'scan-2', timeoutMs: 30_000 });

    assert.deepEqual(result, { accepted: 'scan.start' });
    assert.deepEqual(delays, [1_000]);
    assert.equal(client.status.state, 'ready');
  });

  it('marks the capability degraded after three failed restart attempts', async () => {
    const first = respondingProcess();
    let spawnCount = 0;
    const delays = [];
    const client = new BleHelperClient({
      platform: 'darwin',
      spawnProcess: () => {
        spawnCount += 1;
        if (spawnCount === 1) return first;
        const failed = new FakeProcess();
        queueMicrotask(() => failed.crash());
        return failed;
      },
      sleep: async (ms) => delays.push(ms),
      handshakeTimeoutMs: 20,
    });

    await client.start();
    first.crash();
    await assert.rejects(client.start(), /unavailable/);
    assert.equal(spawnCount, 4);
    assert.deepEqual(delays, [1_000, 2_000, 4_000]);
    assert.equal(client.status.state, 'degraded');
  });

  it('does not restart after shutdown interrupts a recovery backoff', async () => {
    const first = respondingProcess();
    let spawnCount = 0;
    let releaseSleep;
    const client = new BleHelperClient({
      platform: 'darwin',
      spawnProcess: () => {
        spawnCount += 1;
        return spawnCount === 1 ? first : respondingProcess();
      },
      sleep: () =>
        new Promise((resolve) => {
          releaseSleep = resolve;
        }),
    });

    await client.start();
    first.crash();
    assert.equal(typeof releaseSleep, 'function');

    await client.shutdown();
    releaseSleep();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(spawnCount, 1);
    assert.equal(client.status.state, 'idle');
  });

  it('times out a request without exiting the process', async () => {
    const process = new FakeProcess();
    queueMicrotask(() => {
      process.sendHello();
      process.sendAdapterState();
    });
    let fireRequestTimeout;
    let unrefCalled = false;
    const requestTimer = {
      unref: () => {
        unrefCalled = true;
      },
    };
    const client = new BleHelperClient({
      platform: 'darwin',
      spawnProcess: () => process,
      requestTimeoutMs: 5,
      setRequestTimer: (callback, ms) => {
        assert.equal(ms, 5);
        fireRequestTimeout = callback;
        return requestTimer;
      },
    });

    await client.start();
    const request = client.request('scan.start', { sessionId: 'scan-timeout', timeoutMs: 30_000 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof fireRequestTimeout, 'function');
    assert.equal(unrefCalled, true);
    fireRequestTimeout();

    await assert.rejects(request, /timed out/);
    assert.equal(client.status.state, 'ready');
  });

  it('ignores malformed runtime messages and accepts the next valid response', async () => {
    const warnings = [];
    const process = new FakeProcess();
    process.onWrite = (request) => {
      queueMicrotask(() => {
        process.stdout.emit('data', Buffer.from('{bad-json}\n'));
        process.send({
          protocol: 'ble-helper',
          version: 1,
          kind: 'response',
          requestId: request.requestId,
          ok: true,
          data: { ok: true },
        });
      });
    };
    queueMicrotask(() => {
      process.sendHello();
      process.sendAdapterState();
    });
    const client = new BleHelperClient({
      platform: 'darwin',
      spawnProcess: () => process,
      logger: { warn: (message) => warnings.push(message), info: () => {} },
    });

    assert.deepEqual(await client.request('scan.start', { sessionId: 'scan-3', timeoutMs: 30_000 }), { ok: true });
    assert.equal(warnings.length, 1);
    assert.equal(client.status.state, 'ready');
  });

  it('preserves UTF-8 event data split across stdout chunks', async () => {
    const process = new FakeProcess();
    queueMicrotask(() => process.sendHello());
    const client = new BleHelperClient({ platform: 'darwin', spawnProcess: () => process });
    await client.start();

    const eventPromise = new Promise((resolve) => client.once('event', resolve));
    const encoded = Buffer.from(
      `${JSON.stringify({
        protocol: 'ble-helper',
        version: 1,
        kind: 'event',
        event: 'scan.discovered',
        data: {
          sessionId: 'scan-utf8',
          deviceId: 'device-utf8',
          name: '桌面传感器',
          rssi: -42,
          serviceUuids: ['181a'],
        },
      })}\n`,
    );
    const splitAt = encoded.indexOf(Buffer.from('桌')) + 1;
    process.stdout.emit('data', encoded.subarray(0, splitAt));
    process.stdout.emit('data', encoded.subarray(splitAt));

    const event = await eventPromise;
    assert.equal(event.data.name, '桌面传感器');
  });

  it('reports unsupported without spawning on non-macOS platforms', async () => {
    let spawned = false;
    const client = new BleHelperClient({ platform: 'linux', spawnProcess: () => (spawned = true) });
    await assert.rejects(client.start(), /only available on macOS/);
    assert.equal(spawned, false);
    assert.equal(client.status.state, 'unsupported');
  });
});
