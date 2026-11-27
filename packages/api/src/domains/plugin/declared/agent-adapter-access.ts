import { addAbortListener } from 'node:events';
import {
  AGENT_ADAPTER_OPTIONAL_OPERATIONS,
  type AgentAdapterNativeRuntime,
  parseAgentAdapterDescription,
  parseAgentAdapterDetection,
  parseAgentAdapterQuota,
} from '@clowder-ai/agent-contract';
import {
  type SessionImplementationRegistry,
  sessionImplementationKey,
} from '../../cats/services/agents/session-contract/implementation-registry.js';
import type { ModulePluginRuntime } from '../builtin-runtime/carriers/module-plugin-runtime.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginInstanceRecord, PluginPackageProvenance } from '../host-inventory/types.js';

import {
  type AgentAdapterSessionInvocation,
  type AgentAdapterSessionScope,
  createAgentAdapterSessionProvider,
} from './agent-adapter-session-provider.js';

type AdapterAction = 'describe' | 'detect' | Parameters<AgentAdapterSessionInvocation>[0] | 'quota';
const defaultActionTimeoutMs = 5_000;
const actionTimeoutMs: Partial<Record<AdapterAction, number>> = {
  detect: 10_000,
  quota: 16_000,
  openSession: 60_000,
  release: 60_000,
};
type AgentAdapterAccountScope = {
  readonly projectRoot: string;
  readonly accountRef: string;
  readonly accountRevision: string;
  readonly credentialVersion: string;
};
type AdapterCatalogIdentity = Pick<Extract<PluginPackageProvenance, { kind: 'catalog' }>, 'catalogId' | 'packageName'>;

export type AgentAdapterRuntimeGrant = (request: {
  readonly pluginId: string;
  readonly contributionId: string;
  readonly packageDigest: string;
  readonly pluginInstanceId: string;
  readonly activationSignal: AbortSignal;
  readonly packageProvenance?: PluginPackageProvenance;
  readonly action: AdapterAction;
  readonly catId?: string;
  readonly account?: AgentAdapterAccountScope;
  readonly hostSession?: AgentAdapterSessionScope;
}) => AgentAdapterNativeRuntime | undefined;

export function createAgentAdapterAccess(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority' | 'snapshot'>,
  runtime: Pick<ModulePluginRuntime, 'agentAdapter' | 'invoke' | 'operationActivationSignal'>,
  grantNativeRuntime?: AgentAdapterRuntimeGrant,
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
    action: AdapterAction,
    input: Readonly<Record<string, unknown>>,
    options?: {
      signal?: AbortSignal;
      lifetime?: AbortSignal;
      catId?: string;
      account?: AgentAdapterAccountScope;
      catalog?: AdapterCatalogIdentity;
      hostSession?: AgentAdapterSessionScope;
    },
  ) {
    const authority = await inventory.readCurrentAuthority(ref.pluginId);
    const active = resolve(authority?.instance);
    if (
      !active ||
      active.declaration.id !== ref.contributionId ||
      (options?.lifetime && options.lifetime !== active.lifetime)
    )
      throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'Agent adapter is not active');
    if (!active.declaration.operations.includes(action))
      throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'Agent adapter did not declare the requested action');
    const provenance = authority?.packageRecord?.provenance;
    if (
      options?.catalog &&
      (provenance?.kind !== 'catalog' ||
        provenance.catalogId !== options.catalog.catalogId ||
        provenance.packageName !== options.catalog.packageName)
    ) {
      throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'Agent adapter is outside the selected catalog');
    }
    const nativeRuntime = grantNativeRuntime?.({
      ...ref,
      packageDigest: active.instance.packageDigest,
      pluginInstanceId: active.instance.pluginInstanceId,
      activationSignal: active.lifetime,
      ...(provenance === undefined ? {} : { packageProvenance: provenance }),
      action,
      ...(options?.catId === undefined ? {} : { catId: options.catId }),
      ...(options?.account === undefined ? {} : { account: options.account }),
      ...(options?.hostSession === undefined ? {} : { hostSession: options.hostSession }),
    });
    const deadline = new AbortController();
    const signals = [active.lifetime, deadline.signal];
    if (options?.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    let listener: ReturnType<typeof addAbortListener> | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      listener = addAbortListener(signal, () => reject(signal.reason));
    });
    const timer = setTimeout(
      () => deadline.abort(new DOMException('Agent adapter call timed out', 'TimeoutError')),
      actionTimeoutMs[action] ?? defaultActionTimeoutMs,
    );
    timer.unref();
    const response = await Promise.race([
      runtime.invoke(active.instance.pluginInstanceId, action, input, {
        signal,
        ...(nativeRuntime ? { nativeRuntime } : {}),
      }),
      cancellation,
    ]).finally(() => {
      clearTimeout(timer);
      listener?.[Symbol.dispose]();
    });
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
    registerSession(admission: PluginRuntimeAdmission, registry: SessionImplementationRegistry) {
      const instance = admission.instance;
      const declaration = runtime.agentAdapter(instance.pluginInstanceId, instance.packageDigest);
      const lifetime = runtime.operationActivationSignal(instance.pluginInstanceId);
      if (!declaration || !lifetime) return;
      const ref = { pluginId: instance.pluginId, contributionId: declaration.id };
      const providers = new Map<string, ReturnType<typeof createAgentAdapterSessionProvider>>();
      return registry.register(
        ref,
        ({ catId }) => {
          const existing = providers.get(catId);
          if (existing) return existing;
          const invoke: AgentAdapterSessionInvocation = async (action, args, signal, hostSession) =>
            (await read(ref, action, args, { signal, lifetime, catId, hostSession })).response;
          const provider = createAgentAdapterSessionProvider(invoke, lifetime);
          providers.set(catId, provider);
          return provider;
        },
        JSON.stringify([sessionImplementationKey(ref), declaration.protocolVersion]),
      );
    },
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
      const { active, response } = await read(ref, 'detect', { refresh: options?.refresh ?? false }, options);
      const result = parseAgentAdapterDetection(response);
      if (!result.success)
        throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'Agent adapter returned invalid detection data');
      return { ...result.data, binding: binding(active.instance, active.declaration.id) };
    },
    async quota(
      ref: { pluginId: string; contributionId: string },
      options?: { signal?: AbortSignal; account?: AgentAdapterAccountScope; catalog?: AdapterCatalogIdentity },
    ) {
      const { active, response } = await read(ref, 'quota', {}, options);
      const quota = parseAgentAdapterQuota(response);
      if (!quota.success)
        throw new ExternalPluginRuntimeError(
          'PROTOCOL_VIOLATION',
          'Agent adapter returned an invalid quota observation',
        );
      return { observation: quota.data, binding: binding(active.instance, active.declaration.id) };
    },
    async describe(ref: { pluginId: string; contributionId: string }, options?: { signal?: AbortSignal }) {
      const { active, response } = await read(ref, 'describe', {}, options);
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
