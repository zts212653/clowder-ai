import { addAbortListener } from 'node:events';
import {
  AGENT_ADAPTER_OPTIONAL_OPERATIONS,
  parseAgentAdapterDescription,
  parseAgentAdapterDetection,
} from '@clowder-ai/agent-contract';
import { sessionImplementationKey } from '../../cats/services/agents/session-contract/implementation-registry.js';
import type { ModulePluginRuntime } from '../builtin-runtime/carriers/module-plugin-runtime.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginInstanceRecord } from '../host-inventory/types.js';

const metadataTimeoutMs = 5_000;

export function createAgentAdapterAccess(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority' | 'snapshot'>,
  runtime: Pick<ModulePluginRuntime, 'agentAdapter' | 'invoke' | 'operationActivationSignal'>,
) {
  const resolve = (instance: PluginInstanceRecord | undefined) => {
    if (instance?.activationState !== 'enabled' || instance.runtimeState !== 'healthy') return undefined;
    const declaration = runtime.agentAdapter(instance.pluginInstanceId, instance.packageDigest);
    const lifetime = runtime.operationActivationSignal(instance.pluginInstanceId);
    if (!declaration || !lifetime || lifetime.aborted) return undefined;
    return { instance, declaration, lifetime };
  };
  const binding = (instance: PluginInstanceRecord, contributionId: string) => ({
    ref: sessionImplementationKey({ pluginId: instance.pluginId, contributionId }),
    pluginInstanceId: instance.pluginInstanceId,
    packageDigest: instance.packageDigest,
    lifecycleRevision: instance.lifecycleRevision,
  });
  async function read(
    ref: { pluginId: string; contributionId: string },
    action: 'describe' | 'detect',
    input: Readonly<Record<string, unknown>>,
    callerSignal?: AbortSignal,
  ) {
    const active = resolve((await inventory.readCurrentAuthority(ref.pluginId))?.instance);
    if (!active || active.declaration.id !== ref.contributionId)
      throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'Agent adapter is not active');
    const signals = [active.lifetime, AbortSignal.timeout(metadataTimeoutMs)];
    if (callerSignal) signals.push(callerSignal);
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    let listener: ReturnType<typeof addAbortListener> | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      listener = addAbortListener(signal, () => reject(signal.reason));
    });
    const response = await Promise.race([
      runtime.invoke(active.instance.pluginInstanceId, action, input, { signal }),
      cancellation,
    ]).finally(() => listener?.[Symbol.dispose]());
    signal.throwIfAborted();
    const current = resolve((await inventory.readCurrentAuthority(ref.pluginId))?.instance);
    if (
      current?.lifetime !== active.lifetime ||
      current.declaration.id !== ref.contributionId ||
      current.instance.packageDigest !== active.instance.packageDigest ||
      current.instance.lifecycleRevision !== active.instance.lifecycleRevision
    )
      throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'Agent adapter activation changed');
    return { active, response };
  }
  return {
    async list() {
      const { instances } = await inventory.snapshot({ currentOnly: true });
      return instances.flatMap((instance) => {
        const active = resolve(instance);
        return active ? [binding(active.instance, active.declaration.id)] : [];
      });
    },
    async detect(
      ref: { pluginId: string; contributionId: string },
      options?: { refresh?: boolean; signal?: AbortSignal },
    ) {
      const { active, response } = await read(ref, 'detect', { refresh: options?.refresh ?? false }, options?.signal);
      const result = parseAgentAdapterDetection(response);
      if (!result.success)
        throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'Agent adapter returned invalid detection data');
      return { ...result.data, binding: binding(active.instance, active.declaration.id) };
    },
    async describe(ref: { pluginId: string; contributionId: string }, options?: { signal?: AbortSignal }) {
      const { active, response } = await read(ref, 'describe', {}, options?.signal);
      const result = parseAgentAdapterDescription(response);
      if (!result.success)
        throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'Agent adapter returned an invalid description');
      const undeclared = AGENT_ADAPTER_OPTIONAL_OPERATIONS.find(
        (operation) =>
          result.data.capabilities[operation].status === 'supported' &&
          !active.declaration.operations.includes(operation),
      );
      if (undeclared)
        throw new ExternalPluginRuntimeError(
          'PROTOCOL_VIOLATION',
          `Agent adapter describes undeclared operation ${undeclared}`,
        );
      return result.data;
    },
  };
}
