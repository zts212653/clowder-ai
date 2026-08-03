import { createHash } from 'node:crypto';
import type {
  DeliveryDecisionOpportunityV1,
  JudgmentSurfaceEnteredOpportunityV1,
  RecallOpportunityV1,
  RecallScopeV1,
  SubjectSeenOpportunityV1,
} from '@cat-cafe/shared';
import type { MemoryCuePlaneService } from './MemoryCuePlaneService.js';
import type { CreateMemoryCueDrillHandleInput } from './MemoryCueResolverRegistry.js';

export type MemoryCueOpportunitySeed =
  | {
      kind: 'subject_seen';
      producer: 'entity_nudge';
      occurredAt: number;
      payload: SubjectSeenOpportunityV1['payload'];
    }
  | {
      kind: 'delivery_decision';
      producer: 'github_ci';
      occurredAt: number;
      payload: DeliveryDecisionOpportunityV1['payload'];
    }
  | {
      kind: 'judgment_surface_entered';
      producer: 'workflow_sop';
      occurredAt: number;
      payload: JudgmentSurfaceEnteredOpportunityV1['payload'];
    };

export interface ResolveMemoryCueInvocationPromptInput {
  seeds: readonly MemoryCueOpportunitySeed[];
  serverScope: RecallScopeV1;
  now: number;
}

export interface MemoryCueInvocationPromptResolution {
  promptSegment: string;
  admittedOpportunityIds: readonly string[];
}

export interface MemoryCueInvocationPromptResolver {
  resolve(input: ResolveMemoryCueInvocationPromptInput): Promise<MemoryCueInvocationPromptResolution>;
}

export function memoryCueOpportunityId(seed: MemoryCueOpportunitySeed, scope: RecallScopeV1): string {
  const digest = createHash('sha256')
    .update([seed.kind, seed.producer, scope.threadId, JSON.stringify(seed.payload)].join('\0'))
    .digest('hex')
    .slice(0, 40);
  return `memory-cue-opportunity-${digest}`;
}

function bindSeed(seed: MemoryCueOpportunitySeed, scope: RecallScopeV1): RecallOpportunityV1 {
  const base = {
    v: 1 as const,
    opportunityId: memoryCueOpportunityId(seed, scope),
    consumer: 'agent_route' as const,
    scope,
    occurredAt: seed.occurredAt,
  };
  switch (seed.kind) {
    case 'subject_seen':
      return { ...base, kind: seed.kind, producer: seed.producer, payload: seed.payload };
    case 'delivery_decision':
      return { ...base, kind: seed.kind, producer: seed.producer, payload: seed.payload };
    case 'judgment_surface_entered':
      return { ...base, kind: seed.kind, producer: seed.producer, payload: seed.payload };
  }
}

/**
 * Invocation-bound adapter between server-owned producer seeds and the Cue Plane.
 * Route strategies never invent invocation ids: they carry scope-free seeds until
 * invokeSingleCat has created the callback-authenticated child invocation.
 */
export class MemoryCueInvocationPromptService implements MemoryCueInvocationPromptResolver {
  constructor(
    private readonly deps: {
      plane: MemoryCuePlaneService;
      createDrillHandle(input: CreateMemoryCueDrillHandleInput): string;
    },
  ) {}

  async resolve(input: ResolveMemoryCueInvocationPromptInput): Promise<MemoryCueInvocationPromptResolution> {
    const invocationState = { seenDedupeKeys: new Set<string>() };
    const segments: string[] = [];
    const admittedOpportunityIds: string[] = [];
    for (const seed of input.seeds) {
      const candidate = bindSeed(seed, input.serverScope);
      const resolved = await this.deps.plane.resolve({
        candidate,
        serverScope: input.serverScope,
        invocationState,
        now: input.now,
        createDrillHandle: (coordinate) => this.deps.createDrillHandle(coordinate),
      });
      if (resolved.promptSegment) {
        segments.push(resolved.promptSegment);
        admittedOpportunityIds.push(candidate.opportunityId);
      }
    }
    return { promptSegment: segments.join('\n\n'), admittedOpportunityIds };
  }
}
