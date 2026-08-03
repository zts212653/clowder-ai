import { availableBleCommands, type BleGattService, selectBleAdapter } from './BleAdapters.js';

interface BleInspectionRequester {
  request(command: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface BleDeviceContract {
  adapterId: string;
  commands: string[];
}

export class BleUnsupportedProfileError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGattServices(value: unknown): BleGattService[] {
  if (!isRecord(value) || !Array.isArray(value.services) || value.services.length > 64) {
    throw new Error('BLE helper returned an invalid GATT inspection');
  }
  return value.services.map((service): BleGattService => {
    if (!isRecord(service) || typeof service.uuid !== 'string' || service.uuid.length > 64) {
      throw new Error('BLE helper returned an invalid GATT service');
    }
    if (!Array.isArray(service.characteristics) || service.characteristics.length > 128) {
      throw new Error('BLE helper returned an invalid characteristic list');
    }
    return {
      uuid: service.uuid,
      characteristics: service.characteristics.map((characteristic) => {
        if (
          !isRecord(characteristic) ||
          typeof characteristic.uuid !== 'string' ||
          characteristic.uuid.length > 64 ||
          !Array.isArray(characteristic.properties) ||
          !characteristic.properties.every((property) => typeof property === 'string' && property.length <= 32)
        ) {
          throw new Error('BLE helper returned an invalid GATT characteristic');
        }
        return { uuid: characteristic.uuid, properties: [...characteristic.properties] as string[] };
      }),
    };
  });
}

export async function inspectBleDevice(helper: BleInspectionRequester, deviceId: string): Promise<BleDeviceContract> {
  const inspection = await helper.request('device.inspect', { deviceId });
  const services = parseGattServices(inspection);
  const adapter = selectBleAdapter(services);
  if (!adapter) throw new BleUnsupportedProfileError('BLE device does not expose a supported adapter profile');
  const commands = availableBleCommands(adapter, services).map((command) => command.command);
  if (commands.length === 0) {
    throw new BleUnsupportedProfileError('BLE device has no supported readable characteristics');
  }
  return { adapterId: adapter.id, commands };
}

export function hasSameBleContract(binding: { adapterId: string; commands: string[] }, contract: BleDeviceContract) {
  if (binding.adapterId !== contract.adapterId || binding.commands.length !== contract.commands.length) return false;
  const expected = new Set(binding.commands);
  return contract.commands.every((command) => expected.has(command));
}
