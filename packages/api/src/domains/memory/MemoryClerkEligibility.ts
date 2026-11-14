import type { CatConfig } from '@cat-cafe/shared';
import { providerRequiresThreadWorkspace } from '../../config/account-resolver.js';
import { requiresAgyThreadWorkspace } from '../cats/services/agents/invocation/execution-workspace.js';
import type { AgentRegistry } from '../cats/services/agents/registry/AgentRegistry.js';

/** Reads the registered implementation, not a cat-name/provider guess. Never starts a model. */
export function createMemoryClerkEligibility(deps: {
  agentRegistry: Pick<AgentRegistry, 'has' | 'get'>;
  getConfig: (catId: string) => CatConfig | undefined;
}): (catId: string) => boolean {
  return (catId) => {
    try {
      const config = deps.getConfig(catId);
      if (!config || !deps.agentRegistry.has(catId)) return false;
      const service = deps.agentRegistry.get(catId);
      const context = service.contextCapability?.();
      if (
        !context?.provider ||
        !context.carrier ||
        ['unknown', 'other'].includes(context.provider) ||
        ['unknown', 'other'].includes(context.carrier)
      )
        return false;
      const declaredClient = service.implementationSnapshot?.().clientId;
      if (declaredClient && declaredClient !== config.clientId) return false;
      return !providerRequiresThreadWorkspace(config.clientId) && !requiresAgyThreadWorkspace(service);
    } catch {
      // An unavailable/refreshed implementation cannot consume a durable receipt.
      return false;
    }
  };
}
