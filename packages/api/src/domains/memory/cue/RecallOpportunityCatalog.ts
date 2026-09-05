import {
  acceptedDecisionRequiredOpportunityV1Schema,
  approvedTasteInvokedOpportunityV1Schema,
  deliveryDecisionOpportunityV1Schema,
  judgmentSurfaceEnteredOpportunityV1Schema,
  ownedSeedAvailableOpportunityV1Schema,
  profileRevisionAvailableOpportunityV1Schema,
  projectSourceRequiredOpportunityV1Schema,
  RECALL_OPPORTUNITY_CATALOG_VERSION,
  type RecallOpportunityV1,
  type RecallResolverFamily,
  type RecallScopeV1,
  recallOpportunityV1Schema,
  recentEventAvailableOpportunityV1Schema,
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
    maxCues: 4,
    maxPromptTokens: 1_800,
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
  Object.freeze({
    kind: 'approved_taste_invoked',
    producer: 'owner_message',
    consumer: 'agent_route',
    payloadSchema: approvedTasteInvokedOpportunityV1Schema.shape.payload,
    scopeBinding: 'server_exact',
    resolverFamilies: Object.freeze(['taste'] as const),
    maxCues: 1,
    maxPromptTokens: 300,
    expiresAfterMs: 5 * 60_000,
    dedupeKey(opportunity: RecallOpportunityV1): string {
      return opportunity.kind === 'approved_taste_invoked'
        ? ['approved_taste_invoked', opportunity.payload.triggerKey, opportunity.payload.sourceMessageId].join('\0')
        : 'invalid';
    },
  }),
  Object.freeze({
    kind: 'profile_revision_available',
    producer: 'profile_repository',
    consumer: 'agent_route',
    payloadSchema: profileRevisionAvailableOpportunityV1Schema.shape.payload,
    scopeBinding: 'server_exact',
    resolverFamilies: Object.freeze(['profile'] as const),
    maxCues: 1,
    maxPromptTokens: 260,
    expiresAfterMs: 5 * 60_000,
    dedupeKey(opportunity: RecallOpportunityV1): string {
      return opportunity.kind === 'profile_revision_available'
        ? ['profile_revision_available', opportunity.payload.profileUri, opportunity.payload.sourceRevision].join('\0')
        : 'invalid';
    },
  }),
  Object.freeze({
    kind: 'recent_event_available',
    producer: 'event_memory',
    consumer: 'agent_route',
    payloadSchema: recentEventAvailableOpportunityV1Schema.shape.payload,
    scopeBinding: 'server_exact',
    resolverFamilies: Object.freeze(['event'] as const),
    maxCues: 1,
    // Includes the entropy-dense encrypted drill capability and source hashes;
    // otherwise valid Event cues can be silently omitted before presentation.
    maxPromptTokens: 320,
    expiresAfterMs: 5 * 60_000,
    dedupeKey(opportunity: RecallOpportunityV1): string {
      return opportunity.kind === 'recent_event_available'
        ? [
            'recent_event_available',
            opportunity.payload.eventId,
            opportunity.payload.subjectThreadId,
            opportunity.payload.sourceRevision,
          ].join('\0')
        : 'invalid';
    },
  }),
  Object.freeze({
    kind: 'accepted_decision_required',
    producer: 'owner_message',
    consumer: 'agent_route',
    payloadSchema: acceptedDecisionRequiredOpportunityV1Schema.shape.payload,
    scopeBinding: 'server_exact',
    resolverFamilies: Object.freeze(['decision'] as const),
    maxCues: 1,
    // Canonical ADR metadata plus the encrypted drill capability is larger than
    // the short test projection. Keep one bounded cue without silently dropping
    // a valid source before the pointer-only provider presentation boundary.
    maxPromptTokens: 420,
    expiresAfterMs: 5 * 60_000,
    dedupeKey(opportunity: RecallOpportunityV1): string {
      return opportunity.kind === 'accepted_decision_required'
        ? ['accepted_decision_required', opportunity.payload.decisionAnchor, opportunity.payload.sourceMessageId].join(
            '\0',
          )
        : 'invalid';
    },
  }),
  Object.freeze({
    kind: 'project_source_required',
    producer: 'task_context',
    consumer: 'agent_route',
    payloadSchema: projectSourceRequiredOpportunityV1Schema.shape.payload,
    scopeBinding: 'server_exact',
    resolverFamilies: Object.freeze(['project_knowledge'] as const),
    maxCues: 1,
    // Canonical feature metadata plus the encrypted drill capability is larger
    // than the short test projection. The cue remains single-source and bounded.
    maxPromptTokens: 420,
    expiresAfterMs: 5 * 60_000,
    dedupeKey(opportunity: RecallOpportunityV1): string {
      return opportunity.kind === 'project_source_required'
        ? ['project_source_required', opportunity.payload.featureId, opportunity.payload.selectionSource].join('\0')
        : 'invalid';
    },
  }),
  Object.freeze({
    kind: 'owned_seed_available',
    producer: 'present_loop',
    consumer: 'agent_route',
    payloadSchema: ownedSeedAvailableOpportunityV1Schema.shape.payload,
    scopeBinding: 'server_exact',
    resolverFamilies: Object.freeze(['cat_owned_seed'] as const),
    maxCues: 1,
    maxPromptTokens: 360,
    expiresAfterMs: 5 * 60_000,
    dedupeKey(opportunity: RecallOpportunityV1): string {
      return opportunity.kind === 'owned_seed_available'
        ? [
            'owned_seed_available',
            opportunity.payload.runId,
            opportunity.payload.producingCatId,
            opportunity.payload.seedId,
            opportunity.payload.sourceRevision,
          ].join('\0')
        : 'invalid';
    },
  }),
]);

export const RECALL_OPPORTUNITY_CATALOG_V5 = Object.freeze({
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
  if (!entry) throw new Error('Recall opportunity is not admitted by catalog v5');
  return entry;
}
