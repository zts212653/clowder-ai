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
 *
 * THE EFFECT BOUNDARY (F202 W2-3 h3b). `attempt` also says whether a failure came before the
 * package's action ran (`not_started`: no module loaded, no such action) or after it was entered
 * (`unknown`: it threw, synchronously or not, and may already have acted). The line is the action
 * call itself, never an error code: the action can throw anything, a Host error included.
 */

import {
  attemptPluginAction,
  type HostPluginInvocationPort,
  invocationNotStarted,
  type PluginInvocationOutcome,
  settlePluginInvocation,
} from '../../carrier/host-invocation.js';
import { ExternalPluginRuntimeError } from '../../external-runtime/types.js';

export interface ModuleHostInvocationDeps {
  /** The carrier holding the action table returned by an active module's start(). */
  readonly runtime: { actions(pluginInstanceId: string): Readonly<Record<string, unknown>> | undefined };
}

export interface ModuleHostInvocation extends Pick<HostPluginInvocationPort, 'invoke'> {
  attempt(targetId: string, method: string, params: unknown): Promise<PluginInvocationOutcome>;
}

/**
 * Resolve an action the package itself returned, and nothing that merely exists because every
 * JavaScript object inherits it.
 */
function resolvePackageAction(actions: Readonly<Record<string, unknown>>, method: string): unknown {
  return Object.hasOwn(actions, method) ? actions[method] : undefined;
}

/** Whether a loaded module's action table implements `method`, under the same rule the calls use. */
export function exposesModuleAction(actions: Readonly<Record<string, unknown>> | undefined, method: string): boolean {
  return actions !== undefined && typeof resolvePackageAction(actions, method) === 'function';
}

export function createModuleHostInvocation(deps: ModuleHostInvocationDeps): ModuleHostInvocation {
  const attempt = async (targetId: string, method: string, params: unknown): Promise<PluginInvocationOutcome> => {
    const actions = deps.runtime.actions(targetId);
    if (!actions) {
      return invocationNotStarted(
        new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', `${targetId} has no module loaded in this Host`),
      );
    }
    const candidate = resolvePackageAction(actions, method);
    if (typeof candidate !== 'function') {
      return invocationNotStarted(
        new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', `${targetId} does not expose action ${method}`),
      );
    }
    // The boundary: from here the package's own code runs.
    return attemptPluginAction(() => candidate.call(actions, params));
  };
  return {
    attempt,
    invoke: async (targetId, method, params) => settlePluginInvocation(await attempt(targetId, method, params)),
  };
}
