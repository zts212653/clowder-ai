import type { CatId } from '@cat-cafe/shared';
import {
  type HostSessionImplementation,
  type SessionImplementationRegistry,
  sessionImplementationKey,
} from './implementation-registry.js';
import type { AgentProviderDeclaration } from './plugin-agent-provider.js';
import type { AgentSessionProvider } from './types.js';
export function registerPluginAgentProvider(
  registry: SessionImplementationRegistry,
  input: {
    pluginId: string;
    declaration: AgentProviderDeclaration;
    createProvider(declaration: AgentProviderDeclaration, ctx: { catId: CatId }): AgentSessionProvider;
  },
): { key: string; unregister(): void; disposeHostServices(): Promise<void> } {
  const ref = { pluginId: input.pluginId, contributionId: input.declaration.id };
  const providers = new Map<CatId, HostSessionImplementation>();
  const unregister = registry.register(ref, (ctx) => {
    let provider = providers.get(ctx.catId);
    if (!provider) {
      provider = input.createProvider(input.declaration, ctx);
      providers.set(ctx.catId, provider);
    }
    return provider;
  });
  return {
    key: sessionImplementationKey(ref),
    unregister,
    async disposeHostServices() {
      const results = await Promise.allSettled(
        [...providers.values()].map((provider) => provider.disposeHostService?.()),
      );
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Plugin Host service disposal failed');
    },
  };
}
