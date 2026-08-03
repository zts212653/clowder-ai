import {
  deliveryDecisionOpportunityV1Schema,
  judgmentSurfaceEnteredOpportunityV1Schema,
  RECALL_OPPORTUNITY_CATALOG_VERSION,
  type RecallOpportunityV1,
  type RecallResolverFamily,
  type RecallScopeV1,
  recallOpportunityV1Schema,
  subjectSeenOpportunityV1Schema,
} from '@cat-cafe/shared';
import type { z } from 'zod';

export interface RecallOpportunityCatalogEntry {
  readonly kind: RecallOpportunityV1['kind'];
  readonly producer: RecallOpportunityV1['producer'];
  readonly consumer: 'agent_route';
  readonly payloadSchema: z.ZodType;
  readonly scopeBinding: 'server_exact';
  readonly resolverFamilies: readonly RecallResolverFamily[];
  readonly maxCues: number;
  readonly maxPromptTokens: number;
  readonly expiresAfterMs: number;
  dedupeKey(opportunity: RecallOpportunityV1): string;
}

const entries: readonly RecallOpportunityCatalogEntry[] = Object.freeze([
  Object.freeze({
    kind: 'subject_seen',
    producer: 'entity_nudge',
    consumer: 'agent_route',
    payloadSchema: subjectSeenOpportunityV1Schema.shape.payload,
    scopeBinding: 'server_exact',
    resolverFamilies: Object.freeze(['person_entity'] as const),
    maxCues: 1,
    maxPromptTokens: 300,
    expiresAfterMs: 5 * 60_000,
    dedupeKey(opportunity: RecallOpportunityV1): string {
      return opportunity.kind === 'subject_seen' ? `subject_seen\0${opportunity.payload.entityId}` : 'invalid';
    },
  }),
  Object.freeze({
    kind: 'delivery_decision',
    producer: 'github_ci',
    consumer: 'agent_route',
    payloadSchema: deliveryDecisionOpportunityV1Schema.shape.payload,
    scopeBinding: 'server_exact',
    resolverFamilies: Object.freeze(['operational_precedent'] as const),
    maxCues: 1,
    maxPromptTokens: 420,
    expiresAfterMs: 30 * 60_000,
    dedupeKey(opportunity: RecallOpportunityV1): string {
      return opportunity.kind === 'delivery_decision'
        ? [
            'delivery_decision',
            opportunity.payload.repoFullName,
            opportunity.payload.prNumber,
            opportunity.payload.headSha,
          ].join('\0')
        : 'invalid';
    },
  }),
  Object.freeze({
    kind: 'judgment_surface_entered',
    producer: 'workflow_sop',
    consumer: 'agent_route',
    payloadSchema: judgmentSurfaceEnteredOpportunityV1Schema.shape.payload,
    scopeBinding: 'server_exact',
    resolverFamilies: Object.freeze(['taste'] as const),
    maxCues: 1,
    maxPromptTokens: 300,
    expiresAfterMs: 5 * 60_000,
    dedupeKey(opportunity: RecallOpportunityV1): string {
      return opportunity.kind === 'judgment_surface_entered'
        ? [
            'judgment_surface_entered',
            opportunity.payload.featureId,
            opportunity.payload.stage,
            opportunity.payload.selectedSkill,
          ].join('\0')
        : 'invalid';
    },
  }),
]);

export const RECALL_OPPORTUNITY_CATALOG_V1 = Object.freeze({
  version: RECALL_OPPORTUNITY_CATALOG_VERSION,
  entries,
});

function sameScope(left: RecallScopeV1, right: RecallScopeV1): boolean {
  return (
    left.ownerUserId === right.ownerUserId &&
    left.threadId === right.threadId &&
    left.invocationId === right.invocationId
  );
}

export function admitRecallOpportunity(candidate: unknown, serverScope: RecallScopeV1): RecallOpportunityV1 | null {
  const parsed = recallOpportunityV1Schema.safeParse(candidate);
  if (!parsed.success || !sameScope(parsed.data.scope, serverScope)) return null;
  const entry = entries.find((item) => item.kind === parsed.data.kind && item.producer === parsed.data.producer);
  if (!entry || !entry.payloadSchema.safeParse(parsed.data.payload).success) return null;
  return parsed.data;
}

export function getRecallOpportunityCatalogEntry(opportunity: RecallOpportunityV1): RecallOpportunityCatalogEntry {
  const entry = entries.find(
    (candidate) => candidate.kind === opportunity.kind && candidate.producer === opportunity.producer,
  );
  if (!entry) throw new Error('Recall opportunity is not admitted by catalog v1');
  return entry;
}
