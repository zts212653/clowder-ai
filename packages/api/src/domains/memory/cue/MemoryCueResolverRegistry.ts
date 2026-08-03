import { createHash } from 'node:crypto';
import {
  type CueEnvelopeV1,
  MEMORY_CUE_INVALIDATORS,
  RECALL_OPPORTUNITY_CATALOG_VERSION,
  RECALL_RESOLVER_FAMILIES,
  type RecallOpportunityV1,
  type RecallResolverFamily,
  type RecallScopeV1,
} from '@cat-cafe/shared';

export interface MemoryCueSourceProjection {
  title: string;
  summary: string;
  anchor: string;
  revision: string;
  visibility: 'owner_public' | 'owner_private';
  drillFamily: CueEnvelopeV1['drill']['family'];
}

export interface CreateMemoryCueDrillHandleInput {
  cueId: string;
  opportunityId: string;
  catalogVersion: typeof RECALL_OPPORTUNITY_CATALOG_VERSION;
  resolverFamily: RecallResolverFamily;
  resolverVersion: number;
  family: CueEnvelopeV1['drill']['family'];
  anchor: string;
  revision: string;
  scope: RecallScopeV1;
  expiresAt: number;
}

export interface MemoryCueResolverContext {
  now: number;
  expiresAt: number;
  createDrillHandle(input: CreateMemoryCueDrillHandleInput): string;
}

export interface MemoryCueResolver {
  readonly family: RecallResolverFamily;
  readonly resolverVersion: number;
  resolve(opportunity: RecallOpportunityV1, context: MemoryCueResolverContext): Promise<readonly CueEnvelopeV1[]>;
}

export const ZERO_ONLY_V1_RESOLVER_FAMILIES = Object.freeze(['profile' as const, 'project_knowledge' as const]);

export const RECALL_RESOLVER_ADMISSION_V1 = Object.freeze({
  person_entity: 'catalog' as const,
  operational_precedent: 'catalog' as const,
  taste: 'catalog' as const,
  profile: 'zero_only_v1' as const,
  project_knowledge: 'zero_only_v1' as const,
});

export function buildCueEnvelope(input: {
  opportunity: RecallOpportunityV1;
  family: RecallResolverFamily;
  resolverVersion: number;
  whyNow: string;
  source: MemoryCueSourceProjection;
  context: MemoryCueResolverContext;
}): CueEnvelopeV1 {
  const cueId = `cue_${createHash('sha256')
    .update(
      [
        RECALL_OPPORTUNITY_CATALOG_VERSION,
        input.opportunity.opportunityId,
        input.family,
        input.source.anchor,
        input.source.revision,
      ].join('\0'),
    )
    .digest('hex')
    .slice(0, 32)}`;
  return {
    v: 1,
    cueId,
    opportunityId: input.opportunity.opportunityId,
    catalogVersion: RECALL_OPPORTUNITY_CATALOG_VERSION,
    resolverFamily: input.family,
    resolverVersion: input.resolverVersion,
    whyNow: input.whyNow,
    title: input.source.title,
    summary: input.source.summary,
    source: {
      anchor: input.source.anchor,
      revision: input.source.revision,
      visibility: input.source.visibility,
    },
    drill: {
      family: input.source.drillFamily,
      handle: input.context.createDrillHandle({
        family: input.source.drillFamily,
        cueId,
        opportunityId: input.opportunity.opportunityId,
        catalogVersion: RECALL_OPPORTUNITY_CATALOG_VERSION,
        resolverFamily: input.family,
        resolverVersion: input.resolverVersion,
        anchor: input.source.anchor,
        revision: input.source.revision,
        scope: input.opportunity.scope,
        expiresAt: input.context.expiresAt,
      }),
    },
    scope: input.opportunity.scope,
    invalidators: [...MEMORY_CUE_INVALIDATORS],
    expiresAt: input.context.expiresAt,
  };
}

export class MemoryCueResolverRegistry {
  private readonly resolvers = new Map<RecallResolverFamily, MemoryCueResolver>();

  constructor(resolvers: readonly MemoryCueResolver[]) {
    for (const resolver of resolvers) {
      if (!(RECALL_RESOLVER_FAMILIES as readonly string[]).includes(resolver.family)) {
        throw new Error(`Unknown memory cue resolver family: ${resolver.family}`);
      }
      if (this.resolvers.has(resolver.family)) {
        throw new Error(`Duplicate memory cue resolver family: ${resolver.family}`);
      }
      this.resolvers.set(resolver.family, resolver);
    }
    const missing = RECALL_RESOLVER_FAMILIES.filter((family) => !this.resolvers.has(family));
    if (missing.length > 0) {
      throw new Error(`Missing memory cue resolver families: ${missing.join(', ')}`);
    }
  }

  families(): RecallResolverFamily[] {
    return RECALL_RESOLVER_FAMILIES.filter((family) => this.resolvers.has(family));
  }

  get(family: RecallResolverFamily): MemoryCueResolver {
    const resolver = this.resolvers.get(family);
    if (!resolver) throw new Error(`Unregistered memory cue resolver family: ${family}`);
    return resolver;
  }
}
