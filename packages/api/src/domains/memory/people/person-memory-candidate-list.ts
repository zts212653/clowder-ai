import type { RedisClient } from '@cat-cafe/shared/utils';
import { readRedisSettledPage } from '../../../utils/redis-settled-page.js';
import type { SettledHistoryPageOptions } from '../../../utils/settled-history-page.js';
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
  await preparePersonHistory(redis);
  const raw = await redis.zrevrange(PersonMemoryKeys.settled(ownerUserId), 0, Math.max(0, limit - 1), 'WITHSCORES');
  const records = await Promise.all(
    Array.from({ length: Math.floor(raw.length / 2) }, async (_, index) => {
      const candidateId = raw[index * 2];
      const score = Number(raw[index * 2 + 1]);
      if (!candidateId || !Number.isFinite(score)) return null;
      const [candidate] = await readCandidates(redis, ownerUserId, [candidateId]);
      if (
        !candidate ||
        candidate.ownerUserId !== ownerUserId ||
        candidate.publication.state !== 'anchored' ||
        (candidate.state !== 'materialized' && candidate.state !== 'rejected' && candidate.state !== 'withdrawn')
      )
        return null;
      return { candidate, decidedAt: score };
    }),
  );
  return records.filter((record): record is NonNullable<typeof record> => record !== null);
}

import { advanceSettledIndex, SettledIndexPreparingError } from '../../../utils/redis-settled-index.js';

async function preparePersonHistory(redis: RedisClient) {
  const ready = await advanceSettledIndex(redis, {
    progressKey: 'person-memory:history-index:v2',
    prefix: 'person-memory:candidate:',
    type: 'string',
    entry: async (raw, key) => {
      const candidate = parseStoredCandidate(typeof raw === 'string' ? raw : null);
      if (!candidate || key !== PersonMemoryKeys.candidate(candidate.ownerUserId, candidate.candidateId))
        throw new Error('person memory history identity mismatch');
      if (
        candidate.publication.state !== 'anchored' ||
        !['materialized', 'rejected', 'withdrawn'].includes(candidate.state)
      )
        return null;
      let score =
        candidate.state === 'withdrawn'
          ? (candidate.closedAt ?? candidate.latestUndoReceipt?.undoneAt)
          : candidate.state === 'materialized'
            ? candidate.latestDecisionReceipt?.decidedAt
            : candidate.humanDispositionLedgerEntry?.episode.decidedAt;
      if (score === undefined && candidate.replacedByProposalId) {
        const successor = parseStoredCandidate(
          await redis.get(PersonMemoryKeys.candidate(candidate.ownerUserId, candidate.replacedByProposalId)),
        );
        if (successor?.ownerUserId === candidate.ownerUserId && successor.replacesProposalId === candidate.candidateId)
          score = successor.presentedAt ?? successor.createdAt;
      }
      if (score === undefined && candidate.state === 'rejected') {
        const suppression = await redis.get(PersonMemoryKeys.suppression(candidate.ownerUserId, candidate.candidateId));
        if (suppression) score = (JSON.parse(suppression) as { createdAt?: number }).createdAt;
      }
      return {
        indexKey: PersonMemoryKeys.settled(candidate.ownerUserId),
        id: candidate.candidateId,
        score: score ?? 0,
      };
    },
  });
  if (!ready) throw new SettledIndexPreparingError();
}

export async function pageSettledPersonMemoryCandidates(
  redis: RedisClient,
  owner: string,
  options: SettledHistoryPageOptions,
) {
  await preparePersonHistory(redis);
  return readRedisSettledPage(redis, PersonMemoryKeys.settled(owner), options, async (id, decidedAt) => {
    const [candidate] = await readCandidates(redis, owner, [id]);
    if (!candidate) return null;
    if (
      candidate.candidateId !== id ||
      candidate.ownerUserId !== owner ||
      candidate.publication.state !== 'anchored' ||
      !['materialized', 'rejected', 'withdrawn'].includes(candidate.state)
    )
      throw new Error('Settled index canonical identity/owner/status mismatch');
    return { candidate, decidedAt };
  });
}
