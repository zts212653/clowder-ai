import type { NativeMcpServer } from './native-mcp-types.js';

export type { NativeMcpServer } from './native-mcp-types.js';

import { isDeepStrictEqual } from 'node:util';
import { normalizeToolExecutionPolicy } from '../../cats/services/agents/invocation/tool-execution-policy.js';
import type { ToolExecutionPolicy } from '../../cats/services/types.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';
import { NativePluginActionError, type NativePluginActions } from './native-plugin-actions.js';

export interface DeclaredMcpLaunch {
  readonly contributionId: string;
  readonly server: NativeMcpServer;
}

interface Activation {
  readonly admission: PluginRuntimeAdmission;
  readonly generation: number;
  readonly launches: readonly DeclaredMcpLaunch[];
}

/** A snapshot resolves only while its original activation and authority remain current. */
export class NativeMcpLaunches {
  readonly #activations = new Map<string, Activation>();

  constructor(
    private readonly admission: (instanceId: string) => Promise<PluginRuntimeAdmission>,
    private readonly actions: NativePluginActions,
  ) {}

  activate(admission: PluginRuntimeAdmission, generation: number, launches: readonly DeclaredMcpLaunch[]): void {
    const instanceId = admission.instance.pluginInstanceId;
    if (this.actions.generation(instanceId) !== generation) throw unavailable();
    this.#activations.set(instanceId, { admission: structuredClone(admission), generation, launches });
  }

  deactivate(instanceId: string): void {
    this.#activations.delete(instanceId);
  }

  deactivateAll(): void {
    this.#activations.clear();
  }

  async resolve(policy: ToolExecutionPolicy): Promise<NativeMcpServer> {
    // Normalize synchronously: the caller cannot replace coordinates across admission's await.
    if (policy.mode !== 'plugin_native') throw unavailable();
    const request = normalizeToolExecutionPolicy(policy);
    if (request.mode !== 'plugin_native') throw unavailable();
    const { pluginInstanceId, contributionId, actionMethods } = request;
    const activation = this.#activations.get(pluginInstanceId);
    if (!activation) throw unavailable();
    const current = await this.admission(pluginInstanceId);
    const original = activation.admission;
    if (
      this.#activations.get(pluginInstanceId) !== activation ||
      this.actions.generation(pluginInstanceId) !== activation.generation ||
      current.instance.activationState !== 'enabled' ||
      current.instance.lifecycleState !== 'installed' ||
      current.instance.configReadiness !== 'ready' ||
      current.packageRecord.packageState !== 'installed' ||
      current.instance.pluginId !== original.instance.pluginId ||
      current.instance.packageDigest !== original.instance.packageDigest ||
      current.grantRevision !== original.grantRevision ||
      !isDeepStrictEqual(current.packageRecord, original.packageRecord) ||
      !isDeepStrictEqual([...current.effectiveGrants].sort(), [...original.effectiveGrants].sort())
    )
      throw unavailable();

    const declarations = current.packageRecord.manifest.contributions?.filter(
      (item) => item.type === 'mcp' && item.id === contributionId,
    );
    const launches = activation.launches.filter((item) => item.contributionId === contributionId);
    const server = launches[0]?.server;
    if (declarations?.length !== 1 || launches.length !== 1 || !server) throw unavailable();
    const token = server.env.CLOWDER_PLUGIN_ACTION_TOKEN;
    if (
      !token ||
      !actionMethods.every((method) => {
        const target = this.actions.target(token, method);
        return (
          target?.instanceId === pluginInstanceId &&
          target.contributionId === contributionId &&
          target.method === method
        );
      })
    )
      throw unavailable();
    return server;
  }
}

function unavailable(): NativePluginActionError {
  return new NativePluginActionError(409, 'Plugin native MCP launch is not current or permitted');
}
