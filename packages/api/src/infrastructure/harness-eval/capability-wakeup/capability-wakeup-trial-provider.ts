import type { ClassifiedCapabilityWakeupTrial } from './eval-capability-wakeup-adapter.js';

/**
 * F192 Phase H 收尾 — contract alignment with砚砚 R0 (Path B narrowing).
 *
 * Capability-wakeup trials don't have stable IDs or a durable store yet; cat-mediated
 * publish needs a stable way to rehydrate trials from a query (so the handler can pass
 * fresh trials into `generateCapabilityWakeupLiveVerdict`'s `submittedPacket` flow
 * without trusting cat to enumerate them).
 *
 * The selector shape uses **window range**, not trial IDs (砚砚 R0: trialIds is
 * 伪精确 without durable IDs; window range is the only honest cat-facing source ref
 * we can lock today). Future-add `{kind: 'capability-wakeup-trial-ids', trialIds}`
 * when a trial store / stable IDs ship.
 */
export interface CapabilityWakeupTrialWindowSelector {
  kind: 'capability-wakeup-trial-window';
  capability: string;
  /** Inclusive — trials with `t >= windowStartMs` qualify. */
  windowStartMs: number;
  /** Exclusive — trials with `t < windowEndMs` qualify. Must be > windowStartMs. */
  windowEndMs: number;
  /** Optional narrowing: restrict to specific session IDs. */
  sessionIds?: string[];
  /** Optional narrowing: restrict to specific rule IDs. */
  ruleIds?: string[];
}

/** Stub for future trial-id selector (no durable store yet — see砚砚 R0). */
export interface CapabilityWakeupTrialIdsSelector {
  kind: 'capability-wakeup-trial-ids';
  trialIds: string[];
}

export type CapabilityWakeupSourceSelector = CapabilityWakeupTrialWindowSelector | CapabilityWakeupTrialIdsSelector;

export interface CapabilityWakeupResolveScope {
  ownerUserId?: string;
}

/**
 * Provider interface — handler dispatches selector → provider rehydrates trials.
 * PR-1a scope: define interface + fake-provider unit test, NO real query impl
 * (real backing store is a separate PR). Handler can't safely wire `eval:capability-wakeup`
 * into `PUBLISH_VERDICT_SUPPORTED_DOMAINS` until a real provider lands.
 */
export interface CapabilityWakeupTrialProvider {
  resolve(
    selector: CapabilityWakeupSourceSelector,
    scope?: CapabilityWakeupResolveScope,
  ): Promise<ClassifiedCapabilityWakeupTrial[]>;
}

/** Validates selector shape. Returns error message string OR null when ok. */
export function validateCapabilityWakeupSelector(selector: unknown): string | null {
  if (!selector || typeof selector !== 'object') return 'selector must be an object';
  const s = selector as Record<string, unknown>;
  if (s.kind === 'capability-wakeup-trial-window') {
    if (typeof s.capability !== 'string' || !s.capability) return 'capability must be non-empty string';
    if (typeof s.windowStartMs !== 'number' || !Number.isFinite(s.windowStartMs)) {
      return 'windowStartMs must be finite number';
    }
    if (typeof s.windowEndMs !== 'number' || !Number.isFinite(s.windowEndMs)) {
      return 'windowEndMs must be finite number';
    }
    if (s.windowEndMs <= s.windowStartMs) return 'windowEndMs must be > windowStartMs';
    if (/[\r\n]/.test(s.capability)) return 'capability must not contain newlines (markdown bullet injection)';
    // 砚砚 R1 P2: validate element shape, not just array. Future provider must not
    // see [42] / ['ok', ''] / [null] as "validated input" → arbitrary downstream crash.
    if (s.sessionIds !== undefined) {
      if (!Array.isArray(s.sessionIds)) return 'sessionIds must be array if provided';
      if (s.sessionIds.some((id) => typeof id !== 'string' || !id))
        return 'sessionIds entries must be non-empty strings';
    }
    if (s.ruleIds !== undefined) {
      if (!Array.isArray(s.ruleIds)) return 'ruleIds must be array if provided';
      if (s.ruleIds.some((id) => typeof id !== 'string' || !id)) return 'ruleIds entries must be non-empty strings';
    }
    return null;
  }
  if (s.kind === 'capability-wakeup-trial-ids') {
    if (!Array.isArray(s.trialIds) || s.trialIds.length === 0) return 'trialIds must be non-empty array';
    if (s.trialIds.some((id) => typeof id !== 'string' || !id)) return 'trialIds entries must be non-empty strings';
    return null;
  }
  return `unknown selector kind: ${JSON.stringify(s.kind)}`;
}
