/**
 * F202 Train C1 — the Host→plugin direction over the in-process module carrier.
 *
 * The carrier already holds the action table returned by a package's `start(host)`, so every
 * Host→plugin action resolves through that one table. Protocol-specific validation belongs at
 * the carrier-neutral caller (for example `PluginRuntimeCarrierRouter.deliver`).
 *
 * WHY EVERY FAILURE PATH REJECTS. Callers read a resolved promise as "the package accepted this
 * work"; the delivery driver advances its cursor on exactly that signal. A method the package
 * never implemented must therefore reject rather than quietly do nothing, or a message would be
 * recorded as delivered while nobody ever received it.
 *
 * Actions are resolved only as own properties. A shared object-root property can never stand in
 * for an implemented Host callback.
 */

import type { HostPluginInvocationPort } from '../carrier/host-invocation.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

export interface ModuleHostInvocationDeps {
  /** The carrier holding the action table returned by an active module's start(). */
  readonly runtime: { actions(pluginInstanceId: string): Readonly<Record<string, unknown>> | undefined };
}

/**
 * Resolve an action the package itself returned, and nothing that merely exists because every
 * JavaScript object inherits it.
 */
function resolvePackageAction(actions: Readonly<Record<string, unknown>>, method: string): unknown {
  return Object.hasOwn(actions, method) ? actions[method] : undefined;
}

export function createModuleHostInvocation(deps: ModuleHostInvocationDeps): Pick<HostPluginInvocationPort, 'invoke'> {
  return {
    async invoke(targetId: string, method: string, params: unknown): Promise<unknown> {
      const actions = deps.runtime.actions(targetId);
      if (!actions) {
        throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', `${targetId} has no module loaded in this Host`);
      }
      const candidate = resolvePackageAction(actions, method);
      if (typeof candidate !== 'function') {
        throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', `${targetId} does not expose action ${method}`);
      }
      return candidate.call(actions, params);
    },
  };
}
