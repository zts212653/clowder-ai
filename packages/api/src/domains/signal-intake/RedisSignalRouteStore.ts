import type { SignalRouteRecord } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { digestCanonical } from './canonical-json.js';
import type { SignalRouteStore } from './SignalRouteStore.js';
import { SignalIntakeKeys } from './signal-intake-keys.js';

function key(pluginId: string, signalType: string): string {
  return SignalIntakeKeys.route(digestCanonical({ pluginId, signalType }));
}

function parse(raw: string): SignalRouteRecord {
  const value = JSON.parse(raw) as SignalRouteRecord;
  if (
    !value ||
    typeof value.routeId !== 'string' ||
    typeof value.pluginId !== 'string' ||
    typeof value.signalType !== 'string' ||
    !Number.isSafeInteger(value.generation)
  ) {
    throw new Error('signal route record is corrupt');
  }
  return value;
}

export class RedisSignalRouteStore implements SignalRouteStore {
  constructor(private readonly redis: RedisClient) {}

  async get(pluginId: string, signalType: string): Promise<SignalRouteRecord | null> {
    const raw = await this.redis.get(key(pluginId, signalType));
    return raw ? parse(raw) : null;
  }

  async put(record: SignalRouteRecord): Promise<void> {
    await this.redis.set(key(record.pluginId, record.signalType), JSON.stringify(record));
  }

  async putIfAbsent(record: SignalRouteRecord): Promise<boolean> {
    const result = await this.redis.set(key(record.pluginId, record.signalType), JSON.stringify(record), 'NX');
    return result === 'OK';
  }
}
