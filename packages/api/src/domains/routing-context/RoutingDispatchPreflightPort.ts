import type { RoutingPreflightDecisionV1 } from '@cat-cafe/shared';
import type { RoutingCandidateCatalogSource } from './RoutingContextReadService.js';
import type { RoutingPreflightService } from './RoutingPreflightService.js';

export interface RoutingDispatchPreflightInput {
  ownerId: string;
  targetCatIds: readonly string[];
  intent?: 'review' | 'architecture';
}

export interface RoutingDispatchPreflightPort {
  preflight(input: RoutingDispatchPreflightInput): Promise<RoutingPreflightDecisionV1>;
}

/** Shared conservative scope inference for cognition and actual-send consumers. */
export function inferRoutingContextIntent(message: string): 'review' | 'architecture' | undefined {
  const lower = message.toLowerCase();
  if (
    lower.includes('review') ||
    lower.includes('lgtm') ||
    lower.includes('merge') ||
    /\bpr\b/i.test(lower) ||
    message.includes('合入') ||
    message.includes('开 PR') ||
    message.includes('云端 review') ||
    message.includes('帮我看看') ||
    message.includes('请 reviewer 看看') ||
    message.includes('请 review')
  ) {
    return 'review';
  }
  if (
    lower.includes('architecture') ||
    lower.includes('tradeoff') ||
    message.includes('架构') ||
    message.includes('设计') ||
    message.includes('方案')
  ) {
    return 'architecture';
  }
  return undefined;
}

export function unavailableRoutingDispatchDecision(
  input: RoutingDispatchPreflightInput,
  observedAt: number,
  failureClass: string,
): RoutingPreflightDecisionV1 {
  return {
    v: 1,
    ownerId: input.ownerId,
    observedAt,
    resolverState: 'degraded',
    targets: [...new Set(input.targetCatIds)].slice(0, 64).map((targetCatId) => ({
      targetCatId,
      disposition: 'warned',
      reasons: [
        {
          code: 'routing_context_unavailable',
          summary: 'Routing context is temporarily unavailable; the requested target remains unchanged',
          sourceRefs: [`routing-context:${failureClass}`],
        },
      ],
      alternatives: [],
    })),
  };
}

/** Binds every actual-send check to a fresh runtime catalog and the shared resolver circuit. */
export class RuntimeRoutingDispatchPreflight implements RoutingDispatchPreflightPort {
  constructor(
    private readonly dependencies: {
      catalogSource: RoutingCandidateCatalogSource;
      preflightService: Pick<RoutingPreflightService, 'preflight'>;
      now?: () => number;
    },
  ) {}

  async preflight(input: RoutingDispatchPreflightInput): Promise<RoutingPreflightDecisionV1> {
    const observedAt = this.dependencies.now?.() ?? Date.now();
    try {
      // Preflight needs the complete catalog to offer truthful alternatives;
      // targetCatIds scopes verdicts, not the resolver's candidate universe.
      const catalog = await this.dependencies.catalogSource.load({ ownerId: input.ownerId });
      return await this.dependencies.preflightService.preflight({
        ownerId: input.ownerId,
        observedAt,
        catalogRevision: catalog.catalogRevision,
        candidates: catalog.candidates,
        targetCatIds: input.targetCatIds,
        ...(input.intent ? { intent: input.intent } : {}),
      });
    } catch {
      return unavailableRoutingDispatchDecision(input, observedAt, 'catalog_error');
    }
  }
}

export async function preflightRoutingDispatch(
  port: RoutingDispatchPreflightPort,
  input: RoutingDispatchPreflightInput,
): Promise<RoutingPreflightDecisionV1> {
  try {
    return await port.preflight(input);
  } catch {
    return unavailableRoutingDispatchDecision(input, Date.now(), 'consumer_error');
  }
}

export function routingDispatchPreflightReceipt(decision: RoutingPreflightDecisionV1, targetCatId: string) {
  const target = decision.targets.find((entry) => entry.targetCatId === targetCatId);
  if (!target) throw new Error(`routing preflight omitted requested target: ${targetCatId}`);
  return {
    type: 'routing_preflight' as const,
    v: decision.v,
    ownerId: decision.ownerId,
    observedAt: decision.observedAt,
    resolverState: decision.resolverState,
    ...(decision.snapshotRef ? { snapshotRef: decision.snapshotRef } : {}),
    target,
  };
}

/** Only a rejection changes the requested delivery and belongs in chat. */
export function isUserVisibleRoutingPreflightReceipt(
  receipt: ReturnType<typeof routingDispatchPreflightReceipt>,
): boolean {
  return receipt.target.disposition === 'rejected';
}
