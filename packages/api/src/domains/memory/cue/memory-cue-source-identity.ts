import type { CueEnvelopeV1 } from '@cat-cafe/shared';
import { projectCueCoordinate } from './sources/ContextProjectCueSource.js';

/** One source identity across catalog entries. Revisions remain a separate ledger axis. */
export function memoryCueSourceIdentity(
  cue: Pick<CueEnvelopeV1, 'resolverFamily' | 'source'>,
  consumerCatId?: string,
): string {
  const coordinate = projectCueCoordinate(cue.source.anchor);
  const anchor = coordinate
    ? `${coordinate.collectionId}:${coordinate.anchor}`
    : cue.resolverFamily === 'project_knowledge' && /^F\d+$/.test(cue.source.anchor)
      ? `project:cat-cafe:${cue.source.anchor}`
      : cue.source.anchor;
  // Keep the historical overview identity because F296's closed clue proof binds it exactly.
  return `memory-cue:${cue.resolverFamily}:${anchor}${cue.resolverFamily === 'profile' || cue.resolverFamily === 'project_knowledge' ? `:consumer:${consumerCatId ?? ''}` : ''}`;
}
