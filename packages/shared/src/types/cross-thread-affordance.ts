/**
 * Cross-Thread Affordance Types (F193 Phase E)
 *
 * Shared types for cross-thread information dispatch:
 * - E1 dispatch gate (create_task warning)
 * - E2 affordance hint (search_evidence / list_recent suggested_action)
 * - E4 feat_index owner enrichment
 *
 * All three subsystems share the same SuggestedCrossPostAction shape
 * so cats see a consistent prompt regardless of which tool surfaces it.
 */

export type SuggestedCrossPostActionSource = 'dispatch_gate' | 'search_evidence' | 'list_recent' | 'feat_index';

/**
 * Suggested action when a cross-scope discovery needs dispatching.
 * Shared across E1 (dispatch gate), E2 (affordance hint), E4 (feat_index).
 */
export interface SuggestedCrossPostAction {
  readonly type: 'cross_post';
  readonly threadId?: string;
  readonly featureId?: string;
  readonly ownerCatId?: string;
  readonly targetCats?: readonly string[];
  readonly reason?: string;
  /** Which tool/subsystem produced this suggestion */
  readonly source: SuggestedCrossPostActionSource;
}

/**
 * Dispatch gate state for cross-feature tasks (E1).
 * - 'missing': external F-ID detected but cat didn't provide gate decision
 *   (persisted for later list_tasks highlighting)
 * - 'dispatched': cat confirmed the info was cross-posted to the owning thread
 * - 'not_dispatched': cat explicitly decided not to dispatch (must provide reason)
 */
export interface DispatchGateState {
  readonly status: 'missing' | 'dispatched' | 'not_dispatched';
  readonly dispatchedThreadId?: string;
  readonly dispatchedMessageId?: string;
  /** Required when status = 'not_dispatched' */
  readonly reason?: string;
  readonly suggestedAction?: SuggestedCrossPostAction;
  readonly decidedAt?: number;
}

// --- Utilities ---

const FEATURE_ID_PATTERN = /\b[Ff](\d{2,4})\b/g;

/**
 * Extract feature IDs (F123, f42, etc.) from text. Case-insensitive.
 * Returns deduplicated, sorted array of uppercase F-IDs (e.g. ["F42", "F193"]).
 */
export function extractFeatureIds(text: string): string[] {
  const matches = text.matchAll(FEATURE_ID_PATTERN);
  const ids = new Set<string>();
  for (const m of matches) {
    ids.add(`F${m[1]}`);
  }
  return [...ids].sort();
}
