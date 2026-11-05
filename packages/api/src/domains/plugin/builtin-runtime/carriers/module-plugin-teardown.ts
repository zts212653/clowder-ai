import type { VerifiedPluginPackage } from '../../external-runtime/types.js';
import type { PluginMessagingSubscriptionSession } from '../../host-surface/plugin-messaging-subscription-host.js';
import type { PluginModuleActivationShape } from './module-plugin-runtime.js';

/** One step of a module's teardown. It receives the reason of the attempt that runs it. */
export type ModuleTeardownStep = (reason: string) => unknown;

/** A loaded module's teardown, in order: its Host subscriptions, its own stop, its package bytes. */
export function moduleTeardown(
  loaded: {
    readonly subscriptions: PluginMessagingSubscriptionSession;
    readonly activation: PluginModuleActivationShape;
    readonly located: VerifiedPluginPackage;
  },
  deactivate: () => void,
): readonly ModuleTeardownStep[] {
  let prepared = false;
  return [
    // Finish/abort plugin work before releasing its connections and resources.
    async (reason) => {
      if (prepared) return;
      try {
        await loaded.activation.preStop?.({ reason, deadline: Date.now() + 30_000 });
      } finally {
        prepared = true;
        deactivate();
      }
    },
    (reason) => loaded.subscriptions.stop(reason),
    (reason) => loaded.activation.stop({ reason }),
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
  retainFailed?: (steps: readonly ModuleTeardownStep[]) => void,
): Promise<never> {
  const steps: ModuleTeardownStep[] = [
    ...(subscriptions ? [(reason: string) => subscriptions.stop(reason)] : []),
    ...(activation ? [(reason: string) => activation.stop({ reason })] : []),
    () => located.release(),
  ];
  const { failed, errors } = await runModuleTeardown(steps, 'start_failed');
  if (failed.length > 0) {
    retainFailed?.(failed);
    throw new AggregateError([startError, ...errors], 'module startup rollback failed');
  }
  throw startError;
}
