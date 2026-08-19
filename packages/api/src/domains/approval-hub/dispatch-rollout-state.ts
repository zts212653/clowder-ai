/**
 * F246 Phase J: Dispatch proposal rollout state machine.
 *
 * State machine: shadow → required ⇄ frozen
 * Ratchet: once in `required`, cannot return to `shadow`.
 * Frozen has highest priority (fail-secure kill switch).
 *
 * Task 0 provides the type + default getter (always `shadow`).
 * Task 2 will wire Redis-backed state persistence + transition API.
 */

export type DispatchRolloutState = 'shadow' | 'required' | 'frozen';

/**
 * Returns the current rollout state. Task 0 止血: hardcoded to 'shadow'.
 * Task 2 will replace with Redis-backed state lookup.
 */
export function getDefaultDispatchRolloutState(): DispatchRolloutState {
  return 'shadow';
}

/**
 * Determines whether a dispatch proposal is "legacy" (pre-Phase-J, no ActionEnvelope).
 * A legacy proposal lacks the `envelopeDigest` field, meaning it was created through
 * the old message-only dispatch path rather than the structured ActionEnvelope ingress.
 *
 * In `required` rollout mode, legacy proposals cannot be approved — only rejected
 * or resubmitted through the new ingress (AC-J8, KD-17).
 */
export function isLegacyDispatchProposal(proposal: { envelopeDigest?: string }): boolean {
  return !proposal.envelopeDigest;
}
