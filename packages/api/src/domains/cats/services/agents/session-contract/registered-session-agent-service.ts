import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, AgentService, AgentServiceOptions, ProviderContinuityPreflight } from '../../types.js';
import { AgentSessionBridgeService } from './AgentSessionBridgeService.js';
import type {
  HostSessionImplementation,
  SessionImplementationRef,
  SessionImplementationRegistry,
} from './implementation-registry.js';
import { sessionImplementationKey } from './implementation-registry.js';
import type { AgentSessionProvider } from './types.js';

interface RegisteredInput {
  catId: CatId;
  ref: SessionImplementationRef;
  registry: SessionImplementationRegistry;
  metadata?: { provider: string; model: string };
  log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void };
}
interface PreparedBinding {
  registration?: symbol;
  source?: HostSessionImplementation;
  service?: AgentService;
  provider?: AgentSessionProvider;
}
export class RegisteredSessionAgentService implements AgentService {
  private cached?: { provider: AgentSessionProvider; bridge: AgentSessionBridgeService; lifetime: AbortController };
  constructor(private readonly input: RegisteredInput) {}
  get implementationKey(): string {
    return sessionImplementationKey(this.input.ref);
  }
  /** Prepare the concrete carrier before synchronous Host admission/prompt assembly. */
  async prepare(): Promise<void> {
    await this.input.registry.resolve(this.input.ref, { catId: this.input.catId })?.prepareHostService?.();
  }
  private hostService(): AgentService | undefined {
    return this.input.registry.resolve(this.input.ref, { catId: this.input.catId })?.hostService?.();
  }
  get injectsL0Natively(): AgentService['injectsL0Natively'] {
    const service = this.hostService();
    return service?.injectsL0Natively?.bind(service);
  }
  get supportsToolExecutionPolicy(): AgentService['supportsToolExecutionPolicy'] {
    const service = this.hostService();
    return service?.supportsToolExecutionPolicy?.bind(service);
  }
  get freshnessCarrierCapability(): AgentService['freshnessCarrierCapability'] {
    const service = this.hostService();
    return service?.freshnessCarrierCapability?.bind(service);
  }
  get contextCapability(): AgentService['contextCapability'] {
    const service = this.hostService();
    return service?.contextCapability?.bind(service);
  }
  get contextBinding(): AgentService['contextBinding'] {
    const service = this.hostService();
    return service?.contextBinding?.bind(service);
  }
  get contextBindingForCapacity(): AgentService['contextBindingForCapacity'] {
    const service = this.hostService();
    return service?.contextBindingForCapacity?.bind(service);
  }
  private preparedBinding(): PreparedBinding {
    const registration = this.input.registry.registrationToken(this.input.ref);
    const source = this.input.registry.resolve(this.input.ref, { catId: this.input.catId });
    const service = source?.hostService?.();
    return {
      registration,
      source,
      service,
      provider: service && source?.bindHostService ? source.bindHostService(service) : source,
    };
  }
  forInvocation(): AgentService {
    const binding = this.preparedBinding();
    const { service } = binding;
    const view: AgentService = {
      forInvocation: () => view,
      injectsL0Natively: service?.injectsL0Natively?.bind(service),
      supportsToolExecutionPolicy: service?.supportsToolExecutionPolicy?.bind(service),
      freshnessCarrierCapability: service?.freshnessCarrierCapability?.bind(service),
      contextCapability: service?.contextCapability?.bind(service),
      contextBinding: service?.contextBinding?.bind(service),
      contextBindingForCapacity: service?.contextBindingForCapacity?.bind(service),
      invoke: (prompt, options) => this.run(prompt, options, binding),
      invokeWithContinuityPreflight: (preflight, options) => this.run(preflight, options, binding),
    };
    return view;
  }
  invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    return this.forInvocation().invoke(prompt, options);
  }
  invokeWithContinuityPreflight(
    preflight: ProviderContinuityPreflight,
    options?: AgentServiceOptions,
  ): AsyncIterable<AgentMessage> {
    return this.run(preflight, options, this.preparedBinding());
  }
  async releaseAll(reason: string): Promise<void> {
    const cached = this.cached;
    this.cached = undefined;
    cached?.lifetime.abort();
    await cached?.bridge.releaseAll(reason);
  }
  private async *run(
    prompt: string | ProviderContinuityPreflight,
    options: AgentServiceOptions | undefined,
    binding: PreparedBinding,
  ): AsyncIterable<AgentMessage> {
    const source = binding.source;
    const provider = binding?.provider;
    const metadata = { ...(this.input.metadata ?? { provider: 'session-contract', model: 'unknown' }) };
    let code: string | undefined;
    if (!this.input.registry.has(this.input.ref) || !source) {
      await this.releaseAll('implementation_unavailable');
      code = 'session_implementation_unavailable';
    } else if (
      this.input.registry.registrationToken(this.input.ref) !== binding.registration ||
      source.hostService?.() !== binding.service ||
      (binding.service && source.bindHostService?.(binding.service) !== provider)
    )
      code = 'session_host_generation_changed';
    else if (source.prepareHostService && !binding?.service) code = 'session_host_service_unavailable';
    else if (!provider) code = 'session_host_service_unavailable';
    else if (
      options?.toolExecutionPolicy &&
      binding.service?.supportsToolExecutionPolicy?.(options.toolExecutionPolicy) !== true
    )
      code = 'read_only_tool_policy_unavailable';
    else if (!options?.hostSessionId) code = 'host_session_unavailable';
    if (code) {
      for (const type of ['error', 'done'] as const)
        yield {
          type,
          errorCode: code,
          ...(type === 'error'
            ? {
                error:
                  code === 'session_implementation_unavailable' && 'pluginId' in this.input.ref
                    ? `绑定的 ACP client 暂不可用（${this.input.ref.pluginId}/${this.input.ref.contributionId}）。请在设置 → 插件集成中检查配置并启用插件，或为成员选择其他 client。`
                    : code,
              }
            : {}),
          catId: this.input.catId,
          metadata: { ...metadata },
          timestamp: Date.now(),
        };
      return;
    }
    let cached = this.cached;
    if (!cached || cached.provider !== provider) {
      const previous = this.cached;
      cached = {
        provider: provider as AgentSessionProvider,
        lifetime: new AbortController(),
        bridge: new AgentSessionBridgeService({
          ...this.input,
          provider: provider as AgentSessionProvider,
          passHostOptions: true,
          resolveHostSession: (opts) => ({
            sessionId: opts?.hostSessionId ?? '',
            resumeNativeSessionId: opts?.sessionId,
          }),
        }),
      };
      this.cached = cached;
      previous?.lifetime.abort();
      await previous?.bridge.releaseAll('implementation_replaced');
    }
    if (cached.lifetime.signal.aborted) {
      yield {
        type: 'done',
        catId: this.input.catId,
        timestamp: Date.now(),
        metadata: { ...metadata },
        errorCode: 'cancelled',
      };
      return;
    }
    const signal = AbortSignal.any([cached.lifetime.signal, ...(options?.signal ? [options.signal] : [])]);
    this.input.log?.info({ catId: this.input.catId }, '[session-contract] bridged');
    yield* typeof prompt === 'string'
      ? cached.bridge.invoke(prompt, { ...options, signal })
      : cached.bridge.invokeWithContinuityPreflight(prompt, { ...options, signal });
  }
}

export const selectSessionAgentService = <T>(
  ref: SessionImplementationRef | undefined,
  registered: (ref: SessionImplementationRef) => T,
  existing: () => T,
): T => (ref ? registered(ref) : existing());
