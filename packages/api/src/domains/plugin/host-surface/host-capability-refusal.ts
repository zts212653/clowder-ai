import type { Capability } from '@clowder-ai/plugin-contract';

/**
 * F202 W2-6b — the Host's own record of which errors are its refusals of a capability a plugin was
 * not granted, so a failed start can say what was missing.
 *
 * A refusal is thrown exactly as before: same class, code and text, so the plugin sees no
 * difference. Only Host code registers one, and nothing here reads error text, so an error a plugin
 * makes up — whatever it says — never passes for a Host refusal.
 */
const refusals = new WeakMap<object, Capability>();

/** Registers `error` as the Host refusing `capability`, and returns it for the refusal site to throw. */
export function hostCapabilityRefusal<E extends Error>(error: E, capability: Capability): E {
  refusals.set(error, capability);
  return error;
}

/** The capability this very object refused, when it is a registered Host refusal. */
export function registeredRefusal(error: object): Capability | undefined {
  return refusals.get(error);
}

/** How many errors one lookup inspects at most; a start failure is never deeper than a few layers. */
const MAX_INSPECTED = 32;

/**
 * Errors nested in `candidate`: its `cause`, and what an `AggregateError` collected (a failed start
 * rolls back and may report both). The candidate may be anything a plugin threw, so a property that
 * cannot be read counts as nothing nested.
 */
function nestedErrors(candidate: object): readonly unknown[] {
  try {
    const nested: unknown[] = [];
    if ('cause' in candidate) nested.push(candidate.cause);
    if (candidate instanceof AggregateError && Array.isArray(candidate.errors)) {
      nested.push(...candidate.errors.slice(0, MAX_INSPECTED));
    }
    return nested;
  } catch {
    return [];
  }
}

/**
 * The capability of the first Host refusal found in `error`, its causes, or the errors it
 * aggregates — breadth-first, bounded, and safe against cycles. `undefined` when there is none.
 */
export function refusedHostCapability(error: unknown): Capability | undefined {
  const pending: unknown[] = [error];
  const inspected = new Set<object>();
  while (pending.length > 0 && inspected.size < MAX_INSPECTED) {
    const candidate = pending.shift();
    if (typeof candidate !== 'object' || candidate === null || inspected.has(candidate)) continue;
    inspected.add(candidate);
    const capability = refusals.get(candidate);
    if (capability !== undefined) return capability;
    pending.push(...nestedErrors(candidate));
  }
  return undefined;
}
