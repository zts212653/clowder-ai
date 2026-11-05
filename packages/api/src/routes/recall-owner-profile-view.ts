import {
  assertProfilePathSegment,
  CURRENT_CORPUS_PROFILE_URI,
  CURRENT_RELATIONSHIP_PROFILE_URI,
} from '@cat-cafe/shared/profile-contract';
import { NATIVE_CAPSULE_ANCHOR } from '../domains/memory/profile/native-profile-opening.js';
import type { RecallCandidateView, RecallSourceReaders } from './recall-candidate-view.js';
import type { RecallCueCoordinate } from './recall-cue-view.js';

/** Browser-owner metadata uses the existing owner reader, never the producing model's drill grant. */
export function readOwnerProfileView(
  cue: RecallCueCoordinate,
  ownerUserId: string,
  threadId: string,
  store: RecallSourceReaders['profileMemoryStore'],
): RecallCandidateView | null {
  if (cue.resolver_family !== 'profile' || !store) return null;
  let memoryId: string;
  if (cue.source_anchor === `profile:${CURRENT_CORPUS_PROFILE_URI}`) memoryId = 'corpus';
  else if (
    cue.source_anchor === NATIVE_CAPSULE_ANCHOR ||
    cue.source_anchor === `profile:${CURRENT_RELATIONSHIP_PROFILE_URI}`
  )
    memoryId = 'capsule';
  else if (cue.source_anchor.startsWith('profile:primer:') || cue.source_anchor.startsWith('profile:opening-primer:')) {
    const match = /^profile:(?:opening-)?primer:([^:]+):([^:]+)$/.exec(cue.source_anchor);
    try {
      if (!match || decodeURIComponent(match[2]) !== cue.consumer_cat_id) return unavailable('scope_revoked');
      memoryId = `primer:${assertProfilePathSegment('relationshipKey', decodeURIComponent(match[1]))}`;
    } catch {
      return unavailable('scope_revoked');
    }
  } else return null;
  let entry: ReturnType<typeof store.get>;
  try {
    entry = store.get(ownerUserId, memoryId);
  } catch {
    return { kind: 'profile', titleStatus: 'unavailable', href: null };
  }
  if (!entry || entry.status !== 'active') return unavailable('source_forgotten');
  if (entry.id !== memoryId) return unavailable('scope_revoked');
  if (entry.revision !== cue.source_revision) return unavailable('source_corrected');
  const query = new URLSearchParams({ family: 'profile', memoryId, revision: entry.revision, from: threadId });
  const opening = cue.source_anchor.startsWith('profile:opening-');
  return {
    kind: 'profile',
    title: opening ? `开场递送 · ${entry.title}` : entry.title,
    href: `/memory?${query}`,
    ...(opening ? { profileMemoryId: memoryId } : {}),
  };
}
function unavailable(reason: NonNullable<RecallCandidateView['sourceUnavailableReason']>): RecallCandidateView {
  return { kind: 'profile', titleStatus: 'unavailable', href: null, sourceUnavailableReason: reason };
}
