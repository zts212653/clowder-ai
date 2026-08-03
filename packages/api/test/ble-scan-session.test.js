import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { BleScanSession } from '../dist/domains/limb/ble/BleScanSession.js';

class FakeHelper extends EventEmitter {
  requests = [];

  async request(command, params) {
    this.requests.push({ command, params });
    return {};
  }
}

describe('BleScanSession', () => {
  it('keeps platform device IDs private and clears discoveries on stop', async () => {
    const helper = new FakeHelper();
    let timerCallback;
    const scan = new BleScanSession(helper, {
      now: () => 1_000,
      setTimer: (callback) => {
        timerCallback = callback;
        return 1;
      },
      clearTimer: () => {},
    });

    const started = await scan.start();
    helper.emit('event', {
      kind: 'event',
      event: 'scan.discovered',
      data: {
        sessionId: started.sessionId,
        deviceId: 'core-bluetooth-private-id',
        name: 'Sensor',
        rssi: -48,
        serviceUuids: ['181a'],
      },
    });

    const snapshot = scan.snapshot();
    assert.equal(snapshot.discoveries.length, 1);
    assert.equal('deviceId' in snapshot.discoveries[0], false);
    assert.notEqual(snapshot.discoveries[0].discoveryId, 'core-bluetooth-private-id');
    assert.equal(
      scan.resolveDiscovery(started.sessionId, snapshot.discoveries[0].discoveryId).platformDeviceId,
      'core-bluetooth-private-id',
    );

    await scan.stop();
    assert.deepEqual(scan.snapshot().discoveries, []);
    assert.equal(scan.resolveDiscovery(started.sessionId, snapshot.discoveries[0].discoveryId), null);
    assert.equal(typeof timerCallback, 'function');
  });

  it('ends after 30 seconds and ignores events from another session', async () => {
    const helper = new FakeHelper();
    let timerCallback;
    let scheduledMs;
    const scan = new BleScanSession(helper, {
      now: () => 5_000,
      setTimer: (callback, ms) => {
        timerCallback = callback;
        scheduledMs = ms;
        return 1;
      },
      clearTimer: () => {},
    });

    const started = await scan.start();
    assert.equal(scheduledMs, 30_000);
    helper.emit('event', {
      kind: 'event',
      event: 'scan.discovered',
      data: { sessionId: 'other', deviceId: 'device', name: null, rssi: -60, serviceUuids: [] },
    });
    assert.deepEqual(scan.snapshot().discoveries, []);

    timerCallback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scan.snapshot().active, false);
    assert.deepEqual(scan.snapshot().discoveries, []);
    assert.equal(helper.requests.at(-1).command, 'scan.stop');
    assert.equal(helper.requests.at(-1).params.sessionId, started.sessionId);
  });

  it('clears local discoveries when the helper reports an early stop', async () => {
    const helper = new FakeHelper();
    const scan = new BleScanSession(helper, { setTimer: () => 1, clearTimer: () => {} });
    const started = await scan.start();
    helper.emit('event', {
      kind: 'event',
      event: 'scan.discovered',
      data: { sessionId: started.sessionId, deviceId: 'device', name: null, rssi: -60, serviceUuids: [] },
    });
    assert.equal(scan.snapshot().discoveries.length, 1);

    helper.emit('event', {
      kind: 'event',
      event: 'scan.state',
      data: { sessionId: started.sessionId, state: 'stopped' },
    });
    assert.equal(scan.snapshot().active, false);
    assert.deepEqual(scan.snapshot().discoveries, []);
  });

  it('does not install a timeout after an early stop races with scan acknowledgement', async () => {
    const helper = new FakeHelper();
    let timerInstalled = false;
    helper.request = async (command, params) => {
      helper.requests.push({ command, params });
      helper.emit('event', {
        kind: 'event',
        event: 'scan.state',
        data: { sessionId: params.sessionId, state: 'stopped' },
      });
      return {};
    };
    const scan = new BleScanSession(helper, {
      setTimer: () => {
        timerInstalled = true;
        return 1;
      },
      clearTimer: () => {},
    });

    await scan.start();

    assert.equal(scan.snapshot().active, false);
    assert.equal(timerInstalled, false);
  });
});
