import type { AgentService } from '../../types.js';
import { agentServiceGeneration } from '../registry/AgentRegistry.js';
import { ExecutionAdmissionConflict } from '../registry/AgentServiceUnavailableError.js';
import type { FrozenExecutionBinding } from './execution-account-binding.js';

/** Own preflight pins independently of whether a provider stream is ever started. */
export class InvocationServiceScope {
  private readonly views = new Set<AgentService>();
  private disposed = false;

  pin(service: AgentService): AgentService {
    if (this.disposed) throw new Error('Invocation service scope released');
    const view = service.forInvocation?.() ?? service;
    agentServiceGeneration(view, service);
    this.views.add(view);
    return view;
  }

  /** Retry one configuration-only capture with a fresh pin; provider invocation is outside this scope. */
  async admit(
    view: AgentService,
    resolve: () => AgentService,
    capture: (service: AgentService) => Promise<FrozenExecutionBinding>,
    signal?: AbortSignal,
  ) {
    const attempt = async (service: AgentService) => {
      const [captured] = await Promise.allSettled([
        Promise.resolve().then(() => {
          signal?.throwIfAborted();
          return capture(service);
        }),
      ]);
      if (captured.status === 'fulfilled') return { service, executionBinding: captured.value };
      if (this.views.delete(service)) await service.releaseInvocation?.();
      throw captured.reason;
    };
    const [first] = await Promise.allSettled([attempt(view)]);
    if (first.status === 'fulfilled') return first.value;
    if (!(first.reason instanceof ExecutionAdmissionConflict)) throw first.reason;
    signal?.throwIfAborted();
    return attempt(this.pin(resolve()));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const views = [...this.views];
    this.views.clear();
    const results = await Promise.allSettled(views.map((view) => view.releaseInvocation?.()));
    const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Invocation service release failed');
  }
}
