import {
  AGENT_ACCESS_PLUGIN_ID,
  type AgentAccessCodexAppServerThreadRequest,
  type AgentAccessCodexAppServerTurnRequest,
  agentAccessCodexAppServerNotificationProjectionSchema,
  agentAccessCodexAppServerThreadPlanSchema,
  agentAccessCodexAppServerTurnPlanSchema,
} from '@clowder-ai/agent-contract';
import type { CodexAppServerNotificationProjection } from '../../cats/services/agents/providers/codex-app-server-notification-projection.js';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

/**
 * Host seam for Codex app-server params.
 *
 * The package owns the JSON-RPC parameter shape; the Host retains the physical
 * process, credentials, native thread/turn identity validation, approvals,
 * cancellation and host-pool authority.
 */
function createPlanner<Request extends { operation: string }, Plan>(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'>,
  action: 'planCodexAppServerThread' | 'planCodexAppServerTurn',
  parse: (value: unknown) => Plan,
) {
  return async (request: Request): Promise<Plan & { assertCurrent: () => Promise<void> }> => {
    const instance = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!instance || instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');

    const { pluginInstanceId, packageDigest, lifecycleRevision } = instance;
    const result = await runtime.invoke(pluginInstanceId, action, request);
    async function assertCurrent() {
      const current = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
      if (
        current?.pluginInstanceId !== pluginInstanceId ||
        current.packageDigest !== packageDigest ||
        current.lifecycleRevision !== lifecycleRevision ||
        current.runtimeState !== 'healthy'
      )
        throw new Error('session_implementation_unavailable');
    }
    return { ...parse(result), assertCurrent };
  };
}

export function createAgentAccessCodexAppServerThreadPlanner(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'>,
) {
  return createPlanner<AgentAccessCodexAppServerThreadRequest, ReturnType<typeof parseThread>>(
    inventory,
    runtime,
    'planCodexAppServerThread',
    (value) => agentAccessCodexAppServerThreadPlanSchema.parse(value),
  );
}

function parseThread(value: unknown) {
  return agentAccessCodexAppServerThreadPlanSchema.parse(value);
}

export function createAgentAccessCodexAppServerTurnPlanner(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'>,
) {
  return createPlanner<AgentAccessCodexAppServerTurnRequest, ReturnType<typeof parseTurn>>(
    inventory,
    runtime,
    'planCodexAppServerTurn',
    (value) => agentAccessCodexAppServerTurnPlanSchema.parse(value),
  );
}

function parseTurn(value: unknown) {
  return agentAccessCodexAppServerTurnPlanSchema.parse(value);
}

/**
 * Load the package's static notification method table once per activation.
 *
 * This is deliberately not an event handler: an ordinary turn never calls the
 * Worker per notification. The returned table is pinned to the activation that
 * produced it; a replacement rejects `assertCurrent` instead of mixing tables.
 */
export function createAgentAccessCodexAppServerNotificationProjection(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke' | 'exposesAction'>,
) {
  let cachedKey: string | undefined;
  let cached: Promise<CodexAppServerNotificationProjection | undefined> | undefined;

  return async (): Promise<CodexAppServerNotificationProjection | undefined> => {
    const authority = await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID);
    const instance = authority?.instance;
    if (!instance || instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy')
      return undefined;
    const key = [instance.pluginInstanceId, instance.packageDigest, instance.lifecycleRevision].join(':');
    if (cached && cachedKey === key) return cached;

    const { pluginInstanceId, packageDigest, lifecycleRevision } = instance;
    cachedKey = key;
    const loading = (async (): Promise<CodexAppServerNotificationProjection | undefined> => {
      if (runtime.exposesAction && !(await runtime.exposesAction(pluginInstanceId, 'projectNotifications')))
        return undefined;
      const raw = await runtime.invoke(pluginInstanceId, 'projectNotifications', {});
      const parsed = agentAccessCodexAppServerNotificationProjectionSchema.parse(raw);
      for (const ignored of parsed.ignoredMethods) {
        if (parsed.methods.includes(ignored) || Object.hasOwn(parsed.aliases, ignored))
          throw new Error('codex_notification_ignore_shadows_method');
      }
      for (const [alias, target] of Object.entries(parsed.aliases)) {
        if (parsed.methods.includes(alias)) throw new Error('codex_notification_alias_shadows_method');
        if (target === 'turn/completed' || target === 'turn/failed')
          throw new Error('codex_notification_alias_terminal_forbidden');
        if (!parsed.methods.includes(target)) throw new Error('codex_notification_alias_target_unknown');
      }
      return {
        methods: new Set(parsed.methods),
        ignoredMethods: new Set(parsed.ignoredMethods),
        aliases: new Map(Object.entries(parsed.aliases)),
        async assertCurrent() {
          const current = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
          if (
            current?.pluginInstanceId !== pluginInstanceId ||
            current.packageDigest !== packageDigest ||
            current.lifecycleRevision !== lifecycleRevision ||
            current.runtimeState !== 'healthy'
          )
            throw new Error('session_implementation_unavailable');
        },
      };
    })().catch((error) => {
      if (cachedKey === key) cached = undefined;
      throw error;
    });
    cached = loading;
    return loading;
  };
}
