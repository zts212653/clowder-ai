import { z } from 'zod';
import { APPROVAL_PRODUCER_IDS } from '../approval-producer-catalog.js';
import { type ApprovalHubItem, type ApprovalNavigation, validateApprovalNavigation } from './approval-hub.js';
import {
  approvalLifecycleProjectionSchema,
  approvalMaterializationSchema,
  approvalResolutionSchema,
} from './approval-lifecycle.js';
import { preparedArtifactSnapshotV1Schema } from './growing-artifact.js';

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
    decisionMode: z.enum(['approve-reject', 'claim-select', 'meeting-intake']).optional(),
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
  coverage: sourceCoverageSchema.optional(),
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
                .object({ producerId: z.string(), subjectRef: z.string(), revision: z.number() })
                .passthrough(),
              taskRef: z.object({ subjectRef: z.string(), observedRevision: z.number() }).passthrough(),
              kind: z.enum(['judgment', 'repair']).optional(),
              recommendation: z.string().optional(),
              action: z.object({ actionRef: z.string(), expectedProducerRevision: z.number() }).optional(),
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
  coverage: 'all_registered_F246_producers' | 'current_linked_F310_five_producers';
  exhaustiveness: 'complete' | 'partial' | 'unknown';
};

/** Host-only source DTO. Packaged renderers receive their separately fenced presentation. */
export interface UnifiedAttentionItemV1 {
  decisionRef: string;
  kind: 'approval' | 'judgment' | 'repair';
  summary: string;
  approval?: UnifiedAttentionVisibleApproval;
  linkedNeedsMe: { ownerRead: UnifiedAttentionWork; receipt: UnifiedAttentionReceipt }[];
}

export interface UnifiedAttentionReadV1 {
  version: 1;
  status: 'available' | 'partial' | 'unavailable';
  scope: 'owner_all_projects';
  identity: { ownerUserId: string };
  observedAt: number;
  sources: { approvals: UnifiedAttentionSourceRead; needsMe: UnifiedAttentionSourceRead };
  readWindow: { startedAt: number; endedAt: number; consistency: 'independent_source_reads' };
  consistency: { state: 'verified' | 'uncertain'; reasons: string[] };
  items: UnifiedAttentionItemV1[];
  /** Present only for complete coverage with verified source identity and version deduplication, before paging. */
  totalCount?: number;
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
