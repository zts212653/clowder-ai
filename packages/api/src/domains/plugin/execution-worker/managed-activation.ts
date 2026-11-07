import type { PluginModuleActivationShape } from '../builtin-runtime/carriers/module-plugin-runtime.js';
import type { ModuleExecutionLease } from './client.js';

/** Retain failed disposers for the existing explicit stop retry; successful work is not repeated. */
export function manageExecutionActivation(
  candidate: unknown,
  lease: ModuleExecutionLease,
  scopes: Set<() => Promise<void>>,
): { candidate: unknown; ownsExecution: () => boolean } {
  const activation = candidate as Partial<PluginModuleActivationShape> | undefined;
  if (!activation || typeof activation.stop !== 'function') return { candidate, ownsExecution: () => false };
  const stop = activation.stop;
  let stopped = false;
  let owned = true;
  return {
    ownsExecution: () => owned,
    candidate: {
      ...activation,
      ...(activation.preStop
        ? {
            preStop: async (context: { reason: string; deadline: number }) => {
              if (!lease.exited) await activation.preStop?.(context);
            },
          }
        : {}),
      async stop(context: { reason: string }) {
        const errors: unknown[] = [];
        for (const close of [...scopes]) {
          try {
            await close();
          } catch (error) {
            errors.push(error);
          }
        }
        if (!stopped && !lease.exited) {
          try {
            await stop(context);
            stopped = true;
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, 'Module execution cleanup failed');
        await lease.close();
        owned = false;
      },
    },
  };
}
