import { estimateTokens } from '../../../../../utils/token-counter.js';
import type { ContextPresentationEnvelope } from '../../session/context/context-presentation.js';

interface Item<T> {
  envelope: ContextPresentationEnvelope<T>;
  promptSegment: string;
}
function cue<T>(item: Item<T>): boolean {
  return (
    item.envelope.admission.entryVersion.startsWith('recall-catalog:') && item.envelope.candidate.sourceTier === 'T2'
  );
}
function priority<T>(item: Item<T>): number {
  const entry = item.envelope.admission.entryVersion;
  const context = /:(fresh_context_sources|authorized_task_sources):/.test(entry);
  if (context) return item.envelope.candidate.subjectKey.startsWith('memory-cue:profile:') ? 1 : 3;
  if (entry.includes(':profile_revision_available:')) return 2;
  if (item.envelope.candidate.subjectKey.startsWith('memory-cue:thread_overview:')) return 4;
  return 0;
}

export function memoryCuePresentationKey<T>(envelope: ContextPresentationEnvelope<T>): string {
  const { subjectKey, asOf } = envelope.candidate;
  return JSON.stringify([subjectKey, asOf.kind, asOf.value]);
}

/** Apply source de-duplication and actual mapped-byte capacity, leaving T0/T1 untouched. */
export function selectMemoryCueCapacity<T, I extends Item<T>>(
  items: readonly I[],
): { selected: I[]; omitted: I[]; duplicates: I[] } {
  const ordered = items.filter(cue).sort((a, b) => priority(a) - priority(b));
  const accepted = new Set<I>();
  const seen = new Set<string>();
  const duplicates: I[] = [];
  const byEntry = new Map<string, string[]>();
  const combined: string[] = [];
  for (const item of ordered) {
    const { admission } = item.envelope;
    const key = memoryCuePresentationKey(item.envelope);
    if (seen.has(key)) {
      duplicates.push(item);
      continue;
    }
    seen.add(key);
    const blocks = [...(byEntry.get(admission.opportunityId) ?? []), item.promptSegment];
    if (
      accepted.size >= 6 ||
      estimateTokens([...combined, item.promptSegment].join('\n\n')) > 6000 ||
      estimateTokens(blocks.join('\n\n')) > admission.tokenBudget
    )
      continue;
    accepted.add(item);
    combined.push(item.promptSegment);
    byEntry.set(admission.opportunityId, blocks);
  }
  return {
    selected: [...items.filter((item) => !cue(item)), ...ordered.filter((item) => accepted.has(item))],
    omitted: ordered.filter((item) => !accepted.has(item)),
    duplicates,
  };
}
