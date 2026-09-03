import type { VerifiedAgent } from '@cat-cafe/collective-connector';

interface TurnExecutionProvenanceRecord {
  readonly catId: string;
  readonly status: 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
}

interface CollectiveAgentVerifierOptions {
  readonly resolveCatDisplayName: (catId: string) => string | undefined;
  readonly readTurnExecution: (
    invocationId: string,
  ) => TurnExecutionProvenanceRecord | null | undefined | Promise<TurnExecutionProvenanceRecord | null | undefined>;
}

export function createCollectiveAgentVerifier(options: CollectiveAgentVerifierOptions) {
  return async (agent: VerifiedAgent): Promise<boolean> => {
    const displayName = options.resolveCatDisplayName(agent.catId);
    if (agent.agentId !== agent.catId || !displayName || agent.displayName !== displayName) return false;
    const execution = await options.readTurnExecution(agent.sessionRef);
    return Boolean(execution && execution.status === 'running' && execution.catId === agent.catId);
  };
}
