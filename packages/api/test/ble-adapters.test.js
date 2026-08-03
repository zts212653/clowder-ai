import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BLE_ADAPTERS,
  decodeBleCommandValue,
  normalizeGattUuid,
  selectBleAdapter,
} from '../dist/domains/limb/ble/BleAdapters.js';

describe('BLE standard adapters', () => {
  it('normalizes Bluetooth base UUIDs', () => {
    assert.equal(normalizeGattUuid('0000180F-0000-1000-8000-00805F9B34FB'), '180f');
    assert.equal(normalizeGattUuid('2A19'), '2a19');
  });

  it('decodes battery, temperature, and humidity with units', () => {
    assert.deepEqual(decodeBleCommandValue('standard.battery', 'ble.battery.read', Buffer.from([87])), {
      kind: 'battery',
      value: 87,
      unit: '%',
    });

    const temperature = Buffer.alloc(2);
    temperature.writeInt16LE(2156);
    assert.deepEqual(decodeBleCommandValue('standard.environmental', 'ble.temperature.read', temperature), {
      kind: 'temperature',
      value: 21.56,
      unit: '°C',
    });

    const humidity = Buffer.alloc(2);
    humidity.writeUInt16LE(5034);
    assert.deepEqual(decodeBleCommandValue('standard.environmental', 'ble.humidity.read', humidity), {
      kind: 'humidity',
      value: 50.34,
      unit: '%',
    });
  });

  it('rejects malformed and out-of-range sensor data', () => {
    assert.throws(() => decodeBleCommandValue('standard.battery', 'ble.battery.read', Buffer.alloc(0)), /length/);
    assert.throws(() => decodeBleCommandValue('standard.battery', 'ble.battery.read', Buffer.from([101])), /outside/);

    const humidity = Buffer.alloc(2);
    humidity.writeUInt16LE(10_001);
    assert.throws(() => decodeBleCommandValue('standard.environmental', 'ble.humidity.read', humidity), /outside/);
  });

  it('selects only known adapters from inspected characteristics', () => {
    const environmental = selectBleAdapter([
      { uuid: '181a', characteristics: [{ uuid: '2a6e', properties: ['read'] }] },
    ]);
    assert.equal(environmental?.id, 'standard.environmental');

    const unknown = selectBleAdapter([
      { uuid: 'ffff', characteristics: [{ uuid: 'eeee', properties: ['read', 'write'] }] },
    ]);
    assert.equal(unknown, null);
    const writeOnlyEnvironmental = selectBleAdapter([
      { uuid: '181a', characteristics: [{ uuid: '2a6e', properties: ['write'] }] },
    ]);
    assert.equal(writeOnlyEnvironmental, null);
    assert.equal(Object.hasOwn(BLE_ADAPTERS, 'standard.environmental'), true);
  });
});
