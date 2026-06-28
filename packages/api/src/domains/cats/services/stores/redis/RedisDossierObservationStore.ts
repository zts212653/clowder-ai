/**
 * F208 Phase D: Redis-backed operator dossier observation store.
 *
 * AC-D1: operator observations stored in Redis pending layer.
 * OQ-10: Phase D = staging + read display; promotion to summary layer in Phase E.
 * Iron Rule #5 (LL-048): TTL=0 by default — user-visible state persists.
 *
 * Pattern: sorted set (per-cat time index) + hash (observation detail).
 * Follows project convention (per TaskKeys / ProfileUpdateProposalKeys).
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { nanoid } from 'nanoid';
import type {
  AddDossierObservationInput,
  DossierObservation,
  IDossierObservationStore,
} from '../ports/DossierObservationStore.js';
import { DossierObservationKeys } from '../redis-keys/dossier-observation-keys.js';

const DEFAULT_LIST_LIMIT = 100;

export class RedisDossierObservationStore implements IDossierObservationStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async add(input: AddDossierObservationInput): Promise<DossierObservation> {
    const now = Date.now();
    const id = `obs_${nanoid(12)}`;
    const obs: DossierObservation = {
      id,
      catId: input.catId,
      content: input.content,
      provenance: {
        type: 'cvo',
        author: input.author,
        date: new Date(now).toISOString().slice(0, 10),
      },
      createdAt: now,
    };

    const detailKey = DossierObservationKeys.detail(id);
    const indexKey = DossierObservationKeys.catIndex(input.catId);

    const pipeline = this.redis.multi();
    pipeline.hset(detailKey, ...serialize(obs));
    // TTL=0 (no expire) — Iron Rule #5: user state persists by default
    pipeline.zadd(indexKey, String(now), id);
    await pipeline.exec();

    return obs;
  }

  async list(catId: string, limit: number = DEFAULT_LIST_LIMIT): Promise<DossierObservation[]> {
    const indexKey = DossierObservationKeys.catIndex(catId);
    // Newest first: ZREVRANGE returns highest score (most recent) first
    const ids = await this.redis.zrevrange(indexKey, 0, Math.max(0, limit) - 1);
    if (!ids.length) return [];
    return this.hydrateMany(ids);
  }

  async listAll(limit: number = DEFAULT_LIST_LIMIT): Promise<Record<string, DossierObservation[]>> {
    // Discover all cat indices via SCAN (keyPrefix is applied by ioredis)
    const prefix = resolveKeyPrefix(this.redis);
    const pattern = `${prefix}dossier-obs:cat:*`;
    const catKeys: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', '100');
      cursor = next;
      for (const k of keys) {
        catKeys.push(k);
      }
    } while (cursor !== '0');

    if (!catKeys.length) return {};

    const grouped: Record<string, DossierObservation[]> = {};
    for (const fullKey of catKeys) {
      // Strip prefix to get the logical key, then extract catId
      const logicalKey = fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey;
      const catId = logicalKey.replace('dossier-obs:cat:', '');
      const ids = await this.redis.zrevrange(
        fullKey.startsWith(prefix) ? logicalKey : fullKey,
        0,
        Math.max(0, limit) - 1,
      );
      if (ids.length) {
        const obs = await this.hydrateMany(ids);
        if (obs.length) grouped[catId] = obs;
      }
    }
    return grouped;
  }

  async get(id: string): Promise<DossierObservation | null> {
    const data = await this.redis.hgetall(DossierObservationKeys.detail(id));
    if (!data || !data.id) return null;
    return hydrate(data);
  }

  async delete(id: string): Promise<boolean> {
    const obs = await this.get(id);
    if (!obs) return false;
    const pipeline = this.redis.multi();
    pipeline.del(DossierObservationKeys.detail(id));
    pipeline.zrem(DossierObservationKeys.catIndex(obs.catId), id);
    await pipeline.exec();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async hydrateMany(ids: string[]): Promise<DossierObservation[]> {
    const results: DossierObservation[] = [];
    for (const id of ids) {
      const obs = await this.get(id);
      if (obs) results.push(obs);
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Serialization (flat string pairs for HSET)
// ---------------------------------------------------------------------------

function serialize(obs: DossierObservation): string[] {
  return [
    'id',
    obs.id,
    'catId',
    obs.catId,
    'content',
    obs.content,
    'provenanceType',
    obs.provenance.type,
    'provenanceAuthor',
    obs.provenance.author,
    'provenanceDate',
    obs.provenance.date,
    'createdAt',
    String(obs.createdAt),
  ];
}

function hydrate(data: Record<string, string>): DossierObservation {
  return {
    id: data.id,
    catId: data.catId,
    content: data.content,
    provenance: {
      type: (data.provenanceType as 'cvo') || 'cvo',
      author: data.provenanceAuthor || '',
      date: data.provenanceDate || '',
    },
    createdAt: Number(data.createdAt) || 0,
  };
}

function resolveKeyPrefix(redis: RedisClient): string {
  return (redis.options as { keyPrefix?: string }).keyPrefix ?? '';
}
