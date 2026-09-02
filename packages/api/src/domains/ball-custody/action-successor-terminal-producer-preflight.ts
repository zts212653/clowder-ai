/**
 * F167 — Terminal producer capability preflight for ActionSuccessor admission.
 *
 * Verifies that every holder cat can actually produce the typed terminal
 * predicate required by the action (e.g. `review_delivered` via MCP tools).
 *
 * Fail-closed: if ANY holder's terminal producer capability is `unavailable`,
 * the admission is rejected before a lease is created, preventing permanently
 * stranded active leases.
 *
 * Backwards compatible: when `holderTerminalProducerCapabilities` is omitted
 * (legacy callers), the preflight is skipped (allow).
 */

export type TerminalProducerCapabilityStatus = 'available' | 'unavailable' | 'undeclared';

export interface TerminalProducerCapability {
  readonly status: TerminalProducerCapabilityStatus;
  readonly provider: string;
  readonly carrier: string;
  readonly reason?: string;
}

/**
 * Injected resolver that maps a catId to its terminal producer capability.
 * Implemented by AgentRouter; injected into ActionSuccessorAdmissionService
 * so ALL admission paths (claim, replace, continueFreshRevision) get the
 * preflight check — not just the callback routes that pass it explicitly.
 */
export interface TerminalProducerCapabilityResolver {
  resolve(catId: string): TerminalProducerCapability;
}

export type TerminalProducerPreflightResult =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly incapableCatIds: readonly string[];
      readonly capabilities: Readonly<Record<string, TerminalProducerCapability>>;
    };

/**
 * Fail-closed check: every holder must have `status: 'available'` (or
 * `'undeclared'` for carriers that haven't declared yet — legacy tolerance).
 *
 * Returns `{ allow: false }` when any holder has `status: 'unavailable'`,
 * meaning the carrier demonstrably cannot produce the required terminal.
 */
export function preflightTerminalProducerCapability(input: {
  readonly holderCatIds: readonly string[];
  readonly holderTerminalProducerCapabilities: Readonly<Record<string, TerminalProducerCapability>>;
}): TerminalProducerPreflightResult {
  const incapableCatIds: string[] = [];
  const incapableCapabilities: Record<string, TerminalProducerCapability> = {};

  for (const catId of input.holderCatIds) {
    const capability = input.holderTerminalProducerCapabilities[catId];
    if (capability?.status === 'unavailable') {
      incapableCatIds.push(catId);
      incapableCapabilities[catId] = capability;
    }
  }

  if (incapableCatIds.length > 0) {
    return { allow: false, incapableCatIds, capabilities: incapableCapabilities };
  }
  return { allow: true };
}
