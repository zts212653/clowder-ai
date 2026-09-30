import type { VerifiedPluginPackage } from '../external-runtime/types.js';
import type { PluginMessagingSubscriptionSession } from '../host-surface/plugin-messaging-subscription-host.js';
import type { PluginModuleActivationShape } from './module-plugin-runtime.js';

/** One step of a module's teardown. It receives the reason of the attempt that runs it. */
export type ModuleTeardownStep = (reason: string) => unknown;

/** A loaded module's teardown, in order: its Host subscriptions, its own stop, its package bytes. */
export function moduleTeardown(loaded: {
  readonly subscriptions: PluginMessagingSubscriptionSession;
  readonly activation: PluginModuleActivationShape;
  readonly located: VerifiedPluginPackage;
}): readonly ModuleTeardownStep[] {
  return [
    (reason) => loaded.subscriptions.stop(reason),
    (reason) => loaded.activation.stop(reason),
    // Package bytes stay present until package cleanup has finished.
    () => loaded.located.release(),
  ];
}

/**
 * Runs every step, even after one fails, and returns the steps that failed with their errors. The
 * caller keeps the failed steps, so the next stop retries exactly those and never repeats a step
 * that already succeeded (F202 W2-3 h2 ⑥).
 */
export async function runModuleTeardown(
  steps: readonly ModuleTeardownStep[],
  reason: string,
): Promise<{ readonly failed: readonly ModuleTeardownStep[]; readonly errors: readonly unknown[] }> {
  const failed: ModuleTeardownStep[] = [];
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step(reason);
    } catch (error) {
      failed.push(step);
      errors.push(error);
    }
  }
  return { failed, errors };
}

export async function rollbackModuleStart(
  startError: unknown,
  activation: PluginModuleActivationShape | undefined,
  subscriptions: PluginMessagingSubscriptionSession | undefined,
  located: VerifiedPluginPackage,
): Promise<never> {
  const stopResults = await Promise.allSettled([
    ...(subscriptions ? [subscriptions.stop('start_failed')] : []),
    ...(activation ? [activation.stop('start_failed')] : []),
  ]);
  const releaseResults = await Promise.allSettled([located.release()]);
  const failures = [...stopResults, ...releaseResults]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError([startError, ...failures], 'module startup rollback failed');
  throw startError;
}
