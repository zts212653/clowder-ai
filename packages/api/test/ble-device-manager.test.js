import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, it } from 'node:test';
import { MemoryBleBindingStore } from '../dist/domains/limb/ble/BleBindingStore.js';
import { BleDeviceManager } from '../dist/domains/limb/ble/BleDeviceManager.js';
import { LimbAccessPolicy } from '../dist/domains/limb/LimbAccessPolicy.js';
import { LimbActionLog } from '../dist/domains/limb/LimbActionLog.js';
import { LimbLeaseManager } from '../dist/domains/limb/LimbLeaseManager.js';
import { LimbRegistry } from '../dist/domains/limb/LimbRegistry.js';

class FakeHelper extends EventEmitter {
  requests = [];
  status = { state: 'idle', reason: null, restartAttempts: 0 };

  async request(command, params) {
    this.requests.push({ command, params });
    if (command === 'device.inspect') {
      return {
        services: [
          {
            uuid: '181a',
            characteristics: [
              { uuid: '2a6e', properties: ['read', 'notify'] },
              { uuid: '2a6f', properties: ['read'] },
            ],
          },
        ],
      };
    }
    if (command === 'gatt.read') {
      const value = Buffer.alloc(2);
      value.writeInt16LE(2345);
      return { valueBase64: value.toString('base64') };
    }
    return {};
  }

  setState(state, reason = null) {
    this.status = { state, reason, restartAttempts: 0 };
    this.emit('state', this.status);
  }
}

function discoveryEvent(sessionId, deviceId = 'private-corebluetooth-id') {
  return {
    kind: 'event',
    event: 'scan.discovered',
    data: { sessionId, deviceId, name: 'Desk Sensor', rssi: -45, serviceUuids: ['181a'] },
  };
}

describe('BleDeviceManager + BleLimbNode', () => {
  let helper;
  let store;
  let registry;
  let actionLog;
  let manager;

  beforeEach(() => {
    helper = new FakeHelper();
    store = new MemoryBleBindingStore();
    registry = new LimbRegistry();
    actionLog = new LimbActionLog();
    registry.setDeps({
      accessPolicy: new LimbAccessPolicy(),
      leaseManager: new LimbLeaseManager(),
      actionLog,
    });
    manager = new BleDeviceManager({ helper, store, registry, platform: 'darwin' });
  });

  it('hydrates persistent bindings without spawning the helper', async () => {
    await store.put({
      bindingId: 'persisted',
      scopeId: 'instance',
      platformDeviceId: 'private-id',
      displayName: 'Persisted Sensor',
      adapterId: 'standard.environmental',
      commands: ['ble.temperature.read'],
      nodeId: 'ble:persisted',
      createdAt: 100,
      lastConnectedAt: null,
    });

    await manager.initialize();
    assert.ok(registry.getNode('ble:persisted'));
    assert.deepEqual(helper.requests, []);
    const listed = await manager.listBindings();
    assert.equal('platformDeviceId' in listed[0], false);
  });

  it('binds only a discovery from the active scan and registers a typed node', async () => {
    const session = await manager.startScan();
    helper.emit('event', discoveryEvent(session.sessionId));
    const discovery = manager.scanSnapshot().discoveries[0];

    const binding = await manager.bind({ sessionId: session.sessionId, discoveryId: discovery.discoveryId });
    assert.equal(binding.adapterId, 'standard.environmental');
    assert.deepEqual(binding.commands, ['ble.temperature.read', 'ble.humidity.read']);
    assert.equal('platformDeviceId' in binding, false);
    assert.ok(registry.getNode(binding.nodeId));
    assert.equal((await store.list('instance')).length, 1);
  });

  it('serializes concurrent bind attempts for the same discovered device', async () => {
    const session = await manager.startScan();
    helper.emit('event', discoveryEvent(session.sessionId));
    const discovery = manager.scanSnapshot().discoveries[0];
    const originalRequest = helper.request.bind(helper);
    let releaseInspection;
    let markInspectionStarted;
    const inspectionGate = new Promise((resolve) => {
      releaseInspection = resolve;
    });
    const inspectionStarted = new Promise((resolve) => {
      markInspectionStarted = resolve;
    });
    let inspectionCount = 0;
    helper.request = async (command, params) => {
      if (command === 'device.inspect') {
        inspectionCount += 1;
        markInspectionStarted();
        await inspectionGate;
      }
      return originalRequest(command, params);
    };

    const firstBind = manager.bind({ sessionId: session.sessionId, discoveryId: discovery.discoveryId });
    await inspectionStarted;
    const secondBind = manager.bind({ sessionId: session.sessionId, discoveryId: discovery.discoveryId });
    await Promise.resolve();
    releaseInspection();

    const [first, second] = await Promise.allSettled([firstBind, secondBind]);
    assert.equal(first.status, 'fulfilled');
    assert.equal(second.status, 'rejected');
    assert.match(second.reason.message, /already bound|binding is already in progress/);
    assert.equal(inspectionCount, 1);
    assert.equal((await store.list('instance')).length, 1);
  });

  it('releases the bind reservation after inspection fails', async () => {
    const session = await manager.startScan();
    helper.emit('event', discoveryEvent(session.sessionId));
    const discovery = manager.scanSnapshot().discoveries[0];
    const originalRequest = helper.request.bind(helper);
    let failInspection = true;
    helper.request = async (command, params) => {
      if (command === 'device.inspect' && failInspection) {
        failInspection = false;
        throw new Error('inspection failed');
      }
      return originalRequest(command, params);
    };

    await assert.rejects(
      manager.bind({ sessionId: session.sessionId, discoveryId: discovery.discoveryId }),
      /inspection failed/,
    );
    const binding = await manager.bind({ sessionId: session.sessionId, discoveryId: discovery.discoveryId });

    assert.equal(binding.adapterId, 'standard.environmental');
    assert.equal((await store.list('instance')).length, 1);
  });

  it('rejects stale or unknown discoveries without persistence', async () => {
    await assert.rejects(manager.bind({ sessionId: 'stale', discoveryId: 'unknown' }), /not available/);
    assert.deepEqual(await store.list('instance'), []);
  });

  it('reads through the F126 pipeline and records an Action Log entry', async () => {
    const session = await manager.startScan();
    helper.emit('event', discoveryEvent(session.sessionId));
    const discovery = manager.scanSnapshot().discoveries[0];
    const binding = await manager.bind({ sessionId: session.sessionId, discoveryId: discovery.discoveryId });

    const result = await registry.invoke(
      binding.nodeId,
      'ble.temperature.read',
      {},
      { catId: 'sol', invocationId: 'inv-1' },
    );
    assert.deepEqual(result, {
      success: true,
      data: { kind: 'temperature', value: 23.45, unit: '°C' },
    });
    const entries = actionLog.getByNode(binding.nodeId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 'completed');
    assert.equal(entries[0].catId, 'sol');
  });

  it('rejects arbitrary GATT writes before reaching the helper', async () => {
    const session = await manager.startScan();
    helper.emit('event', discoveryEvent(session.sessionId));
    const binding = await manager.bind({
      sessionId: session.sessionId,
      discoveryId: manager.scanSnapshot().discoveries[0].discoveryId,
    });
    const before = helper.requests.length;

    const result = await registry.invoke(binding.nodeId, 'gatt.write', { valueBase64: 'AQ==' }, { catId: 'sol' });
    assert.equal(result.success, false);
    assert.match(result.error, /not in any capability whitelist/);
    assert.equal(helper.requests.length, before);
  });

  it('deregisters and disconnects on explicit unbind', async () => {
    const session = await manager.startScan();
    helper.emit('event', discoveryEvent(session.sessionId));
    const binding = await manager.bind({
      sessionId: session.sessionId,
      discoveryId: manager.scanSnapshot().discoveries[0].discoveryId,
    });

    assert.equal(await manager.unbind(binding.bindingId), true);
    assert.equal(registry.getNode(binding.nodeId), undefined);
    assert.equal(await store.get('instance', binding.bindingId), null);
    assert.equal(helper.requests.at(-1).command, 'device.disconnect');
  });

  it('projects helper degradation onto every BLE node', async () => {
    await store.put({
      bindingId: 'persisted',
      scopeId: 'instance',
      platformDeviceId: 'private-id',
      displayName: 'Persisted Sensor',
      adapterId: 'standard.environmental',
      commands: ['ble.temperature.read'],
      nodeId: 'ble:persisted',
      createdAt: 100,
      lastConnectedAt: null,
    });
    await manager.initialize();

    helper.setState('degraded', 'helper crashed');
    assert.equal(registry.getNode('ble:persisted').status, 'degraded');
    helper.setState('ready');
    assert.equal(registry.getNode('ble:persisted').status, 'online');
  });
});
