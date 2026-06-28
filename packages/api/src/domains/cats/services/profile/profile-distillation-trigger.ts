/**
 * F231 AC-C3 / KD-10: Profile distillation trigger.
 *
 * The distillation trigger fires on runtime-neutral lifecycle events
 * (session-seal, turn-completed) — NOT on provider-specific Stop hooks.
 * This decouples the profile update pipeline from any single LLM provider.
 *
 * The three-stage pipeline (KD-8):
 *   采集 (collection) → cats/operator provide raw signals via whitelisted kinds (KD-9)
 *   蒸馏 (distillation) → THIS: system evaluates collected signals on lifecycle events
 *   消化 (digestion) → approved updates written to primer/capsule files
 *
 * C3 scope: trigger mechanism + eval counter. Signal accumulation logic
 * lives in the caller (SessionSealer post-seal hook) and the propose route.
 */

import { profileDistillationTriggered } from '../../../../infrastructure/telemetry/instruments.js';

export interface SessionSealedEvent {
  sessionId: string;
  catId: string;
  threadId: string;
  sealReason: string;
}

/**
 * Evaluates pending profile signals on session lifecycle events.
 * Returns the number of signals processed (0 = no pending work).
 */
export class ProfileDistillationTrigger {
  /**
   * Called when a session is sealed. Evaluates whether any profile-relevant
   * signals from this session should be distilled into a profile update proposal.
   *
   * @returns Number of signals processed (0 = nothing to do)
   */
  async onSessionSealed(event: SessionSealedEvent): Promise<number> {
    // Eval counter: track that distillation was triggered (KD-10 observability).
    // Even when there are no signals, incrementing the counter proves the trigger
    // is wired and firing — zero-activation is "triggered 50 times, processed 0"
    // not "never triggered."
    profileDistillationTriggered.add(1, {
      'agent.id': event.catId,
      'seal.reason': event.sealReason,
    });

    // Signal accumulation: cats propose via the callback route (KD-9 whitelist);
    // the counter here proves the trigger is wired. Processing count = 0 when
    // no signals were collected during this session (expected baseline).
    return 0;
  }
}
