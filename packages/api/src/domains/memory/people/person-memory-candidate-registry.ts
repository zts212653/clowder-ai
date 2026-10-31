import { type PersonMemorySuppressionToken, personMemorySuppressionTokenSchema } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { StoredPersonMemoryCandidate } from './PersonMemoryStore.js';
import { normalizePrivateAlias, PersonMemoryKeys } from './person-memory-keys.js';

type CandidateLoader = (candidateId: string) => Promise<StoredPersonMemoryCandidate | null>;

export function candidateSubjectRefs(candidate: StoredPersonMemoryCandidate): string[] {
  if (!candidate.personDraft) return [];
  return [
    ...new Set(
      [candidate.personDraft.displayName, ...candidate.personDraft.privateAliases]
        .map(normalizePrivateAlias)
        .filter(Boolean),
    ),
  ];
}

export async function resolvePendingPersonCandidateBySubject(
  redis: RedisClient,
  ownerUserId: string,
  subject: string,
  loadCandidate: CandidateLoader,
): Promise<StoredPersonMemoryCandidate | null> {
  const normalizedSubject = normalizePrivateAlias(subject);
  if (!normalizedSubject) return null;
  const ids = await redis.zrevrange(PersonMemoryKeys.pending(ownerUserId), 0, -1);
  for (const id of ids) {
    const candidate = await loadCandidate(id);
    if (
      !candidate ||
      candidate.publication.state !== 'anchored' ||
      (candidate.state !== 'pending_approval' &&
        candidate.state !== 'not_now' &&
        candidate.state !== 'partially_materialized')
    ) {
      throw new Error('pending candidate index is inconsistent');
    }
    if (candidateSubjectRefs(candidate).includes(normalizedSubject)) return candidate;
  }
  return null;
}

export async function resolveDormantPersonCandidateBySubject(
  redis: RedisClient,
  ownerUserId: string,
  subject: string,
): Promise<PersonMemorySuppressionToken | null> {
  const normalizedSubject = normalizePrivateAlias(subject);
  if (!normalizedSubject) return null;
  const candidateIds = await redis.smembers(PersonMemoryKeys.suppressionSubject(ownerUserId, normalizedSubject));
  const tokens = (
    await Promise.all(
      candidateIds.map(async (candidateId) => {
        const raw = await redis.get(PersonMemoryKeys.suppression(ownerUserId, candidateId));
        if (!raw) return null;
        const token = personMemorySuppressionTokenSchema.safeParse(JSON.parse(raw));
        return token.success && token.data.subjectRefs.includes(normalizedSubject) ? token.data : null;
      }),
    )
  ).filter((token): token is PersonMemorySuppressionToken => token !== null);
  if (candidateIds.length > 0 && tokens.length === 0) {
    throw new Error('dormant suppression index is inconsistent');
  }
  return (
    tokens.sort(
      (left, right) => right.createdAt - left.createdAt || left.candidateId.localeCompare(right.candidateId),
    )[0] ?? null
  );
}
