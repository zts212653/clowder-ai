import type { RedisClient } from '@cat-cafe/shared/utils';
import type { StoredPersonMemoryCandidate, StoredPersonMemorySettledCandidate } from './PersonMemoryStore.js';
import { PersonMemoryKeys } from './person-memory-keys.js';
import { parseStoredCandidate } from './person-memory-records.js';

async function readCandidates(redis: RedisClient, ownerUserId: string, ids: string[]) {
  return Promise.all(
    ids.map((candidateId) =>
      redis.get(PersonMemoryKeys.candidate(ownerUserId, candidateId)).then(parseStoredCandidate),
    ),
  );
}

export async function listPendingPersonMemoryCandidates(
  redis: RedisClient,
  ownerUserId: string,
  limit: number,
): Promise<StoredPersonMemoryCandidate[]> {
  const ids = await redis.zrevrange(PersonMemoryKeys.pending(ownerUserId), 0, Math.max(0, limit - 1));
  const candidates = await readCandidates(redis, ownerUserId, ids);
  return candidates.filter(
    (candidate): candidate is StoredPersonMemoryCandidate =>
      candidate !== null &&
      candidate.publication.state === 'anchored' &&
      (candidate.state === 'pending_approval' ||
        candidate.state === 'not_now' ||
        candidate.state === 'partially_materialized'),
  );
}

export async function listSettledPersonMemoryCandidates(
  redis: RedisClient,
  ownerUserId: string,
  limit: number,
): Promise<StoredPersonMemorySettledCandidate[]> {
  const raw = await redis.zrevrange(PersonMemoryKeys.settled(ownerUserId), 0, Math.max(0, limit - 1), 'WITHSCORES');
  const records = await Promise.all(
    Array.from({ length: Math.floor(raw.length / 2) }, async (_, index) => {
      const candidateId = raw[index * 2];
      const score = Number(raw[index * 2 + 1]);
      if (!candidateId || !Number.isFinite(score)) return null;
      const [candidate] = await readCandidates(redis, ownerUserId, [candidateId]);
      if (!candidate || (candidate.state !== 'materialized' && candidate.state !== 'rejected')) return null;
      return { candidate, decidedAt: score };
    }),
  );
  return records.filter((record): record is NonNullable<typeof record> => record !== null);
}
