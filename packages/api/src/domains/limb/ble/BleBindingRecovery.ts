import type { BleBinding, IBleBindingStore } from './BleBindingStore.js';
import {
  type BleDeviceContract,
  BleUnsupportedProfileError,
  hasSameBleContract,
  inspectBleDevice,
} from './BleDeviceInspection.js';
import type { BleScanSession } from './BleScanSession.js';

interface BleRecoveryHelper {
  request(command: string, params: Record<string, unknown>): Promise<unknown>;
}

interface LoggerLike {
  warn(message: string): void;
}

export interface BleBindingProbeResult {
  bindingId: string;
  state: 'reachable' | 'unreachable' | 'profile_mismatch';
  checkedAt: number;
  reason?: 'busy' | 'connection_failed' | 'disconnected' | 'inspection_failed' | 'timeout' | 'unavailable';
}

interface BleBindingRecoveryOptions {
  helper: BleRecoveryHelper;
  store: IBleBindingStore;
  scan: BleScanSession;
  bindings: Map<string, BleBinding>;
  reservedDeviceIds: Set<string>;
  acquireBindingOperation: (bindingId: string) => () => void;
  logger: LoggerLike;
}

function failureReason(error: unknown): NonNullable<BleBindingProbeResult['reason']> {
  const message = error instanceof Error ? error.message : String(error);
  if (/device_busy|already in progress/i.test(message)) return 'busy';
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/connect_failed/i.test(message)) return 'connection_failed';
  if (/device_disconnected/i.test(message)) return 'disconnected';
  if (/service_discovery|inspection|characteristic/i.test(message)) return 'inspection_failed';
  return 'unavailable';
}

export class BleBindingRecovery {
  constructor(private readonly options: BleBindingRecoveryOptions) {}

  async probe(bindingId: string): Promise<BleBindingProbeResult | null> {
    const binding = this.options.bindings.get(bindingId);
    if (!binding) return null;
    const releaseBinding = this.options.acquireBindingOperation(bindingId);
    const checkedAt = Date.now();
    try {
      let contract: BleDeviceContract;
      try {
        contract = await inspectBleDevice(this.options.helper, binding.platformDeviceId);
      } catch (error) {
        if (error instanceof BleUnsupportedProfileError) return { bindingId, state: 'profile_mismatch', checkedAt };
        return { bindingId, state: 'unreachable', reason: failureReason(error), checkedAt };
      }
      if (!hasSameBleContract(binding, contract)) return { bindingId, state: 'profile_mismatch', checkedAt };
      const updated = { ...binding, commands: [...binding.commands], lastConnectedAt: checkedAt };
      await this.options.store.put(updated);
      this.options.bindings.set(bindingId, updated);
      return { bindingId, state: 'reachable', checkedAt };
    } finally {
      releaseBinding();
    }
  }

  async rebind(bindingId: string, input: { sessionId: string; discoveryId: string }): Promise<BleBinding | null> {
    const binding = this.options.bindings.get(bindingId);
    if (!binding) return null;
    const discovery = this.options.scan.resolveDiscovery(input.sessionId, input.discoveryId);
    if (!discovery) throw new Error('BLE discovery is not available in the active scan session');
    const deviceId = discovery.platformDeviceId;
    if (
      this.options.reservedDeviceIds.has(deviceId) ||
      [...this.options.bindings.values()].some(
        (candidate) => candidate.bindingId !== bindingId && candidate.platformDeviceId === deviceId,
      )
    ) {
      throw new Error('BLE device is already bound or binding is already in progress');
    }
    const releaseBinding = this.options.acquireBindingOperation(bindingId);
    this.options.reservedDeviceIds.add(deviceId);
    try {
      const contract = await inspectBleDevice(this.options.helper, deviceId);
      if (!hasSameBleContract(binding, contract)) {
        throw new Error('BLE rebind target is not compatible with the existing binding');
      }
      const updated: BleBinding = {
        ...binding,
        platformDeviceId: deviceId,
        commands: [...binding.commands],
        lastConnectedAt: Date.now(),
      };
      await this.options.store.put(updated);
      this.options.bindings.set(bindingId, updated);
      if (binding.platformDeviceId !== deviceId) await this.disconnectPreviousIdentity(binding.platformDeviceId);
      return { ...updated, commands: [...updated.commands] };
    } finally {
      this.options.reservedDeviceIds.delete(deviceId);
      releaseBinding();
    }
  }

  private async disconnectPreviousIdentity(deviceId: string): Promise<void> {
    try {
      await this.options.helper.request('device.disconnect', { deviceId });
    } catch (error) {
      this.options.logger.warn(`BLE previous device disconnect after rebind failed: ${String(error)}`);
    }
  }
}
