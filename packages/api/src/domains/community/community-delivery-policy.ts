/**
 * Community event delivery policy (F168 Phase B — Task 4 skeleton, Task 6 completion)
 *
 * Pure function — zero IO, zero side-effects.
 *
 * Association is context, not identity. Exact echo/setup-noise filters live at
 * the connector boundary where identity and trigger correlation are available.
 */

import type {
  CommunityEventKind,
  CommunityObjectState,
  GitHubAuthorAssociation,
  IssueCommentSuppressionReason,
} from '@cat-cafe/shared';

export type DeliveryDecision = 'wake-owner' | 'silent-log';

export interface DeliveryPolicyInput {
  state: CommunityObjectState;
  eventKind: CommunityEventKind;
  authorAssociation?: GitHubAuthorAssociation;
  critical?: boolean;
  suppressionReason?: IssueCommentSuppressionReason;
}

// ---------------------------------------------------------------------------
// Rule constants
// ---------------------------------------------------------------------------

/**
 * Event kinds that are always silent (noise for owners regardless of who authored them).
 * Note: 'issue.labeled' covers both issues.labeled and issues.unlabeled webhook events
 * (payload.action distinguishes them). Label changes represent metadata changes, not
 * discussion, so they are always silent.
 */
const ALWAYS_SILENT_KINDS = new Set<CommunityEventKind>(['issue.labeled']);
const EXACT_SUPPRESSION_REASONS = new Set<IssueCommentSuppressionReason>(['exact_self_echo', 'exact_setup_noise']);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decide whether an incoming activity event should wake the owner thread or
 * just append silently to the event log.
 *
 * Rule priority (highest → lowest):
 *  1. P0/security/data-loss override → wake-owner
 *  2. Exact connector-correlated echo/setup noise → silent-log
 *  3. Always-silent metadata kinds → silent-log
 *  4. All activity, including OWNER/MEMBER → wake-owner
 *
 * The awaiting_external→in_progress state restoration is handled by the state
 * machine (community-state-machine.ts) separately — this function only decides
 * whether to wake the owner, not whether to change state.
 */
export function decideDelivery(input: DeliveryPolicyInput): DeliveryDecision {
  if (input.critical) return 'wake-owner';

  if (input.suppressionReason && EXACT_SUPPRESSION_REASONS.has(input.suppressionReason)) {
    return 'silent-log';
  }

  if (ALWAYS_SILENT_KINDS.has(input.eventKind)) {
    return 'silent-log';
  }
  return 'wake-owner';
}
