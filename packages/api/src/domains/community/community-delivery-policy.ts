/**
 * Community event delivery policy (F168 Phase B — Task 4 skeleton, Task 6 completion)
 *
 * Pure function — zero IO, zero side-effects.
 *
 * Task 4: skeleton that always returns 'wake-owner' (current behaviour preserved).
 * Task 6: full rule table — awaiting_external state + OWNER/MEMBER association silencing.
 */

import type { CommunityEventKind, CommunityObjectState, GitHubAuthorAssociation } from '@cat-cafe/shared';

export type DeliveryDecision = 'wake-owner' | 'silent-log';

export interface DeliveryPolicyInput {
  state: CommunityObjectState;
  eventKind: CommunityEventKind;
  authorAssociation?: GitHubAuthorAssociation;
}

// ---------------------------------------------------------------------------
// Rule constants
// ---------------------------------------------------------------------------

/** GitHub associations treated as "maintainer/internal" — their activity is silent. */
const MAINTAINER_ASSOCIATIONS = new Set<GitHubAuthorAssociation>(['OWNER', 'MEMBER']);

/**
 * Event kinds that are always silent (noise for owners regardless of who authored them).
 * Note: 'issue.labeled' covers both issues.labeled and issues.unlabeled webhook events
 * (payload.action distinguishes them). Label changes represent metadata changes, not
 * discussion, so they are always silent.
 */
const ALWAYS_SILENT_KINDS = new Set<CommunityEventKind>(['issue.labeled']);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decide whether an incoming activity event should wake the owner thread or
 * just append silently to the event log.
 *
 * Rule priority (highest → lowest):
 *  1. Always-silent event kinds (issue.labeled, issue.unlabeled) → silent-log
 *  2. Maintainer author (OWNER/MEMBER) → silent-log
 *  3. All other cases → wake-owner
 *
 * The awaiting_external→in_progress state restoration is handled by the state
 * machine (community-state-machine.ts) separately — this function only decides
 * whether to wake the owner, not whether to change state.
 */
export function decideDelivery(input: DeliveryPolicyInput): DeliveryDecision {
  // Rule 1: event kind is unconditionally silent
  if (ALWAYS_SILENT_KINDS.has(input.eventKind)) {
    return 'silent-log';
  }

  // Rule 2: maintainer-authored activity is silent regardless of case state
  if (input.authorAssociation !== undefined && MAINTAINER_ASSOCIATIONS.has(input.authorAssociation)) {
    return 'silent-log';
  }

  // Rule 3: default — external actor activity wakes the owner
  return 'wake-owner';
}
