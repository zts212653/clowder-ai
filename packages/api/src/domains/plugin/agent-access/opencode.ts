import {
  AGENT_ACCESS_PLUGIN_ID,
  type AgentAccessOpenCodeFinalizer,
  type AgentAccessOpenCodeLaunch,
  agentAccessNativeLaunchArgumentsSchema,
  agentAccessOpenCodeEventSchema,
} from '@clowder-ai/agent-contract';
import { sanitizeRawEvent } from '../../cats/services/agents/providers/codex-audit-hooks.js';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

/**
 * Host-side seam for the OpenCode native runtime.
 *
 * Symmetric with the Kimi planner: the Host keeps the binary, credentials, cwd,
 * spawn and the `run --help` probe, and the active package owns argv and event
 * shape. Nothing here re-implements OpenCode's CLI surface — a missing or stale
 * package is an explicit `session_implementation_unavailable`, never a Host-side
 * fallback, because a silent fallback is how one turn runs a different CLI.
 */
export function createAgentAccessOpenCodeLaunchPlanner(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'> & Partial<Pick<PluginRuntimeCarrierRouter, 'nativeActions'>>,
) {
  return async (launch: AgentAccessOpenCodeLaunch) => {
    const instance = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!instance || instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');

    const { pluginInstanceId, packageDigest, lifecycleRevision } = instance;
    const lifetime = runtime.nativeActions?.activationSignal(pluginInstanceId);
    lifetime?.throwIfAborted();
    const result = await runtime.invoke(pluginInstanceId, 'configure', {
      operation: 'plan_native_launch',
      client: 'opencode',
      launch,
    });

    // Re-read before every step the Host takes with this plan: a package replaced
    // mid-turn must not keep serving that turn.
    async function assertCurrent() {
      lifetime?.throwIfAborted();
      const current = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
      if (
        current?.pluginInstanceId !== pluginInstanceId ||
        current.packageDigest !== packageDigest ||
        current.lifecycleRevision !== lifecycleRevision ||
        current.activationState !== 'enabled' ||
        current.runtimeState !== 'healthy'
      )
        throw new Error('session_implementation_unavailable');
    }

    return {
      ...agentAccessNativeLaunchArgumentsSchema.parse(result),
      lifetime,
      assertCurrent,
      async normalizeEvent(event: unknown, knownCredentials?: readonly string[]) {
        await assertCurrent();
        // A raw provider error can carry a credential nested in its payload, and the
        // package runs in a worker owned by a third-party archive. Redact at the
        // boundary, exactly as the Kimi planner does, so nothing sensitive leaves the
        // Host — while the parse result keeps whatever error classification came back.
        const response = await runtime.invoke(pluginInstanceId, 'parseNativeEvent', {
          client: 'opencode',
          event: sanitizeRawEvent(event, knownCredentials),
        });
        // Re-read after the await: the worker round trip is a suspension point, and a
        // package replaced during it must not keep describing the turn. Kimi checks on
        // both sides of its call for the same reason.
        await assertCurrent();
        return agentAccessOpenCodeEventSchema.parse(response);
      },
    };
  };
}

/** The tool-free recovery run: Host-owned continuation, planned by the same package. */
export function createAgentAccessOpenCodeFinalizerPlanner(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'> & Partial<Pick<PluginRuntimeCarrierRouter, 'exposesAction'>>,
) {
  return async (launch: AgentAccessOpenCodeFinalizer, lease?: { assertCurrent?: () => Promise<void> }) => {
    // The recovery run belongs to the turn the main plan was built for. Re-reading
    // "whatever is active now" would let a replacement that landed mid-turn plan the
    // recovery, while the turn's main run is still pinned to the earlier package.
    await lease?.assertCurrent?.();

    const instance = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!instance || instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');

    // A package installed before this operation existed still reports healthy, so the
    // declaration cannot answer this — the package itself must. Invoking blind would
    // turn a recoverable "old package" into a failed rescue at the worst moment.
    const exposes = await runtime.exposesAction?.(instance.pluginInstanceId, 'planFinalizer');
    if (!exposes) throw new Error('session_implementation_unavailable');

    // Same lease, checked again across the invoke: the worker round trip is a
    // suspension point like any other.
    await lease?.assertCurrent?.();
    const result = await runtime.invoke(instance.pluginInstanceId, 'planFinalizer', {
      operation: 'plan_native_finalizer',
      client: 'opencode',
      launch,
    });

    return agentAccessNativeLaunchArgumentsSchema.parse(result);
  };
}
