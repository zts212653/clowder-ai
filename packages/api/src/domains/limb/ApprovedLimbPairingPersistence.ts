import type { RedisClient } from '@cat-cafe/shared/utils';
import type { PairingRequest } from './LimbPairingStore.js';

const APPROVED_PAIRINGS_KEY = 'limb:pairing:approved:v1';

export interface ApprovedLimbPairingPersistence {
  list(): Promise<PairingRequest[]>;
  put(pairing: PairingRequest): Promise<void>;
  remove(nodeId: string): Promise<void>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isApprovedPairing(value: unknown): value is PairingRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    !isNonEmptyString(candidate.requestId) ||
    !isNonEmptyString(candidate.nodeId) ||
    !isNonEmptyString(candidate.displayName) ||
    !isNonEmptyString(candidate.platform) ||
    !isNonEmptyString(candidate.endpointUrl) ||
    candidate.status !== 'approved' ||
    !Number.isSafeInteger(candidate.createdAt) ||
    (candidate.createdAt as number) < 0 ||
    !Number.isSafeInteger(candidate.decidedAt) ||
    (candidate.decidedAt as number) < (candidate.createdAt as number) ||
    !isNonEmptyString(candidate.approvedByUserId) ||
    !isNonEmptyString(candidate.apiKey) ||
    !Array.isArray(candidate.capabilities)
  ) {
    return false;
  }

  return candidate.capabilities.every((capability) => {
    if (typeof capability !== 'object' || capability === null || Array.isArray(capability)) return false;
    const item = capability as Record<string, unknown>;
    return (
      isNonEmptyString(item.cap) &&
      Array.isArray(item.commands) &&
      item.commands.every(isNonEmptyString) &&
      (item.authLevel === 'free' || item.authLevel === 'leased' || item.authLevel === 'gated')
    );
  });
}

function clone(pairing: PairingRequest): PairingRequest {
  return structuredClone(pairing);
}

function assertApprovedPairing(pairing: PairingRequest): void {
  if (!isApprovedPairing(pairing)) {
    throw new TypeError('Invalid approved limb pairing record');
  }
}

export class MemoryApprovedLimbPairingPersistence implements ApprovedLimbPairingPersistence {
  private readonly pairings = new Map<string, PairingRequest>();

  async list(): Promise<PairingRequest[]> {
    return [...this.pairings.values()].map(clone);
  }

  async put(pairing: PairingRequest): Promise<void> {
    assertApprovedPairing(pairing);
    this.pairings.set(pairing.nodeId, clone(pairing));
  }

  async remove(nodeId: string): Promise<void> {
    this.pairings.delete(nodeId);
  }
}

export class RedisApprovedLimbPairingPersistence implements ApprovedLimbPairingPersistence {
  constructor(private readonly redis: Pick<RedisClient, 'hvals' | 'hset' | 'hdel'>) {}

  async list(): Promise<PairingRequest[]> {
    const records = await this.redis.hvals(APPROVED_PAIRINGS_KEY);
    return records.map((raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new TypeError('Corrupt approved limb pairing record');
      }
      if (!isApprovedPairing(parsed)) {
        throw new TypeError('Corrupt approved limb pairing record');
      }
      return clone(parsed);
    });
  }

  async put(pairing: PairingRequest): Promise<void> {
    assertApprovedPairing(pairing);
    // User-visible ownership state is intentionally persistent: no EX/PX.
    await this.redis.hset(APPROVED_PAIRINGS_KEY, pairing.nodeId, JSON.stringify(pairing));
  }

  async remove(nodeId: string): Promise<void> {
    await this.redis.hdel(APPROVED_PAIRINGS_KEY, nodeId);
  }
}

export const ApprovedLimbPairingRedisKeys = {
  approved: APPROVED_PAIRINGS_KEY,
} as const;
