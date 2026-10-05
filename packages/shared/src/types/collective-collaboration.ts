import { z } from 'zod';
import {
  collectiveConnectionCoordinatesSchema,
  collectiveConnectionIdSchema,
  collectiveCoordinatesSchema,
  collectiveEventIdSchema,
  collectiveHumanIdSchema,
  collectiveLocationSchema,
} from './collective.js';
import { collectiveBindingVoteProjectionSchema, collectiveDecisionRecordSchema } from './collective-decision-vote.js';
import { collectiveReactionSummarySchema } from './collective-reaction.js';
import { collectiveVoteProjectionSchema } from './collective-vote.js';
import {
  collectiveWorkAcceptanceSchema,
  collectiveWorkExecutionAuthoritySchema,
  collectiveWorkExecutionStatusSchema,
} from './collective-work-acceptance.js';

const publicObjectId = (prefix: string) =>
  z
    .string()
    .min(prefix.length + 8)
    .max(160)
    .regex(new RegExp(`^${prefix}[A-Za-z0-9_-]+$`));

export const collectiveWorkIdSchema = publicObjectId('work_');
export const collectiveRoadmapIdSchema = publicObjectId('roadmap_');

export const collectiveAssignedWorkReadRequestSchema = collectiveConnectionCoordinatesSchema
  .extend({ workId: collectiveWorkIdSchema })
  .strict();

export const collectiveAssignedWorkByAssignmentReadRequestSchema = collectiveConnectionCoordinatesSchema
  .extend({ assignmentEventId: collectiveEventIdSchema })
  .strict();

export const collectiveAcceptedWorkResultSchema = collectiveAssignedWorkReadRequestSchema
  .extend({
    workRevision: z.number().int().positive(),
    assignmentEventId: collectiveEventIdSchema,
    resultEventId: collectiveEventIdSchema,
    resultRevision: z.number().int().positive(),
  })
  .strict();

export const collectiveCollaborationActorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('human'),
      humanId: collectiveHumanIdSchema,
      displayName: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      kind: z.literal('agent'),
      humanId: collectiveHumanIdSchema,
      humanDisplayName: z.string().trim().min(1).max(120),
      connectionId: collectiveConnectionIdSchema,
      catId: z.string().trim().min(1).max(120),
      displayName: z.string().trim().min(1).max(120),
    })
    .strict(),
]);

export const collectiveWorkAssignmentSchema = z
  .object({
    humanId: collectiveHumanIdSchema,
    connectionId: collectiveConnectionIdSchema,
    catId: z.string().trim().min(1).max(120),
    displayName: z.string().trim().min(1).max(120),
    participationRevision: z.number().int().positive(),
    assignedAt: z.string().datetime(),
  })
  .strict();

export const collectiveWorkLifecycleSchema = z.enum([
  'proposed',
  'committed',
  'in_progress',
  'result_ready',
  'completed',
  'declined',
  'cancelled',
]);
export const collectiveWorkStatusSchema = z.enum([
  'proposed',
  'ready',
  'blocked',
  'in_progress',
  'result_ready',
  'completed',
  'declined',
  'cancelled',
]);

export const collectiveWorkHistoryEntrySchema = z
  .object({
    revision: z.number().int().positive(),
    action: z.enum([
      'proposed',
      'committed',
      'dependencies_changed',
      'progress_started',
      'progress_reported',
      'result_returned',
      'revision_requested',
      'execution_authorized',
      'result_accepted',
      'completed',
      'declined',
      'cancelled',
    ]),
    actor: collectiveCollaborationActorSchema,
    at: z.string().datetime(),
    eventId: collectiveEventIdSchema.optional(),
    resultRevision: z.number().int().positive().optional(),
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export const collectiveWorkRecordSchema = collectiveCoordinatesSchema
  .extend({
    v: z.literal(1),
    workId: collectiveWorkIdSchema,
    sourceEventId: collectiveEventIdSchema,
    sourceLocation: collectiveLocationSchema,
    title: z.string().trim().min(1).max(200),
    intendedOutcome: z.string().trim().min(1).max(32_000),
    proposedBy: collectiveCollaborationActorSchema,
    proposedRequestKind: z.string().trim().min(1).max(240).optional(),
    accountableHumanId: collectiveHumanIdSchema.optional(),
    assignment: collectiveWorkAssignmentSchema.optional(),
    assignmentEventId: collectiveEventIdSchema.optional(),
    acceptance: collectiveWorkAcceptanceSchema.optional(),
    executionAuthority: collectiveWorkExecutionAuthoritySchema.optional(),
    dependencyWorkIds: z.array(collectiveWorkIdSchema).max(100),
    lifecycle: collectiveWorkLifecycleSchema,
    resultEventId: collectiveEventIdSchema.optional(),
    /** Optional only for persisted v1 results written before revision rounds existed. */
    resultRevision: z.number().int().positive().optional(),
    revision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    history: z.array(collectiveWorkHistoryEntrySchema).max(1000),
  })
  .strict();

export const collectiveWorkProjectionSchema = collectiveWorkRecordSchema
  .extend({ status: collectiveWorkStatusSchema, executionStatus: collectiveWorkExecutionStatusSchema.optional() })
  .strict();

export const collectiveRoadmapHistoryEntrySchema = z
  .object({
    revision: z.number().int().positive(),
    action: z.enum(['created', 'works_changed', 'completed', 'reopened']),
    actor: collectiveCollaborationActorSchema,
    at: z.string().datetime(),
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export const collectiveRoadmapRecordSchema = collectiveCoordinatesSchema
  .extend({
    v: z.literal(1),
    roadmapId: collectiveRoadmapIdSchema,
    sourceEventId: collectiveEventIdSchema,
    sourceLocation: collectiveLocationSchema,
    title: z.string().trim().min(1).max(200),
    purpose: z.string().trim().min(1).max(4000),
    accountableHumanId: collectiveHumanIdSchema,
    workIds: z.array(collectiveWorkIdSchema).max(200),
    status: z.enum(['active', 'completed']),
    revision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    history: z.array(collectiveRoadmapHistoryEntrySchema).max(1000),
  })
  .strict();

export const collectiveCollaborationProjectionSchema = z
  .object({
    serviceInstanceId: z.string(),
    collectiveId: z.string(),
    works: z.array(collectiveWorkProjectionSchema),
    roadmaps: z.array(collectiveRoadmapRecordSchema),
    votes: z.array(collectiveVoteProjectionSchema),
    bindingVotes: z.array(collectiveBindingVoteProjectionSchema),
    decisions: z.array(collectiveDecisionRecordSchema),
    reactions: z.array(collectiveReactionSummarySchema).optional(),
  })
  .strict();

const humanCommandBase = collectiveCoordinatesSchema.extend({ requestId: z.string().trim().min(1).max(200) });

export const proposeCollectiveWorkRequestSchema = humanCommandBase
  .extend({
    sourceEventId: collectiveEventIdSchema,
    title: z.string().trim().min(1).max(200).optional(),
    intendedOutcome: z.string().trim().min(1).max(32_000).optional(),
  })
  .strict();

export const collectiveWorkAssignmentRequestSchema = z
  .object({
    connectionId: collectiveConnectionIdSchema,
    catId: z.string().trim().min(1).max(120),
    participationRevision: z.number().int().positive(),
  })
  .strict();

export const commitCollectiveWorkRequestSchema = humanCommandBase
  .extend({
    workId: collectiveWorkIdSchema,
    expectedRevision: z.number().int().positive(),
    assignment: collectiveWorkAssignmentRequestSchema.optional(),
  })
  .strict();

export const setCollectiveWorkDependenciesRequestSchema = humanCommandBase
  .extend({
    workId: collectiveWorkIdSchema,
    expectedRevision: z.number().int().positive(),
    dependencyWorkIds: z.array(collectiveWorkIdSchema).max(100),
  })
  .strict();

export const acceptCollectiveWorkResultRequestSchema = humanCommandBase
  .extend({
    workId: collectiveWorkIdSchema,
    expectedRevision: z.number().int().positive(),
    resultEventId: collectiveEventIdSchema,
    resultRevision: z.number().int().positive(),
  })
  .strict();

export const requestCollectiveWorkRevisionRequestSchema = humanCommandBase
  .extend({
    workId: collectiveWorkIdSchema,
    expectedRevision: z.number().int().positive(),
    resultEventId: collectiveEventIdSchema,
    resultRevision: z.number().int().positive(),
    feedback: z.string().trim().min(1).max(1000),
  })
  .strict();

export const completeCollectiveWorkRequestSchema = humanCommandBase
  .extend({
    workId: collectiveWorkIdSchema,
    expectedRevision: z.number().int().positive(),
  })
  .strict();

export const declineCollectiveWorkRequestSchema = humanCommandBase
  .extend({
    workId: collectiveWorkIdSchema,
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export const createCollectiveRoadmapRequestSchema = humanCommandBase
  .extend({
    sourceEventId: collectiveEventIdSchema,
    title: z.string().trim().min(1).max(200),
    purpose: z.string().trim().min(1).max(4000),
    workIds: z.array(collectiveWorkIdSchema).max(200),
  })
  .strict();

export const setCollectiveRoadmapWorksRequestSchema = humanCommandBase
  .extend({
    roadmapId: collectiveRoadmapIdSchema,
    expectedRevision: z.number().int().positive(),
    workIds: z.array(collectiveWorkIdSchema).max(200),
  })
  .strict();

export const setCollectiveRoadmapStatusRequestSchema = humanCommandBase
  .extend({
    roadmapId: collectiveRoadmapIdSchema,
    expectedRevision: z.number().int().positive(),
    status: z.enum(['active', 'completed']),
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export type CollectiveCollaborationActor = z.infer<typeof collectiveCollaborationActorSchema>;
export type CollectiveWorkAssignment = z.infer<typeof collectiveWorkAssignmentSchema>;
export type CollectiveWorkLifecycle = z.infer<typeof collectiveWorkLifecycleSchema>;
export type CollectiveWorkStatus = z.infer<typeof collectiveWorkStatusSchema>;
export type CollectiveWorkRecord = z.infer<typeof collectiveWorkRecordSchema>;
export type CollectiveWorkProjection = z.infer<typeof collectiveWorkProjectionSchema>;
export type CollectiveAssignedWorkReadRequest = z.infer<typeof collectiveAssignedWorkReadRequestSchema>;
export type CollectiveAssignedWorkByAssignmentReadRequest = z.infer<
  typeof collectiveAssignedWorkByAssignmentReadRequestSchema
>;
export type CollectiveAcceptedWorkResult = z.infer<typeof collectiveAcceptedWorkResultSchema>;
export type CollectiveRoadmapRecord = z.infer<typeof collectiveRoadmapRecordSchema>;
export type CollectiveCollaborationProjection = z.infer<typeof collectiveCollaborationProjectionSchema>;
export type ProposeCollectiveWorkRequest = z.infer<typeof proposeCollectiveWorkRequestSchema>;
export type CommitCollectiveWorkRequest = z.infer<typeof commitCollectiveWorkRequestSchema>;
export type SetCollectiveWorkDependenciesRequest = z.infer<typeof setCollectiveWorkDependenciesRequestSchema>;
export type AcceptCollectiveWorkResultRequest = z.infer<typeof acceptCollectiveWorkResultRequestSchema>;
export type RequestCollectiveWorkRevisionRequest = z.infer<typeof requestCollectiveWorkRevisionRequestSchema>;
export type CompleteCollectiveWorkRequest = z.infer<typeof completeCollectiveWorkRequestSchema>;
export type DeclineCollectiveWorkRequest = z.infer<typeof declineCollectiveWorkRequestSchema>;
export type CreateCollectiveRoadmapRequest = z.infer<typeof createCollectiveRoadmapRequestSchema>;
export type SetCollectiveRoadmapWorksRequest = z.infer<typeof setCollectiveRoadmapWorksRequestSchema>;
export type SetCollectiveRoadmapStatusRequest = z.infer<typeof setCollectiveRoadmapStatusRequestSchema>;

export const collectiveAgentWorkProposalRequestSchema = collectiveConnectionCoordinatesSchema
  .extend({
    requestId: z.string().trim().min(1).max(200),
    sourceEventId: collectiveEventIdSchema,
    catId: z.string().trim().min(1).max(120),
    participationRevision: z.number().int().positive(),
    requestKind: z.string().trim().min(1).max(240).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    intendedOutcome: z.string().trim().min(1).max(32_000).optional(),
  })
  .strict();
export type CollectiveAgentWorkProposalRequest = z.infer<typeof collectiveAgentWorkProposalRequestSchema>;
