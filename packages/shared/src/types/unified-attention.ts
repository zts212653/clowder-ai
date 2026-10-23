import { z } from 'zod';
import { APPROVAL_PRODUCER_IDS } from '../approval-producer-catalog.js';
import type { IgnoredItemCoordinate } from '../ignored-item-preference.js';
import { type ApprovalHubItem, type ApprovalNavigation, validateApprovalNavigation } from './approval-hub.js';
import {
  approvalLifecycleProjectionSchema,
  approvalMaterializationSchema,
  approvalResolutionSchema,
} from './approval-lifecycle.js';
import type { CollectiveAccountabilityAttentionItem } from './collective-accountability-attention.js';
import { producerAttentionCoverageV1Schema } from './growing.js';
import { preparedArtifactSnapshotV1Schema } from './growing-artifact.js';
import type { RichCardBlock, RichInteractiveBlock } from './rich.js';
import {
  type RuntimeInteractionCardRef,
  type RuntimeInteractionRequest,
  runtimeQuestionSchema,
} from './runtime-interaction.js';

export type UnifiedAttentionApproval = ApprovalHubItem;
/** Canonical renderer fields; bind the read's verified identity.ownerUserId when rendering ApprovalItemCard. */
export type UnifiedAttentionVisibleApproval = Omit<ApprovalHubItem, 'ownerUserId'>;

const approvalNavigationSchema = z.custom<ApprovalNavigation>((value) => {
  try {
    validateApprovalNavigation(value as ApprovalNavigation);
    return true;
  } catch {
    return false;
  }
});

const sourceCoverageSchema = z.object({ state: z.enum(['complete', 'partial', 'unknown']) });

export const unifiedAttentionDecisionCoordinateSchema = z
  .object({
    producerId: z.enum(['f292.repair', 'f306.runtime_interaction']),
    subjectRef: z.string().min(1),
    revision: z.number().int().positive(),
  })
  .strict();

const approvalSourceItemSchema: z.ZodType<UnifiedAttentionApproval> = z
  .object({
    proposalId: z.string(),
    sourceFeatureId: z.enum(APPROVAL_PRODUCER_IDS),
    requesterCatId: z.string().refine((value) => value.trim().length > 0),
    ownerUserId: z.string(),
    summary: z.string(),
    detail: z.record(z.string(), z.unknown()),
    navigation: approvalNavigationSchema,
    inlineApprovable: z.boolean(),
    decisionMode: z.enum(['approve-reject', 'claim-select']).optional(),
    resolution: approvalResolutionSchema,
    materialization: approvalMaterializationSchema,
    createdAt: z.number(),
    expiresAt: z.number().optional(),
    entrustedWorkTaskRef: z.object({ subjectRef: z.string(), observedRevision: z.number() }).optional(),
    needsMeDecisionRefs: z.array(unifiedAttentionDecisionCoordinateSchema).optional(),
  })
  .passthrough()
  .superRefine((item, ctx) => {
    const lifecycle = approvalLifecycleProjectionSchema.safeParse({
      resolution: item.resolution,
      materialization: item.materialization,
    });
    if (!lifecycle.success) for (const issue of lifecycle.error.issues) ctx.addIssue(issue);
  });

export const unifiedAttentionApprovalsSourceSchema = z.object({
  coverage: sourceCoverageSchema.optional(),
  items: z.array(approvalSourceItemSchema),
});

export const unifiedAttentionWorkSourceSchema = z.object({
  coverage: producerAttentionCoverageV1Schema.optional(),
  ownerReads: z.array(
    z
      .object({
        envelope: z
          .object({
            subjectRef: z.string(),
            revision: z.number(),
            visibility: z.object({ ownerUserId: z.string() }).passthrough(),
            freshness: z.object({ state: z.enum(['current', 'stale']), observedRevision: z.number() }).optional(),
          })
          .passthrough(),
        brief: z
          .object({ current: z.object({ state: z.string() }).passthrough().optional() })
          .passthrough()
          .optional(),
        preparedArtifact: preparedArtifactSnapshotV1Schema.optional(),
        attentionReceipts: z.array(
          z
            .object({
              eligible: z.boolean(),
              producer: z
                .object({
                  producerId: z.string(),
                  ownerRef: z.string().optional(),
                  subjectRef: z.string(),
                  revision: z.number(),
                })
                .passthrough(),
              taskRef: z.object({ subjectRef: z.string(), observedRevision: z.number() }).passthrough(),
              kind: z.enum(['judgment', 'repair']).optional(),
              reasonCode: z.string().optional(),
              recommendation: z.string().optional(),
              salience: z.enum(['normal', 'near_deadline', 'high_risk']).optional(),
              action: z.object({ actionRef: z.string(), expectedProducerRevision: z.number() }).optional(),
              reEvaluateActionRef: z.string().optional(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  ),
});

export type UnifiedAttentionWork = z.infer<typeof unifiedAttentionWorkSourceSchema>['ownerReads'][number];
export type UnifiedAttentionReceipt = UnifiedAttentionWork['attentionReceipts'][number];
export type UnifiedAttentionSourceStatus = 'available' | 'unavailable' | 'unauthenticated' | 'forbidden' | 'invalid';
export type UnifiedAttentionSourceRead = {
  status: UnifiedAttentionSourceStatus;
  startedAt: number;
  observedAt: number;
  coverage:
    | 'all_registered_F246_producers'
    | 'current_linked_F310_five_producers'
    | 'pending_f290_collective_accountability_requests'
    | 'pending_f306_structured_choices'
    | 'explicit_user_mentions'
    | 'owner_personal_ignored_items';
  exhaustiveness: 'complete' | 'partial' | 'unknown';
};

export type UnifiedAttentionPreferenceCoordinate = Extract<IgnoredItemCoordinate, { kind: 'mailbox' }>;

/** Read-only coordinates for one canonical, still-pending provider-native question. */
export const unifiedAttentionChoiceRequestSchema = z
  .object({
    interactionId: z.string().trim().min(1),
    revision: z.number().int().nonnegative(),
    requesterCatId: z.string().trim().min(1),
    createdAt: z.number().int().nonnegative(),
    title: z.string().trim().min(1),
    questions: z.array(runtimeQuestionSchema).min(1),
    cardRef: z
      .object({
        threadId: z.string().trim().min(1),
        messageId: z.string().trim().min(1),
        blockId: z.string().trim().min(1),
        blockDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        publishedAt: z.number().int().nonnegative().safe().optional(),
      })
      .strict(),
  })
  .strict();

export type UnifiedAttentionChoiceRequest = z.infer<typeof unifiedAttentionChoiceRequestSchema>;

/** Verified source card for producers whose original writer lives on a RichCard. */
export interface UnifiedAttentionOriginalApprovalCard {
  cardRef: { threadId: string; messageId: string; blockId: string };
  block: RichCardBlock;
}

interface UnifiedAttentionRuntimeInteractionBase {
  interactionId: string;
  /** Provider records retain their published witness; conversation records expose the monotonic CAS revision. */
  revision: number;
  requesterCatId: string;
  createdAt: number;
  title: string;
  cardRef: RuntimeInteractionCardRef;
}

type ProviderRuntimeInteractionKind = Exclude<RuntimeInteractionRequest['kind'], 'conversation_decision'>;

/** One canonical pending F306 record. Question keeps choiceRequest as a compatibility projection. */
export type UnifiedAttentionRuntimeInteraction = UnifiedAttentionRuntimeInteractionBase &
  (
    | {
        /** Omitted only by pre-Task655 provider snapshots. New projections always populate it. */
        sourceKind?: undefined;
        kind: ProviderRuntimeInteractionKind;
      }
    | { sourceKind: 'provider_request'; kind: ProviderRuntimeInteractionKind }
    | {
        sourceKind: 'conversation_decision';
        kind: 'conversation_decision';
        /** Exact original block, emitted only after the canonical message passes live-card validation. */
        presentation: RichInteractiveBlock;
        allowTextResponse: boolean;
        deadlineAt?: number;
      }
  );

/** Host-only source DTO. Packaged renderers receive their separately fenced presentation. */
export interface UnifiedAttentionItemV1 {
  decisionRef: string;
  kind: 'approval' | 'judgment' | 'repair' | 'user_mention';
  summary: string;
  /** Latest explicitly addressed public cat message in one conversation; no inferred category or urgency. */
  userMention?: {
    threadId: string;
    threadTitle?: string;
    expectedRevision?: number;
    handled?: boolean;
    messageId: string;
    catId: string;
    content: string;
    timestamp: number;
    /** Why this request entered handled history. Absent only for legacy/manual records without typed provenance. */
    handledReason?: 'viewed' | 'replied' | 'ignored';
    handledAt?: number;
  };
  /** Present only for a canonical pending F306 question; ordinary rich interactive blocks never project here. */
  choiceRequest?: UnifiedAttentionChoiceRequest;
  /** Present for every canonical pending F306 approval, question or elicitation. */
  runtimeInteraction?: UnifiedAttentionRuntimeInteraction;
  approval?: UnifiedAttentionVisibleApproval;
  /** One Service-authorized, still-operable named-Human responsibility request. */
  collectiveAccountabilityRequest?: CollectiveAccountabilityAttentionItem;
  /** Present only after the canonical live F225/F231 source message passes its closed producer validator. */
  originalApprovalCard?: UnifiedAttentionOriginalApprovalCard;
  linkedNeedsMe: { ownerRead: UnifiedAttentionWork; receipt: UnifiedAttentionReceipt }[];
  /** Server-issued exact-version coordinate for the owner-private presentation preference writer. */
  preferenceCoordinate?: UnifiedAttentionPreferenceCoordinate;
}

/** Exact groups from the full selected response vector, before offset/limit is applied. */
export interface UnifiedAttentionItemGroupCountsV1 {
  /** Open approvals, canonical pending runtime interactions, exact named content reviews and current Collective results. */
  decisions: number;
  userMentions: number;
  /** Repairs, non-question judgments and every other non-mention item. */
  other: number;
}

export interface UnifiedAttentionPersonalGroupCountsV1 {
  original: UnifiedAttentionItemGroupCountsV1;
  visible: UnifiedAttentionItemGroupCountsV1;
  ignored: UnifiedAttentionItemGroupCountsV1;
}

export interface UnifiedAttentionPersonalViewV1 {
  mode: 'visible' | 'ignored';
  preferenceRevision?: number;
  /** Exact full-set counts. Omitted together when source coverage, consistency or preference read is uncertain. */
  originalTotalCount?: number;
  visibleTotalCount?: number;
  ignoredTotalCount?: number;
  originalAttentionCount?: number;
  visibleAttentionCount?: number;
  ignoredAttentionCount?: number;
  /** Exact full-vector presentation groups. Omitted whenever the exact personal counts are omitted. */
  groupCounts?: UnifiedAttentionPersonalGroupCountsV1;
}

export interface UnifiedAttentionReadV1 {
  version: 1;
  status: 'available' | 'partial' | 'unavailable';
  scope: 'owner_all_projects';
  identity: { ownerUserId: string };
  observedAt: number;
  sources: {
    approvals: UnifiedAttentionSourceRead;
    needsMe: UnifiedAttentionSourceRead;
    collectiveAccountabilityRequests?: UnifiedAttentionSourceRead;
    structuredChoices?: UnifiedAttentionSourceRead;
    userMentions?: UnifiedAttentionSourceRead;
    personalPreferences?: UnifiedAttentionSourceRead;
  };
  readWindow: { startedAt: number; endedAt: number; consistency: 'independent_source_reads' };
  consistency: { state: 'verified' | 'uncertain'; reasons: string[] };
  items: UnifiedAttentionItemV1[];
  /** Present only for complete coverage with verified source identity and version deduplication, before paging. */
  totalCount?: number;
  /** Exact open approvals + canonical pending F306 interactions + named content reviews. */
  attentionCount?: number;
  mentionCounts?: { today: number; week: number; earlier: number; handled: number };
  mentionPeriod?: 'recent' | 'today' | 'week' | 'earlier' | 'handled';
  /** Present only when the caller explicitly requests an owner-personal visible or ignored view. */
  personalView?: UnifiedAttentionPersonalViewV1;
  /** hasMore describes only the known rows from this independent-source read. */
  page: {
    offset: number;
    limit: number;
    scope: 'known_rows';
    hasMore: boolean;
    hasMoreApprovals?: boolean;
    hasMoreNeedsMe?: boolean;
  };
  /** Transitional legacy groups; consumers must not sum these counts into totalCount. */
  approvalCoverage?: 'all_registered_F246_producers';
  needsMeCoverage?: 'current_linked_F310_five_producers';
  approvalCount?: number;
  needsMeCount?: number;
  otherNeedsMeCount?: number;
  approvals?: (UnifiedAttentionVisibleApproval & { linkedNeedsMe?: UnifiedAttentionWork })[];
  otherNeedsMe?: UnifiedAttentionWork[];
}
