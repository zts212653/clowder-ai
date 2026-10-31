/**
 * targetCats resolver (F229 Phase B)
 *
 * Resolves which cat(s) should receive a relay message for a given thread.
 *
 * Priority order (砚砚 P1: fail-closed, never blind-post):
 * 1. User explicitly specified targetCats → use directly
 * 2. Thread recent participants (last 3 non-system messages) → candidates
 * 3. feat_index attribution → candidates
 * 4. Candidates > 1 or == 0 → return candidates with needsSelection=true
 *    (UI shows selection card, user picks)
 * 5. Exactly 1 candidate → auto-select
 */

import type { CatId } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';

export interface TargetCatsResult {
  /** Resolved target cats (empty if needsSelection + no candidates) */
  targetCats: string[];
  /** True if user must manually select (ambiguous or empty candidates) */
  needsSelection: boolean;
  /** Source of resolution for audit trail */
  source: 'explicit' | 'participant' | 'feat_index' | 'ambiguous' | 'none';
}

export interface TargetCatsResolverDeps {
  messageStore: IMessageStore;
  threadStore: IThreadStore;
}

/**
 * Resolve target cats for a relay intent.
 *
 * @param explicitCats - User-specified target cats (e.g. from @mention in their message)
 * @param threadId - Target thread to relay to
 * @param deps - Store dependencies
 */
export async function resolveTargetCats(
  explicitCats: string[] | undefined,
  threadId: string | undefined,
  deps: TargetCatsResolverDeps,
): Promise<TargetCatsResult> {
  // 1. User explicitly specified — validate against registry (cloud P2 fix).
  //    Filter out hallucinated/unknown catIds so they don't reach confirm card.
  //    Guard: skip validation when registry is empty (not yet initialized at startup,
  //    or running in unit tests). Same pattern as cat-config-loader.ts:720.
  if (explicitCats && explicitCats.length > 0) {
    const registryPopulated = catRegistry.getAllIds().length > 0;
    const validCats = registryPopulated ? explicitCats.filter((id) => catRegistry.has(id)) : explicitCats;
    if (validCats.length > 0) {
      return { targetCats: validCats, needsSelection: false, source: 'explicit' };
    }
    // All explicit cats invalid → fall through to participant/none resolution
  }

  // 2. Thread participant resolution
  if (threadId) {
    const participants = await resolveFromParticipants(threadId, deps);
    if (participants.length === 1) {
      return { targetCats: participants, needsSelection: false, source: 'participant' };
    }
    if (participants.length > 1) {
      return { targetCats: participants, needsSelection: true, source: 'ambiguous' };
    }
  }

  // 3. No candidates found
  return { targetCats: [], needsSelection: true, source: 'none' };
}

/**
 * Get recent non-system cat participants from a thread.
 * Returns unique catIds from the last 3 cat messages.
 */
async function resolveFromParticipants(threadId: string, deps: TargetCatsResolverDeps): Promise<string[]> {
  try {
    const participants = await deps.threadStore.getParticipants(threadId);
    // Filter out empty/system entries
    return (participants as CatId[]).filter((id) => id && id !== 'system');
  } catch {
    return [];
  }
}
