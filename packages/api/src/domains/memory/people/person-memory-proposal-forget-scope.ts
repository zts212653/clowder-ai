import { createHash } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { StoredPersonMemoryCandidate } from './PersonMemoryStore.js';
import type { PersonMemoryCandidateSnapshot } from './person-memory-disposition-forget.js';
import { PersonMemoryKeys } from './person-memory-keys.js';
import { parseStoredCandidate } from './person-memory-records.js';

const MAX_LINEAGE_HOPS = 32;

function candidatePersonId(candidate: StoredPersonMemoryCandidate): string | undefined {
  return candidate.materializedPersonId ?? candidate.targetPersonId;
}

/** Legacy published closures have no card; staged/tombstoned records were never owner-visible. */
export function isPublishedProposal(candidate: StoredPersonMemoryCandidate): boolean {
  return !candidate.publication || ['anchored', 'legacy_unanchored'].includes(candidate.publication.state);
}

export function proposalForgetRevision(lineage: Map<string, PersonMemoryCandidateSnapshot>): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify([...lineage].map(([id, { raw }]) => [id, raw])))
    .digest('hex')}`;
}

export async function readProposalForgetCandidate(
  redis: RedisClient,
  ownerUserId: string,
  candidateId: string,
): Promise<PersonMemoryCandidateSnapshot | null> {
  const raw = await redis.get(PersonMemoryKeys.candidate(ownerUserId, candidateId));
  const candidate = parseStoredCandidate(raw);
  return raw && candidate && candidate.ownerUserId === ownerUserId && candidate.candidateId === candidateId
    ? { candidate, raw }
    : null;
}

export async function loadProposalForgetLineage(
  redis: RedisClient,
  ownerUserId: string,
  exact: PersonMemoryCandidateSnapshot,
): Promise<Map<string, PersonMemoryCandidateSnapshot> | 'person_bound' | 'conflict'> {
  const reverse: PersonMemoryCandidateSnapshot[] = [];
  const seen = new Set<string>();
  let current: PersonMemoryCandidateSnapshot | null = exact;
  while (current) {
    if (seen.has(current.candidate.candidateId) || reverse.length >= MAX_LINEAGE_HOPS) return 'conflict';
    if (!isPublishedProposal(current.candidate)) return 'conflict';
    if (candidatePersonId(current.candidate) || (current.candidate.approval?.approvedDraftIds.length ?? 0) > 0)
      return 'person_bound';
    seen.add(current.candidate.candidateId);
    reverse.push(current);
    current = current.candidate.replacesProposalId
      ? await readProposalForgetCandidate(redis, ownerUserId, current.candidate.replacesProposalId)
      : null;
    if (reverse.at(-1)?.candidate.replacesProposalId && !current) return 'conflict';
  }
  const root = reverse.at(-1);
  if (!root) return 'conflict';

  const lineage = new Map<string, PersonMemoryCandidateSnapshot>();
  current = root;
  while (current) {
    if (lineage.has(current.candidate.candidateId) || lineage.size >= MAX_LINEAGE_HOPS) return 'conflict';
    if (!isPublishedProposal(current.candidate)) return 'conflict';
    if (candidatePersonId(current.candidate) || (current.candidate.approval?.approvedDraftIds.length ?? 0) > 0)
      return 'person_bound';
    lineage.set(current.candidate.candidateId, current);
    const nextId = current.candidate.replacedByProposalId;
    if (!nextId) break;
    const next = await readProposalForgetCandidate(redis, ownerUserId, nextId);
    if (!next || next.candidate.replacesProposalId !== current.candidate.candidateId) return 'conflict';
    current = next;
  }
  if (!lineage.has(exact.candidate.candidateId)) return 'conflict';
  const values = [...lineage.values()];
  const ancestorsAreWithdrawn = values.slice(0, -1).every((snapshot) => snapshot.candidate.state === 'withdrawn');
  const leafState = values.at(-1)?.candidate.state;
  if (!ancestorsAreWithdrawn || (leafState !== 'rejected' && leafState !== 'withdrawn')) return 'conflict';
  for (const id of lineage.keys()) {
    const [owner, person] = await Promise.all([
      redis.get(PersonMemoryKeys.candidateOwner(id)),
      redis.get(PersonMemoryKeys.candidatePerson(ownerUserId, id)),
    ]);
    if (owner !== ownerUserId) return 'conflict';
    if (person) return 'person_bound';
  }
  return lineage;
}
