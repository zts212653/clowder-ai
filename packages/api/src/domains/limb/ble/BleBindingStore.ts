import type { RedisClient } from '@cat-cafe/shared/utils';

export const BLE_BINDING_SCOPE = 'instance' as const;
export const BLE_BINDING_INDEX_KEY = (scopeId: string): string => `limb:ble:bindings:${scopeId}:index`;
export const bleBindingKey = (scopeId: string, bindingId: string): string =>
  `limb:ble:bindings:${scopeId}:${bindingId}`;

export interface BleBinding {
  bindingId: string;
  scopeId: string;
  platformDeviceId: string;
  displayName: string;
  adapterId: string;
  commands: string[];
  nodeId: string;
  createdAt: number;
  lastConnectedAt: number | null;
}

export interface IBleBindingStore {
  get(scopeId: string, bindingId: string): Promise<BleBinding | null>;
  list(scopeId: string): Promise<BleBinding[]>;
  put(binding: BleBinding): Promise<void>;
  delete(scopeId: string, bindingId: string): Promise<void>;
}

interface LoggerLike {
  warn(message: string): void;
}

type BindingRedis = Pick<RedisClient, 'get' | 'smembers' | 'multi'>;

function isBleBinding(value: unknown): value is BleBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.bindingId === 'string' &&
    candidate.bindingId.length > 0 &&
    typeof candidate.scopeId === 'string' &&
    candidate.scopeId.length > 0 &&
    typeof candidate.platformDeviceId === 'string' &&
    candidate.platformDeviceId.length > 0 &&
    typeof candidate.displayName === 'string' &&
    candidate.displayName.length <= 128 &&
    typeof candidate.adapterId === 'string' &&
    Array.isArray(candidate.commands) &&
    candidate.commands.length > 0 &&
    candidate.commands.length <= 32 &&
    candidate.commands.every((command) => typeof command === 'string' && command.length > 0 && command.length <= 128) &&
    typeof candidate.nodeId === 'string' &&
    Number.isFinite(candidate.createdAt) &&
    (candidate.lastConnectedAt === null || Number.isFinite(candidate.lastConnectedAt))
  );
}

function parseBinding(raw: string, expectedScope: string, expectedId: string): BleBinding | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isBleBinding(parsed) || parsed.scopeId !== expectedScope || parsed.bindingId !== expectedId) return null;
  return parsed;
}

export class RedisBleBindingStore implements IBleBindingStore {
  constructor(
    private readonly redis: BindingRedis,
    private readonly logger: LoggerLike = console,
  ) {}

  async get(scopeId: string, bindingId: string): Promise<BleBinding | null> {
    const raw = await this.redis.get(bleBindingKey(scopeId, bindingId));
    if (!raw) return null;
    const binding = parseBinding(raw, scopeId, bindingId);
    if (!binding) this.logger.warn(`Ignoring invalid BLE binding record: ${scopeId}/${bindingId}`);
    return binding;
  }

  async list(scopeId: string): Promise<BleBinding[]> {
    const ids = await this.redis.smembers(BLE_BINDING_INDEX_KEY(scopeId));
    const bindings = await Promise.all(ids.map((id) => this.get(scopeId, id)));
    return bindings
      .filter((binding): binding is BleBinding => binding !== null)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async put(binding: BleBinding): Promise<void> {
    if (!isBleBinding(binding)) throw new Error('Invalid BLE binding');
    const transaction = this.redis.multi();
    transaction.set(bleBindingKey(binding.scopeId, binding.bindingId), JSON.stringify(binding));
    transaction.sadd(BLE_BINDING_INDEX_KEY(binding.scopeId), binding.bindingId);
    const result = await transaction.exec();
    if (result === null || result.some(([error]) => error)) throw new Error('Failed to persist BLE binding');
  }

  async delete(scopeId: string, bindingId: string): Promise<void> {
    const transaction = this.redis.multi();
    transaction.del(bleBindingKey(scopeId, bindingId));
    transaction.srem(BLE_BINDING_INDEX_KEY(scopeId), bindingId);
    const result = await transaction.exec();
    if (result === null || result.some(([error]) => error)) throw new Error('Failed to delete BLE binding');
  }
}

export class MemoryBleBindingStore implements IBleBindingStore {
  private readonly bindings = new Map<string, BleBinding>();

  private key(scopeId: string, bindingId: string): string {
    return `${scopeId}:${bindingId}`;
  }

  async get(scopeId: string, bindingId: string): Promise<BleBinding | null> {
    const binding = this.bindings.get(this.key(scopeId, bindingId));
    return binding ? { ...binding, commands: [...binding.commands] } : null;
  }

  async list(scopeId: string): Promise<BleBinding[]> {
    return [...this.bindings.values()]
      .filter((binding) => binding.scopeId === scopeId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((binding) => ({ ...binding, commands: [...binding.commands] }));
  }

  async put(binding: BleBinding): Promise<void> {
    if (!isBleBinding(binding)) throw new Error('Invalid BLE binding');
    this.bindings.set(this.key(binding.scopeId, binding.bindingId), { ...binding, commands: [...binding.commands] });
  }

  async delete(scopeId: string, bindingId: string): Promise<void> {
    this.bindings.delete(this.key(scopeId, bindingId));
  }
}
