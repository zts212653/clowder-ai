import type { AgentService } from '../../types.js';

/** Own preflight pins independently of whether a provider stream is ever started. */
export class InvocationServiceScope {
  private readonly views = new Set<AgentService>();
  private disposed = false;

  pin(service: AgentService): AgentService {
    if (this.disposed) throw new Error('Invocation service scope released');
    const view = service.forInvocation?.() ?? service;
    this.views.add(view);
    return view;
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
