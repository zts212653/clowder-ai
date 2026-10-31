import {
  PERSON_MEMORY_INTERACTION_EVIDENCE_FIELDS,
  PERSON_MEMORY_LIMITS,
  type PersonMemoryInformedEvidence,
  type PersonMemoryResolvedSourceBundle,
  type PersonMemorySourceRef,
  type ResolvedPersonMemorySource,
} from '@cat-cafe/shared';
import { estimateTokens } from '../../../utils/token-counter.js';
import type { StoredPersonMemoryCandidate } from './PersonMemoryStore.js';

function truncateToTokenLimit(value: string, maxTokens: number): string {
  if (estimateTokens(value) <= maxTokens) return value;
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (estimateTokens(characters.slice(0, midpoint).join('')) <= maxTokens) low = midpoint;
    else high = midpoint - 1;
  }
  return characters.slice(0, low).join('').trim();
}

function sourceExcerpt(source: ResolvedPersonMemorySource): string {
  if (source.kind === 'message_text') return source.excerpt;
  if (source.kind === 'message_attachment') return source.boundedTranscript;
  if (source.kind === 'owner_confirmed_transcript') return source.transcript;
  return source.boundedExcerpt;
}

function drillSourceRef(source: ResolvedPersonMemorySource): PersonMemorySourceRef | undefined {
  if (source.kind === 'message_text' || source.kind === 'message_attachment') return source.sourceRef;
  return source.confirmationSourceRef;
}

export function projectPersonMemoryInteractionInformedEvidence(
  bundle: PersonMemoryResolvedSourceBundle | undefined,
  draftId: string,
): PersonMemoryInformedEvidence[] {
  if (!bundle) return [];
  const bindingsBySource = new Map<
    string,
    {
      roles: Set<PersonMemoryInformedEvidence['assertionRoles'][number]>;
      fields: Set<PersonMemoryInformedEvidence['targetFields'][number]>;
    }
  >();
  for (const binding of bundle.assertionBindings) {
    if (binding.target.kind !== 'interaction' || binding.target.draftId !== draftId) continue;
    const group = bindingsBySource.get(binding.sourceId) ?? { roles: new Set(), fields: new Set() };
    group.roles.add(binding.role);
    group.fields.add(binding.target.field);
    bindingsBySource.set(binding.sourceId, group);
  }
  return bundle.sources.flatMap((source) => {
    const group = bindingsBySource.get(source.sourceId);
    if (!group || group.fields.size === 0) return [];
    const boundedExcerpt = truncateToTokenLimit(sourceExcerpt(source), PERSON_MEMORY_LIMITS.maxEvidenceExcerptTokens);
    if (!boundedExcerpt) return [];
    const targetFields = PERSON_MEMORY_INTERACTION_EVIDENCE_FIELDS.filter((field) => group.fields.has(field));
    const sourceRef = drillSourceRef(source);
    return [
      {
        sourceId: source.sourceId,
        sourceKind: source.kind,
        assertionRoles: [...group.roles],
        targetFields,
        boundedExcerpt,
        ...(source.kind === 'owner_confirmed_transcript' ? { confirmationScope: source.confirmationScope } : {}),
        ...(sourceRef ? { drillSourceRef: sourceRef } : {}),
      },
    ];
  });
}

export function projectCandidateInteractionInformedEvidence(
  candidate: StoredPersonMemoryCandidate,
  draftId: string,
): PersonMemoryInformedEvidence[] {
  return projectPersonMemoryInteractionInformedEvidence(candidate.sourceBundle, draftId);
}
