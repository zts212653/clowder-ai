import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BLE_BINDING_INDEX_KEY,
  bleBindingKey,
  MemoryBleBindingStore,
  RedisBleBindingStore,
} from '../dist/domains/limb/ble/BleBindingStore.js';

const BINDING = {
  bindingId: 'binding-1',
  scopeId: 'instance',
  platformDeviceId: 'device-1',
  displayName: 'Desk Sensor',
  adapterId: 'standard.environmental',
  commands: ['ble.temperature.read'],
  nodeId: 'ble:binding-1',
  createdAt: 100,
  lastConnectedAt: null,
};

class FakeRedis {
  values = new Map();
  sets = new Map();
  operations = [];

  multi() {
    const queued = [];
    return {
      set: (key, value) => {
        queued.push(['set', key, value]);
        return this;
      },
      sadd: (key, value) => {
        queued.push(['sadd', key, value]);
        return this;
      },
      del: (key) => {
        queued.push(['del', key]);
        return this;
      },
      srem: (key, value) => {
        queued.push(['srem', key, value]);
        return this;
      },
      exec: async () => {
        for (const op of queued) this.apply(op);
        this.operations.push(...queued);
        return queued.map(() => [null, 1]);
      },
    };
  }

  apply([command, key, value]) {
    if (command === 'set') this.values.set(key, value);
    if (command === 'sadd') {
      const set = this.sets.get(key) ?? new Set();
      set.add(value);
      this.sets.set(key, set);
    }
    if (command === 'del') this.values.delete(key);
    if (command === 'srem') this.sets.get(key)?.delete(value);
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async smembers(key) {
    return [...(this.sets.get(key) ?? [])];
  }
}

describe('BLE binding stores', () => {
  it('memory implementation is isolated for tests', async () => {
    const store = new MemoryBleBindingStore();
    await store.put(BINDING);
    assert.deepEqual(await store.get('instance', 'binding-1'), BINDING);
    assert.equal((await store.list('instance')).length, 1);
    await store.delete('instance', 'binding-1');
    assert.equal(await store.get('instance', 'binding-1'), null);
  });

  it('Redis implementation persists without EXPIRE and rehydrates', async () => {
    const redis = new FakeRedis();
    const store = new RedisBleBindingStore(redis);
    await store.put(BINDING);

    assert.deepEqual(
      redis.operations.map((op) => op[0]),
      ['set', 'sadd'],
    );
    assert.equal(
      redis.operations.some((op) => op.includes('EX') || op[0] === 'expire'),
      false,
    );
    assert.equal(redis.sets.get(BLE_BINDING_INDEX_KEY('instance')).has('binding-1'), true);

    const restarted = new RedisBleBindingStore(redis);
    assert.deepEqual(await restarted.get('instance', 'binding-1'), BINDING);
    assert.deepEqual(await restarted.list('instance'), [BINDING]);
  });

  it('skips corrupt records without deleting persistent data', async () => {
    const redis = new FakeRedis();
    redis.sets.set(BLE_BINDING_INDEX_KEY('instance'), new Set(['bad']));
    redis.values.set(bleBindingKey('instance', 'bad'), '{broken-json');
    const warnings = [];
    const store = new RedisBleBindingStore(redis, { warn: (message) => warnings.push(message) });

    assert.deepEqual(await store.list('instance'), []);
    assert.equal(redis.values.has(bleBindingKey('instance', 'bad')), true);
    assert.equal(warnings.length, 1);
  });
});
