import { parseAgentAdapterDescription } from '@clowder-ai/agent-contract';
import { sessionImplementationKey } from '../../cats/services/agents/session-contract/implementation-registry.js';
import type { ModulePluginRuntime } from '../builtin-runtime/carriers/module-plugin-runtime.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginInstanceRecord } from '../host-inventory/types.js';

export function createAgentAdapterAccess(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority' | 'snapshot'>,
  runtime: Pick<ModulePluginRuntime, 'agentAdapter' | 'invoke'>,
) {
  const resolve = (instance: PluginInstanceRecord | undefined) => {
    if (instance?.activationState !== 'enabled' || instance.runtimeState !== 'healthy') return undefined;
    const declaration = runtime.agentAdapter(instance.pluginInstanceId, instance.packageDigest);
    if (!declaration) return undefined;
    return { instance, declaration };
  };
  return {
    async list() {
      const { instances } = await inventory.snapshot({ currentOnly: true });
      return instances.flatMap((instance) => {
        const active = resolve(instance);
        if (!active) return [];
        return [
          {
            ref: sessionImplementationKey({ pluginId: instance.pluginId, contributionId: active.declaration.id }),
            pluginInstanceId: instance.pluginInstanceId,
            packageDigest: instance.packageDigest,
            lifecycleRevision: instance.lifecycleRevision,
          },
        ];
      });
    },
    async describe(ref: { pluginId: string; contributionId: string }) {
      const active = resolve((await inventory.readCurrentAuthority(ref.pluginId))?.instance);
      if (!active || active.declaration.id !== ref.contributionId)
        throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'Agent adapter is not active');
      const response = await runtime.invoke(active.instance.pluginInstanceId, 'describe', {});
      const current = resolve((await inventory.readCurrentAuthority(ref.pluginId))?.instance);
      if (
        current?.declaration !== active.declaration ||
        current.instance.lifecycleRevision !== active.instance.lifecycleRevision
      )
        throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'Agent adapter activation changed');
      const result = parseAgentAdapterDescription(response);
      if (!result.success)
        throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'Agent adapter returned an invalid description');
      for (const operation of ['modelCatalog', 'quota'] as const) {
        if (
          result.data.capabilities[operation].status === 'supported' &&
          !active.declaration.operations.includes(operation)
        )
          throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'Agent adapter describes an undeclared operation');
      }
      return result.data;
    },
  };
}
