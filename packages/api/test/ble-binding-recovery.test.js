import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, it } from 'node:test';
import { MemoryBleBindingStore } from '../dist/domains/limb/ble/BleBindingStore.js';
import { BleDeviceManager } from '../dist/domains/limb/ble/BleDeviceManager.js';
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
}

function discoveryEvent(sessionId, deviceId = 'private-corebluetooth-id') {
  return {
    kind: 'event',
    event: 'scan.discovered',
    data: { sessionId, deviceId, name: 'Desk Sensor', rssi: -45, serviceUuids: ['181a'] },
  };
}

describe('BLE binding recovery', () => {
  let helper;
  let store;
  let registry;
  let manager;

  beforeEach(() => {
    helper = new FakeHelper();
    store = new MemoryBleBindingStore();
    registry = new LimbRegistry();
    manager = new BleDeviceManager({ helper, store, registry, platform: 'darwin' });
  });

  it('probes a binding without exposing its platform ID and records successful contact', async () => {
    const session = await manager.startScan();
    helper.emit('event', discoveryEvent(session.sessionId));
    const binding = await manager.bind({
      sessionId: session.sessionId,
      discoveryId: manager.scanSnapshot().discoveries[0].discoveryId,
    });

    const reachable = await manager.probeBinding(binding.bindingId);
    assert.equal(reachable.state, 'reachable');
    assert.equal(reachable.bindingId, binding.bindingId);
    assert.equal('platformDeviceId' in reachable, false);
    assert.equal((await store.get('instance', binding.bindingId)).lastConnectedAt, reachable.checkedAt);

    const originalRequest = helper.request.bind(helper);
    helper.request = async (command, params) => {
      if (command === 'device.inspect') throw new Error('operation_timeout');
      return originalRequest(command, params);
    };
    const unreachable = await manager.probeBinding(binding.bindingId);
    assert.deepEqual(unreachable, {
      bindingId: binding.bindingId,
      state: 'unreachable',
      reason: 'timeout',
      checkedAt: unreachable.checkedAt,
    });
  });

  it('distinguishes a reachable device with a changed GATT profile from an unreachable binding', async () => {
    const session = await manager.startScan();
    helper.emit('event', discoveryEvent(session.sessionId));
    const binding = await manager.bind({
      sessionId: session.sessionId,
      discoveryId: manager.scanSnapshot().discoveries[0].discoveryId,
    });
    const originalRequest = helper.request.bind(helper);
    helper.request = async (command, params) => {
      if (command === 'device.inspect') {
        return {
          services: [
            {
              uuid: '180f',
              characteristics: [{ uuid: '2a19', properties: ['read'] }],
            },
          ],
        };
      }
      return originalRequest(command, params);
    };

    const result = await manager.probeBinding(binding.bindingId);
    assert.deepEqual(result, {
      bindingId: binding.bindingId,
      state: 'profile_mismatch',
      checkedAt: result.checkedAt,
    });
    assert.equal('platformDeviceId' in result, false);
  });

  it('explicitly rebinds a rotated platform identity while preserving the node identity', async () => {
    const session = await manager.startScan();
    helper.emit('event', discoveryEvent(session.sessionId, 'old-platform-id'));
    const binding = await manager.bind({
      sessionId: session.sessionId,
      discoveryId: manager.scanSnapshot().discoveries[0].discoveryId,
    });
    helper.emit('event', discoveryEvent(session.sessionId, 'rotated-platform-id'));
    const rotatedDiscovery = manager
      .scanSnapshot()
      .discoveries.find((discovery) => discovery.discoveryId !== manager.scanSnapshot().discoveries[0].discoveryId);

    const rebound = await manager.rebindBinding(binding.bindingId, {
      sessionId: session.sessionId,
      discoveryId: rotatedDiscovery.discoveryId,
    });
    assert.equal(rebound.bindingId, binding.bindingId);
    assert.equal(rebound.nodeId, binding.nodeId);
    assert.equal(rebound.displayName, binding.displayName);
    assert.equal('platformDeviceId' in rebound, false);
    assert.equal((await store.get('instance', binding.bindingId)).platformDeviceId, 'rotated-platform-id');

    await registry.invoke(binding.nodeId, 'ble.temperature.read', {}, { catId: 'sol' });
    const readRequest = helper.requests.findLast((request) => request.command === 'gatt.read');
    assert.equal(readRequest.params.deviceId, 'rotated-platform-id');
    assert.deepEqual(helper.requests.filter((request) => request.command === 'device.disconnect').at(-1).params, {
      deviceId: 'old-platform-id',
    });
  });

  it('rejects a rebind target whose typed capability contract differs from the existing node', async () => {
    const session = await manager.startScan();
    helper.emit('event', discoveryEvent(session.sessionId, 'old-platform-id'));
    const binding = await manager.bind({
      sessionId: session.sessionId,
      discoveryId: manager.scanSnapshot().discoveries[0].discoveryId,
    });
    helper.emit('event', discoveryEvent(session.sessionId, 'incompatible-platform-id'));
    const candidate = manager.scanSnapshot().discoveries.at(-1);
    const originalRequest = helper.request.bind(helper);
    helper.request = async (command, params) => {
      if (command === 'device.inspect' && params.deviceId === 'incompatible-platform-id') {
        return {
          services: [
            {
              uuid: '180f',
              characteristics: [{ uuid: '2a19', properties: ['read'] }],
            },
          ],
        };
      }
      return originalRequest(command, params);
    };

    await assert.rejects(
      manager.rebindBinding(binding.bindingId, {
        sessionId: session.sessionId,
        discoveryId: candidate.discoveryId,
      }),
      /not compatible/,
    );
    assert.equal((await store.get('instance', binding.bindingId)).platformDeviceId, 'old-platform-id');
  });

  it('rejects stale discoveries and a device identity owned by another binding', async () => {
    const session = await manager.startScan();
    helper.emit('event', discoveryEvent(session.sessionId, 'first-platform-id'));
    const firstDiscovery = manager.scanSnapshot().discoveries[0];
    const firstBinding = await manager.bind({
      sessionId: session.sessionId,
      discoveryId: firstDiscovery.discoveryId,
    });
    helper.emit('event', discoveryEvent(session.sessionId, 'second-platform-id'));
    const secondDiscovery = manager.scanSnapshot().discoveries.at(-1);
    await manager.bind({ sessionId: session.sessionId, discoveryId: secondDiscovery.discoveryId });

    await assert.rejects(
      manager.rebindBinding(firstBinding.bindingId, { sessionId: 'stale-session', discoveryId: 'stale-discovery' }),
      /not available/,
    );
    await assert.rejects(
      manager.rebindBinding(firstBinding.bindingId, {
        sessionId: session.sessionId,
        discoveryId: secondDiscovery.discoveryId,
      }),
      /already bound/,
    );
    assert.equal((await store.get('instance', firstBinding.bindingId)).platformDeviceId, 'first-platform-id');
    assert.equal((await store.list('instance')).length, 2);
  });

  it('serializes concurrent rebind attempts for the same persistent binding', async () => {
    const session = await manager.startScan();
    helper.emit('event', discoveryEvent(session.sessionId, 'old-platform-id'));
    const binding = await manager.bind({
      sessionId: session.sessionId,
      discoveryId: manager.scanSnapshot().discoveries[0].discoveryId,
    });
    helper.emit('event', discoveryEvent(session.sessionId, 'rotated-platform-id'));
    const candidate = manager.scanSnapshot().discoveries.at(-1);
    const originalRequest = helper.request.bind(helper);
    let releaseInspection;
    let markInspectionStarted;
    const inspectionGate = new Promise((resolve) => {
      releaseInspection = resolve;
    });
    const inspectionStarted = new Promise((resolve) => {
      markInspectionStarted = resolve;
    });
    helper.request = async (command, params) => {
      if (command === 'device.inspect' && params.deviceId === 'rotated-platform-id') {
        markInspectionStarted();
        await inspectionGate;
      }
      return originalRequest(command, params);
    };

    const input = { sessionId: session.sessionId, discoveryId: candidate.discoveryId };
    const first = manager.rebindBinding(binding.bindingId, input);
    await inspectionStarted;
    const second = manager.rebindBinding(binding.bindingId, input);
    await assert.rejects(second, /already bound|already in progress/);
    releaseInspection();
    await first;
    assert.equal((await store.list('instance')).length, 1);
  });

  it('prevents unbind from racing with an in-flight rebind', async () => {
    const session = await manager.startScan();
    helper.emit('event', discoveryEvent(session.sessionId, 'old-platform-id'));
    const binding = await manager.bind({
      sessionId: session.sessionId,
      discoveryId: manager.scanSnapshot().discoveries[0].discoveryId,
    });
    helper.emit('event', discoveryEvent(session.sessionId, 'rotated-platform-id'));
    const candidate = manager.scanSnapshot().discoveries.at(-1);
    const originalRequest = helper.request.bind(helper);
    let releaseInspection;
    let markInspectionStarted;
    const inspectionGate = new Promise((resolve) => {
      releaseInspection = resolve;
    });
    const inspectionStarted = new Promise((resolve) => {
      markInspectionStarted = resolve;
    });
    helper.request = async (command, params) => {
      if (command === 'device.inspect' && params.deviceId === 'rotated-platform-id') {
        markInspectionStarted();
        await inspectionGate;
      }
      return originalRequest(command, params);
    };

    const rebind = manager.rebindBinding(binding.bindingId, {
      sessionId: session.sessionId,
      discoveryId: candidate.discoveryId,
    });
    await inspectionStarted;
    await assert.rejects(manager.unbind(binding.bindingId), /already in progress/);
    releaseInspection();
    await rebind;

    assert.ok(registry.getNode(binding.nodeId));
    assert.equal((await store.list('instance')).length, 1);
    assert.equal((await store.get('instance', binding.bindingId)).platformDeviceId, 'rotated-platform-id');
  });

  it('keeps the old binding active when rebind persistence fails and permits a retry', async () => {
    const session = await manager.startScan();
    helper.emit('event', discoveryEvent(session.sessionId, 'old-platform-id'));
    const binding = await manager.bind({
      sessionId: session.sessionId,
      discoveryId: manager.scanSnapshot().discoveries[0].discoveryId,
    });
    helper.emit('event', discoveryEvent(session.sessionId, 'rotated-platform-id'));
    const candidate = manager.scanSnapshot().discoveries.at(-1);
    const originalPut = store.put.bind(store);
    let failPut = true;
    store.put = async (nextBinding) => {
      if (failPut && nextBinding.platformDeviceId === 'rotated-platform-id') {
        failPut = false;
        throw new Error('persistence unavailable');
      }
      return originalPut(nextBinding);
    };
    const input = { sessionId: session.sessionId, discoveryId: candidate.discoveryId };

    await assert.rejects(manager.rebindBinding(binding.bindingId, input), /persistence unavailable/);
    assert.equal((await store.get('instance', binding.bindingId)).platformDeviceId, 'old-platform-id');
    await registry.invoke(binding.nodeId, 'ble.temperature.read', {}, { catId: 'sol' });
    assert.equal(
      helper.requests.findLast((request) => request.command === 'gatt.read').params.deviceId,
      'old-platform-id',
    );

    await manager.rebindBinding(binding.bindingId, input);
    assert.equal((await store.get('instance', binding.bindingId)).platformDeviceId, 'rotated-platform-id');
  });
});
