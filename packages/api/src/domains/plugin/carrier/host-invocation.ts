import type { M0CDeliverInput, M0CDeliverResult } from '@clowder-ai/plugin-contract';

/** The Host's one carrier-neutral way to invoke an action exposed by an active plugin. */
export interface HostPluginInvocationPort {
  invoke(targetId: string, method: string, params: unknown): Promise<unknown>;
  deliver(targetId: string, input: M0CDeliverInput): Promise<M0CDeliverResult>;
}

/** The published Host→plugin messaging row, independent of its runtime carrier. */
export type HostMessagingDeliveryPort = Pick<HostPluginInvocationPort, 'deliver'>;

/**
 * F202 W2-3 h3b — whether a failed Host→plugin call could have had an effect.
 *
 * - `not_started`: the Host refused before any package code ran for this call (no runnable
 *   instance, no carrier or invocation surface, no loaded module, no such action), so the package
 *   cannot have acted on it.
 * - `unknown`: the package's action was entered, or the carrier cannot tell, so it may have acted.
 *
 * Each carrier reports the boundary it owns: the module carrier at the action call; a process
 * carrier would do it at the frame write. A carrier that does not report it is `unknown`
 * throughout, so nothing is ever called "not started" without the Host proving it for this call.
 */
export type PluginInvocationEffect = 'not_started' | 'unknown';

export type PluginInvocationOutcome =
  | { readonly status: 'returned'; readonly value: unknown }
  | { readonly status: 'failed'; readonly effect: PluginInvocationEffect; readonly error: unknown };

/** A refusal the Host made before any package code ran for this call. */
export function invocationNotStarted(error: unknown): PluginInvocationOutcome {
  return { status: 'failed', effect: 'not_started', error };
}

/** A failure after which the package may have acted. */
function invocationEffectUnknown(error: unknown): PluginInvocationOutcome {
  return { status: 'failed', effect: 'unknown', error };
}

/** Runs package code (or a carrier that cannot tell where it failed): every failure is `unknown`. */
export async function attemptPluginAction(run: () => unknown): Promise<PluginInvocationOutcome> {
  try {
    return { status: 'returned', value: await run() };
  } catch (error) {
    return invocationEffectUnknown(error);
  }
}

/**
 * Runs a lower layer's own attempt. If that attempt itself breaks (throws, synchronously or not,
 * instead of reporting), nothing proves the package was not reached, so the effect is `unknown`.
 */
export async function reportedPluginInvocation(
  attempt: () => Promise<PluginInvocationOutcome>,
): Promise<PluginInvocationOutcome> {
  try {
    return await attempt();
  } catch (error) {
    return invocationEffectUnknown(error);
  }
}

/** The plain invoke contract on top of an attempt: the value, or the very error the call failed with. */
export function settlePluginInvocation(outcome: PluginInvocationOutcome): unknown {
  if (outcome.status === 'failed') throw outcome.error;
  return outcome.value;
}
