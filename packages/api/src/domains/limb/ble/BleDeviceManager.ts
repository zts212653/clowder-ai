import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { LimbNodeStatus } from '@cat-cafe/shared';
import type { LimbRegistry } from '../LimbRegistry.js';
import { decodeBleCommandValue, findBleAdapterCommand, getBleAdapter } from './BleAdapters.js';
import { type BleBindingProbeResult, BleBindingRecovery } from './BleBindingRecovery.js';
import { BLE_BINDING_SCOPE, type BleBinding, type IBleBindingStore } from './BleBindingStore.js';
import { inspectBleDevice } from './BleDeviceInspection.js';
import type { BleHelperClientStatus } from './BleHelperClientTypes.js';
import type { BleHelperEvent } from './BleHelperProtocol.js';
import { BleLimbNode, type BleLimbNodeExecutor } from './BleLimbNode.js';
import { type BleHelperRequester, BleScanSession, type BleScanSnapshot } from './BleScanSession.js';

export interface BleManagerHelper extends BleHelperRequester {
  readonly status: BleHelperClientStatus;
  on(event: 'state', listener: (status: BleHelperClientStatus) => void): this;
  on(event: 'event', listener: (message: BleHelperEvent) => void): this;
  off(event: 'state', listener: (status: BleHelperClientStatus) => void): this;
  off(event: 'event', listener: (message: BleHelperEvent) => void): this;
}

interface LoggerLike {
  warn(message: string): void;
  info(message: string): void;
}

export interface BleDeviceManagerOptions {
  helper: BleManagerHelper;
  store: IBleBindingStore;
  registry: LimbRegistry;
  platform?: string;
  logger?: LoggerLike;
}

export interface BleBindingView {
  bindingId: string;
  displayName: string;
  adapterId: string;
  commands: string[];
  nodeId: string;
  createdAt: number;
  lastConnectedAt: number | null;
}

export interface BleManagerStatus {
  platform: string;
  available: boolean;
  state: BleHelperClientStatus['state'];
  reason: string | null;
  restartAttempts: number;
  bindingCount: number;
}

export interface BleBindingDiscoveryInput {
  sessionId: string;
  discoveryId: string;
}

function toBindingView(binding: BleBinding): BleBindingView {
  return {
    bindingId: binding.bindingId,
    displayName: binding.displayName,
    adapterId: binding.adapterId,
    commands: [...binding.commands],
    nodeId: binding.nodeId,
    createdAt: binding.createdAt,
    lastConnectedAt: binding.lastConnectedAt,
  };
}

function decodeBase64Value(value: unknown): Buffer {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('valueBase64' in value) ||
    typeof value.valueBase64 !== 'string' ||
    value.valueBase64.length > 5_464
  ) {
    throw new Error('BLE helper returned an invalid characteristic value');
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.valueBase64)) {
    throw new Error('BLE helper returned malformed base64 data');
  }
  const decoded = Buffer.from(value.valueBase64, 'base64');
  if (decoded.byteLength > 4 * 1024) throw new Error('BLE characteristic value exceeds 4 KiB');
  return decoded;
}

export class BleDeviceManager extends EventEmitter implements BleLimbNodeExecutor {
  private readonly helper: BleManagerHelper;
  private readonly store: IBleBindingStore;
  private readonly registry: LimbRegistry;
  private readonly platform: string;
  private readonly logger: LoggerLike;
  private readonly scan: BleScanSession;
  private readonly recovery: BleBindingRecovery;
  private readonly bindings = new Map<string, BleBinding>();
  private readonly bindingDeviceIds = new Set<string>();
  private readonly bindingOperations = new Set<string>();

  constructor(options: BleDeviceManagerOptions) {
    super();
    this.helper = options.helper;
    this.store = options.store;
    this.registry = options.registry;
    this.platform = options.platform ?? process.platform;
    this.logger = options.logger ?? console;
    this.scan = new BleScanSession(this.helper);
    this.recovery = new BleBindingRecovery({
      helper: this.helper,
      store: this.store,
      scan: this.scan,
      bindings: this.bindings,
      reservedDeviceIds: this.bindingDeviceIds,
      acquireBindingOperation: (bindingId) => this.acquireBindingOperation(bindingId),
      logger: this.logger,
    });
    this.helper.on('state', this.handleHelperState);
  }

  async initialize(): Promise<void> {
    const persisted = await this.store.list(BLE_BINDING_SCOPE);
    for (const binding of persisted) {
      const adapter = getBleAdapter(binding.adapterId);
      const declared = new Set(adapter?.commands.map((command) => command.command) ?? []);
      if (!adapter || binding.commands.some((command) => !declared.has(command))) {
        this.logger.warn(`Ignoring BLE binding with unknown adapter or command: ${binding.bindingId}`);
        continue;
      }
      try {
        await this.registerBinding(binding);
      } catch (error) {
        this.logger.warn(`Failed to hydrate BLE binding '${binding.bindingId}': ${String(error)}`);
      }
    }
  }

  status(): BleManagerStatus {
    const helperStatus = this.helper.status;
    return {
      platform: this.platform,
      available: this.platform === 'darwin' && helperStatus.state !== 'unsupported',
      state: helperStatus.state,
      reason: helperStatus.reason,
      restartAttempts: helperStatus.restartAttempts,
      bindingCount: this.bindings.size,
    };
  }

  async listBindings(): Promise<BleBindingView[]> {
    return [...this.bindings.values()].map(toBindingView).sort((a, b) => a.createdAt - b.createdAt);
  }

  startScan(): Promise<{ sessionId: string; startedAt: number; expiresAt: number }> {
    return this.scan.start();
  }

  stopScan(): Promise<void> {
    return this.scan.stop();
  }

  scanSnapshot(): BleScanSnapshot {
    return this.scan.snapshot();
  }

  async bind(input: BleBindingDiscoveryInput): Promise<BleBindingView> {
    const discovery = this.scan.resolveDiscovery(input.sessionId, input.discoveryId);
    if (!discovery) throw new Error('BLE discovery is not available in the active scan session');
    const deviceId = discovery.platformDeviceId;
    if (
      this.bindingDeviceIds.has(deviceId) ||
      [...this.bindings.values()].some((binding) => binding.platformDeviceId === deviceId)
    ) {
      throw new Error('BLE device is already bound or binding is already in progress');
    }
    this.bindingDeviceIds.add(deviceId);

    try {
      const contract = await inspectBleDevice(this.helper, deviceId);

      const bindingId = randomUUID();
      const now = Date.now();
      const binding: BleBinding = {
        bindingId,
        scopeId: BLE_BINDING_SCOPE,
        platformDeviceId: deviceId,
        displayName: discovery.name?.trim().slice(0, 128) || `BLE ${bindingId.slice(0, 8)}`,
        adapterId: contract.adapterId,
        commands: contract.commands,
        nodeId: `ble:${bindingId}`,
        createdAt: now,
        lastConnectedAt: now,
      };

      await this.store.put(binding);
      try {
        await this.registerBinding(binding);
      } catch (error) {
        await this.store.delete(binding.scopeId, binding.bindingId);
        throw error;
      }
      return toBindingView(binding);
    } finally {
      this.bindingDeviceIds.delete(deviceId);
    }
  }

  probeBinding(bindingId: string): Promise<BleBindingProbeResult | null> {
    return this.recovery.probe(bindingId);
  }

  async rebindBinding(bindingId: string, input: BleBindingDiscoveryInput): Promise<BleBindingView | null> {
    const binding = await this.recovery.rebind(bindingId, input);
    return binding ? toBindingView(binding) : null;
  }

  async unbind(bindingId: string): Promise<boolean> {
    const binding = this.bindings.get(bindingId);
    if (!binding) return false;
    const releaseBinding = this.acquireBindingOperation(bindingId);
    try {
      await this.store.delete(binding.scopeId, binding.bindingId);
      this.bindings.delete(bindingId);
      this.registry.deregister(binding.nodeId);
      try {
        await this.helper.request('device.disconnect', { deviceId: binding.platformDeviceId });
      } catch (error) {
        this.logger.warn(`BLE device disconnect after unbind failed: ${String(error)}`);
      }
      return true;
    } finally {
      releaseBinding();
    }
  }

  async execute(binding: BleBinding, commandName: string): Promise<unknown> {
    const releaseBinding = this.acquireBindingOperation(binding.bindingId);
    try {
      const liveBinding = this.bindings.get(binding.bindingId);
      if (!liveBinding || !liveBinding.commands.includes(commandName))
        throw new Error('BLE binding is no longer active');
      const command = findBleAdapterCommand(liveBinding.adapterId, commandName);
      if (!command) throw new Error(`BLE adapter does not declare command: ${commandName}`);
      const params = {
        deviceId: liveBinding.platformDeviceId,
        serviceUuid: command.serviceUuid,
        characteristicUuid: command.characteristicUuid,
      };
      const result = await this.helper.request('gatt.read', params);
      return decodeBleCommandValue(liveBinding.adapterId, commandName, decodeBase64Value(result));
    } finally {
      releaseBinding();
    }
  }

  nodeHealth(): LimbNodeStatus {
    return this.helper.status.state === 'degraded' || this.helper.status.state === 'unsupported'
      ? 'degraded'
      : 'online';
  }

  dispose(): void {
    this.scan.dispose();
    this.helper.off('state', this.handleHelperState);
  }

  private async registerBinding(binding: BleBinding): Promise<void> {
    if (this.registry.getNode(binding.nodeId)) throw new Error(`Limb node already registered: ${binding.nodeId}`);
    await this.registry.register(new BleLimbNode(binding, this));
    this.bindings.set(binding.bindingId, { ...binding, commands: [...binding.commands] });
  }

  private acquireBindingOperation(bindingId: string): () => void {
    if (this.bindingOperations.has(bindingId)) throw new Error('BLE binding operation is already in progress');
    this.bindingOperations.add(bindingId);
    return () => this.bindingOperations.delete(bindingId);
  }

  private readonly handleHelperState = (status: BleHelperClientStatus): void => {
    const nodeStatus: LimbNodeStatus =
      status.state === 'degraded' || status.state === 'unsupported' ? 'degraded' : 'online';
    for (const binding of this.bindings.values()) this.registry.updateStatus(binding.nodeId, nodeStatus);
    this.emit('state', this.status());
  };
}
