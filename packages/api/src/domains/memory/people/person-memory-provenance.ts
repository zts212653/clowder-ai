import type {
  PersonMemoryResolvedSourceBundle,
  PersonMemorySourceRef,
  ResolvedPersonMemorySource,
} from '@cat-cafe/shared';
import type { StoredPersonMemoryCandidate } from './PersonMemoryStore.js';

function sourceRefOf(source: ResolvedPersonMemorySource): PersonMemorySourceRef {
  if (source.kind === 'message_text' || source.kind === 'message_attachment') return source.sourceRef;
  return source.confirmationSourceRef;
}

export function projectPersonMemorySourceRefs(
  provenance: PersonMemoryResolvedSourceBundle | undefined,
  fallback: PersonMemorySourceRef,
): PersonMemorySourceRef[] {
  if (!provenance) return [fallback];
  const refs = provenance.sources.map(sourceRefOf);
  return refs.filter(
    (ref, index) =>
      refs.findIndex((candidate) => candidate.threadId === ref.threadId && candidate.messageId === ref.messageId) ===
      index,
  );
}

export function selectPersonMemoryTypedProvenance(
  candidate: Pick<StoredPersonMemoryCandidate, 'sourceBundle'>,
  draftIds: Iterable<string>,
): PersonMemoryResolvedSourceBundle | undefined {
  if (!candidate.sourceBundle) return undefined;
  const selectedDraftIds = new Set(draftIds);
  const assertionBindings = candidate.sourceBundle.assertionBindings.filter((binding) =>
    selectedDraftIds.has(binding.target.draftId),
  );
  if (assertionBindings.length === 0) return undefined;
  const selectedSourceIds = new Set(assertionBindings.map((binding) => binding.sourceId));
  return {
    sources: candidate.sourceBundle.sources.filter((source) => selectedSourceIds.has(source.sourceId)),
    assertionBindings,
  };
}
