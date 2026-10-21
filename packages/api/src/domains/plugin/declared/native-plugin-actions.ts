import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PluginNativeActionTarget } from '../../cats/services/types.js';
import { type PluginCallContext, withPluginCallContext } from '../carrier/plugin-call-context.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';

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
  readonly connections: ReadonlyMap<string, { readonly token: string; readonly methods: ReadonlySet<string> }>;
  readonly invoke: (method: string, input: unknown) => Promise<unknown>;
}

/** A native MCP transport can call only actions belonging to its current local activation. */
export class NativePluginActions {
  readonly #bindings = new Map<string, Binding>();
  readonly #tokens = new Map<
    string,
    {
      readonly binding: Binding;
      readonly contributionId: string;
      readonly methods: ReadonlySet<string>;
    }
  >();
  readonly #generations = new Map<string, number>();

  constructor(private readonly admission: (instanceId: string) => Promise<PluginRuntimeAdmission>) {}

  generation(instanceId: string): number {
    if (!this.#generations.has(instanceId)) this.#generations.set(instanceId, 0);
    return this.#generations.get(instanceId) ?? 0;
  }

  activate(admission: PluginRuntimeAdmission, generation: number, invoke: Binding['invoke']): void {
    const instanceId = admission.instance.pluginInstanceId;
    if (generation !== this.generation(instanceId) || this.#bindings.has(instanceId)) {
      throw new NativePluginActionError(409, 'Plugin activation changed during startup');
    }
    const allowed = new Set(
      admission.packageRecord.manifest.features
        .filter((feature) => feature.capabilities.every((capability) => admission.effectiveGrants.includes(capability)))
        .flatMap((feature) =>
          (feature.contributions ?? []).filter((item) => item.type === 'mcp').map((item) => item.id),
        ),
    );
    const connections = new Map<string, { token: string; methods: ReadonlySet<string> }>();
    for (const contribution of admission.packageRecord.manifest.contributions ?? []) {
      if (contribution.type === 'mcp' && allowed.has(contribution.id) && contribution.actions?.length) {
        connections.set(contribution.id, {
          token: randomBytes(32).toString('hex'),
          methods: new Set(contribution.actions.map((action) => action.method)),
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
    for (const [contributionId, connection] of connections)
      this.#tokens.set(connection.token, { binding, contributionId, methods: connection.methods });
  }

  /** Resolve policy coordinates from the active Host-issued token, not package-supplied identity. */
  target(token: string, method: string): PluginNativeActionTarget | undefined {
    const connection = this.#tokens.get(token);
    if (!connection?.methods.has(method)) return undefined;
    return Object.freeze({
      instanceId: connection.binding.instanceId,
      contributionId: connection.contributionId,
      method,
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

  deactivate(instanceId: string): void {
    this.#generations.set(instanceId, this.generation(instanceId) + 1);
    const binding = this.#bindings.get(instanceId);
    if (binding) for (const connection of binding.connections.values()) this.#tokens.delete(connection.token);
    this.#bindings.delete(instanceId);
  }

  deactivateAll(): void {
    for (const id of new Set([...this.#generations.keys(), ...this.#bindings.keys()])) this.deactivate(id);
  }

  async call(token: string, method: string, input: unknown, caller: PluginCallContext): Promise<unknown> {
    const connection = this.#tokens.get(token);
    if (!connection) throw new NativePluginActionError(401, 'Plugin connection is not active');
    const { binding, methods } = connection;
    if (!methods.has(method)) throw new NativePluginActionError(403, 'Action is not declared by this MCP contribution');
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
        current.instance.packageDigest !== binding.admission.instance.packageDigest ||
        !isDeepStrictEqual([...current.effectiveGrants].sort(), [...binding.admission.effectiveGrants].sort())
      )
        throw new NativePluginActionError(409, 'Plugin call is no longer current');
      await checkCaller();
      await assertInvocationCurrent();
    };
    const context = Object.freeze({ ...caller, assertCurrent, assertInvocationCurrent });
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
