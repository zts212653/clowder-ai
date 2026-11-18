import {
  type RoutingPreflightDecisionV1,
  type RoutingQueueAdmissionReceiptV1,
  routingQueueAdmissionReceiptV1Schema,
} from '@cat-cafe/shared';
import type { RoutingExecutionBindingProof } from '../../config/account-routing-capacity.js';
import type {
  SessionCacheExecutionBinding,
  SessionCacheReadPort,
} from '../cats/services/session/cache/SessionCacheReadService.js';
import type { RoutingCandidateCatalogSource } from './RoutingContextReadService.js';
import type { RoutingPreflightService } from './RoutingPreflightService.js';

export interface RoutingDispatchPreflightInput {
  ownerId: string;
  /** Destination scope, not the caller's source thread. */
  threadId?: string;
  targetCatIds: readonly string[];
  intent?: 'review' | 'architecture';
  /** Set only by trusted dispatch ingress, never by agent/user payload. */
  ownerRequestedAttempt?: boolean;
  /** Trusted frozen execution carrier, never caller-provided account identity. */
  executionBindings?: readonly RoutingExecutionBindingProof[];
  cacheExecutionBindings?: readonly SessionCacheExecutionBinding[];
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
      sessionCache?: SessionCacheReadPort;
      now?: () => number;
    },
  ) {}

  async preflight(input: RoutingDispatchPreflightInput): Promise<RoutingPreflightDecisionV1> {
    const observedAt = this.dependencies.now?.() ?? Date.now();
    try {
      // Preflight needs the complete catalog to offer truthful alternatives;
      // targetCatIds scopes verdicts, not the resolver's candidate universe.
      const catalog = await this.dependencies.catalogSource.load({
        ownerId: input.ownerId,
        observedAt,
        ...(input.executionBindings ? { executionBindings: input.executionBindings } : {}),
      });
      const decision = await this.dependencies.preflightService.preflight({
        ownerId: input.ownerId,
        observedAt,
        catalogRevision: catalog.catalogRevision,
        candidates: catalog.candidates,
        targetCatIds: input.targetCatIds,
        ...(input.executionBindings ? { requireCapacityProof: true } : {}),
        ...(input.ownerRequestedAttempt ? { ownerRequestedAttempt: true } : {}),
        ...(input.intent ? { intent: input.intent } : {}),
      });
      return this.withSessionCache(decision, input);
    } catch {
      return this.withSessionCache(unavailableRoutingDispatchDecision(input, observedAt, 'catalog_error'), input);
    }
  }

  private async withSessionCache(decision: RoutingPreflightDecisionV1, input: RoutingDispatchPreflightInput) {
    const fallback = {
      status: 'unknown',
      estimated: true,
      source: 'unavailable',
      reason: 'thread_or_reader_unavailable',
    } as const;
    try {
      const rows =
        input.threadId && this.dependencies.sessionCache
          ? await this.dependencies.sessionCache.read({
              ownerId: input.ownerId,
              threadId: input.threadId,
              catIds: input.targetCatIds,
              observedAt: decision.observedAt,
              ...(input.cacheExecutionBindings ? { executionBindings: input.cacheExecutionBindings } : {}),
            })
          : [];
      const byCat = new Map(rows.map((row) => [row.catId, row.warmth]));
      return {
        ...decision,
        targets: decision.targets.map((target) => ({
          ...target,
          cacheWarmth: byCat.get(target.targetCatId) ?? fallback,
        })),
      };
    } catch {
      return { ...decision, targets: decision.targets.map((target) => ({ ...target, cacheWarmth: fallback })) };
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
    stage: 'execution_preflight' as const,
    v: decision.v,
    ownerId: decision.ownerId,
    observedAt: decision.observedAt,
    resolverState: decision.resolverState,
    ...(decision.snapshotRef ? { snapshotRef: decision.snapshotRef } : {}),
    target,
  };
}

/** A readonly post-enqueue observation. It is deliberately not an execution verdict. */
export async function observeRoutingQueueAdmission(
  port: RoutingDispatchPreflightPort,
  input: RoutingDispatchPreflightInput,
): Promise<RoutingQueueAdmissionReceiptV1> {
  const observation = await preflightRoutingDispatch(port, input);
  return routingQueueAdmissionReceiptV1Schema.parse({
    v: 1,
    stage: 'queue_admitted',
    executionPreflight: 'pending',
    ownerId: observation.ownerId,
    observedAt: observation.observedAt,
    ...(observation.snapshotRef ? { snapshotRef: observation.snapshotRef } : {}),
    targets: observation.targets.map((target) => ({
      targetCatId: target.targetCatId,
      availabilityObservation:
        target.disposition === 'allowed' ? 'available' : target.disposition === 'rejected' ? 'unavailable' : 'warned',
      reasons: target.reasons,
      ...(target.capacityFacts ? { capacityFacts: target.capacityFacts } : {}),
      ...(target.cacheWarmth ? { cacheWarmth: target.cacheWarmth } : {}),
    })),
  });
}

/** Only a rejection changes the requested delivery and belongs in chat. */
export function isUserVisibleRoutingPreflightReceipt(
  receipt: ReturnType<typeof routingDispatchPreflightReceipt>,
): boolean {
  return receipt.target.disposition === 'rejected';
}
