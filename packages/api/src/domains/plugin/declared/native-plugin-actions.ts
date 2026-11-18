import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { PluginNativeActionTarget } from '../../cats/services/types.js';
import { type PluginCallContext, withPluginCallContext } from '../carrier/plugin-call-context.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';
import { nativePluginActionEnvironmentKey } from './native-plugin-action-environment.js';

export class NativePluginActionError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface Binding {
  readonly instanceId: string;
  readonly admission: PluginRuntimeAdmission;
  readonly connections: ReadonlyMap<string, { readonly token: string }>;
  readonly invoke: (method: string, input: unknown) => Promise<unknown>;
}

/** A native MCP transport can call only actions belonging to its current local activation. */
export class NativePluginActions {
  // One secret per Host lifetime. Enable/disable changes authority, not credentials.
  readonly #hostSecret = randomBytes(32);
  readonly #bindings = new Map<string, Binding>();
  readonly #tokens = new Map<
    string,
    {
      readonly binding: Binding;
      readonly contributionId: string;
    }
  >();
  readonly #activations = new Map<string, { generation: number; retired: AbortController }>();

  constructor(private readonly admission: (instanceId: string) => Promise<PluginRuntimeAdmission>) {}

  generation(instanceId: string): number {
    return this.#activation(instanceId).generation;
  }

  activationSignal(instanceId: string): AbortSignal {
    return this.#activation(instanceId).retired.signal;
  }

  #activation(instanceId: string) {
    let activation = this.#activations.get(instanceId);
    if (!activation) {
      activation = { generation: 0, retired: new AbortController() };
      this.#activations.set(instanceId, activation);
    }
    return activation;
  }

  activate(admission: PluginRuntimeAdmission, generation: number, invoke: Binding['invoke']): void {
    const instanceId = admission.instance.pluginInstanceId;
    if (generation !== this.generation(instanceId) || this.#bindings.has(instanceId)) {
      throw new NativePluginActionError(409, 'Plugin activation changed during startup');
    }
    const connections = new Map<string, { token: string }>();
    for (const contribution of admission.packageRecord.manifest.contributions ?? []) {
      if (contribution.type === 'mcp') {
        connections.set(contribution.id, {
          token: createHmac('sha256', this.#hostSecret)
            .update(JSON.stringify([instanceId, contribution.id]))
            .digest('hex'),
        });
      }
    }
    const binding: Binding = {
      instanceId,
      admission: structuredClone(admission),
      connections,
      invoke,
    };
    this.#bindings.set(instanceId, binding);
    for (const [contributionId, connection] of connections) {
      this.#tokens.set(connection.token, { binding, contributionId });
      process.env[nativePluginActionEnvironmentKey(instanceId, contributionId, 'TOKEN')] = connection.token;
      process.env[nativePluginActionEnvironmentKey(instanceId, contributionId, 'PATH')] = '/api/plugin-runtime/action';
    }
  }

  /** Resolve policy coordinates from the active Host-issued token, not package-supplied identity. */
  target(token: string): PluginNativeActionTarget | undefined {
    const connection = this.#tokens.get(token);
    if (!connection) return undefined;
    return Object.freeze({
      instanceId: connection.binding.instanceId,
      contributionId: connection.contributionId,
    });
  }

  environment(instanceId: string, contributionId: string): Readonly<Record<string, string>> {
    const binding = this.#bindings.get(instanceId);
    const connection = binding?.connections.get(contributionId);
    if (!connection) return {};
    return {
      CLOWDER_PLUGIN_ACTION_TOKEN: connection.token,
      CLOWDER_PLUGIN_ACTION_PATH: '/api/plugin-runtime/action',
    };
  }

  /** Durable MCP registration stores a reference, while its value belongs to this Host process. */
  environmentReferences(instanceId: string, contributionId: string): Readonly<Record<string, string>> {
    if (!this.#bindings.get(instanceId)?.connections.has(contributionId)) return {};
    return {
      CLOWDER_PLUGIN_ACTION_TOKEN: `\${${nativePluginActionEnvironmentKey(instanceId, contributionId, 'TOKEN')}}`,
      CLOWDER_PLUGIN_ACTION_PATH: `\${${nativePluginActionEnvironmentKey(instanceId, contributionId, 'PATH')}}`,
    };
  }

  deactivate(instanceId: string): void {
    const activation = this.#activation(instanceId);
    this.#activations.set(instanceId, { generation: activation.generation + 1, retired: new AbortController() });
    const binding = this.#bindings.get(instanceId);
    if (binding) for (const connection of binding.connections.values()) this.#tokens.delete(connection.token);
    this.#bindings.delete(instanceId);
    activation.retired.abort(new NativePluginActionError(409, 'Plugin activation was retired'));
  }

  deactivateAll(): void {
    for (const id of this.#activations.keys()) this.deactivate(id);
  }

  async call(token: string, method: string, input: unknown, caller: PluginCallContext): Promise<unknown> {
    const connection = this.#tokens.get(token);
    if (!connection) throw new NativePluginActionError(401, 'Plugin connection is not active');
    const { binding } = connection;
    let finished = false;
    const checkCaller = caller.assertCurrent.bind(caller);
    const checkInvocation = (caller.assertInvocationCurrent ?? caller.assertCurrent).bind(caller);
    const assertActiveInvocation = () => {
      if (finished || this.#bindings.get(binding.instanceId) !== binding)
        throw new NativePluginActionError(409, 'Plugin call is no longer current');
    };
    const assertInvocationCurrent = async () => {
      assertActiveInvocation();
      await checkInvocation();
      assertActiveInvocation();
    };
    const assertCurrent = async () => {
      await assertInvocationCurrent();
      await checkCaller();
      const current = await this.admission(binding.instanceId);
      if (
        finished ||
        this.#bindings.get(binding.instanceId) !== binding ||
        current.instance.activationState !== 'enabled' ||
        current.instance.lifecycleState !== 'installed' ||
        current.instance.configReadiness !== 'ready' ||
        current.instance.packageDigest !== binding.admission.instance.packageDigest
      )
        throw new NativePluginActionError(409, 'Plugin call is no longer current');
      await checkCaller();
      await assertInvocationCurrent();
    };
    const checkWrite = caller.assertWriteCurrent?.bind(caller);
    const context = Object.freeze({
      ...caller,
      assertCurrent,
      assertInvocationCurrent,
      ...(checkWrite
        ? {
            assertWriteCurrent: () => {
              assertActiveInvocation();
              checkWrite();
            },
          }
        : {}),
      nativeAction: Object.freeze({ id: randomUUID(), contributionId: connection.contributionId, method }),
    });
    await assertCurrent();
    try {
      const result = await withPluginCallContext(binding.instanceId, context, () => binding.invoke(method, input));
      await assertCurrent();
      return result;
    } finally {
      finished = true;
    }
  }
}
