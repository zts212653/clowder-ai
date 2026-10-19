import { z } from 'zod';
import {
  collectiveConnectionIdSchema,
  collectiveCoordinatesSchema,
  collectiveEventIdSchema,
  collectiveHumanIdSchema,
} from './collective.js';
import {
  collectiveRoadmapIdSchema,
  collectiveWorkAccountabilityRequestIdSchema,
  collectiveWorkIdSchema,
} from './collective-collaboration-identifiers.js';

const projectCommandBase = collectiveCoordinatesSchema.extend({
  requestId: z.string().trim().min(1).max(120),
});

const projectChannelIdSchema = z.string().trim().min(1).max(160);

export const collectiveProjectTaskAssignmentRequestSchema = z
  .object({
    connectionId: collectiveConnectionIdSchema,
    catId: z.string().trim().min(1).max(120),
    participationRevision: z.number().int().positive(),
  })
  .strict();

const projectWorkSuggestionTargetFields = {
  roadmapId: collectiveRoadmapIdSchema,
  roadmapRevision: z.number().int().positive(),
  prerequisiteForWorkId: collectiveWorkIdSchema.optional(),
  prerequisiteForWorkRevision: z.number().int().positive().optional(),
};

function requireCompletePrerequisiteTarget(
  suggestion: { readonly prerequisiteForWorkId?: string; readonly prerequisiteForWorkRevision?: number },
  context: z.RefinementCtx,
) {
  if (Boolean(suggestion.prerequisiteForWorkId) !== Boolean(suggestion.prerequisiteForWorkRevision)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A prerequisite suggestion requires both target Work identity and revision',
    });
  }
}

export const collectiveProjectWorkSuggestionTargetSchema = z
  .object(projectWorkSuggestionTargetFields)
  .strict()
  .superRefine(requireCompletePrerequisiteTarget);

export const collectiveProjectWorkSuggestionSchema = z
  .object({
    ...projectWorkSuggestionTargetFields,
    suggestedTitle: z.string().trim().min(1).max(200),
    suggestedIntendedOutcome: z.string().trim().min(1).max(32_000),
  })
  .strict()
  .superRefine(requireCompletePrerequisiteTarget);

export const collectiveWorkAccountabilityRequestSchema = z
  .object({
    accountabilityRequestId: collectiveWorkAccountabilityRequestIdSchema,
    roadmapId: collectiveRoadmapIdSchema,
    targetHumanId: collectiveHumanIdSchema,
    targetDisplayName: z.string().trim().min(1).max(120),
    requestedByHumanId: collectiveHumanIdSchema,
    requestedByDisplayName: z.string().trim().min(1).max(120),
    requestEventId: collectiveEventIdSchema,
    requestedAt: z.string().datetime(),
    status: z.enum(['pending', 'accepted', 'declined']),
    responseEventId: collectiveEventIdSchema.optional(),
    respondedAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const resolved = request.status !== 'pending';
    if (resolved !== Boolean(request.responseEventId) || resolved !== Boolean(request.respondedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Resolved accountability requests require one response event and timestamp',
      });
    }
  });

export const createCollectiveProjectRequestSchema = projectCommandBase
  .extend({
    channelId: projectChannelIdSchema,
    title: z.string().trim().min(1).max(200),
    purpose: z.string().trim().min(1).max(4000),
  })
  .strict();

export const createCollectiveProjectTaskRequestSchema = projectCommandBase
  .extend({
    roadmapId: collectiveRoadmapIdSchema,
    expectedRoadmapRevision: z.number().int().positive(),
    channelId: projectChannelIdSchema,
    title: z.string().trim().min(1).max(200),
    intendedOutcome: z.string().trim().min(1).max(32_000),
    accountability: z.enum(['self', 'unassigned']),
    requestedAccountableHumanId: collectiveHumanIdSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.accountability === 'self' && request.requestedAccountableHumanId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedAccountableHumanId'],
        message: 'A self-owned task cannot also request another accountable Human',
      });
    }
  });

export const requestCollectiveWorkAccountabilityRequestSchema = projectCommandBase
  .extend({
    roadmapId: collectiveRoadmapIdSchema,
    workId: collectiveWorkIdSchema,
    expectedRevision: z.number().int().positive(),
    targetHumanId: collectiveHumanIdSchema,
  })
  .strict();

export const respondCollectiveWorkAccountabilityRequestSchema = projectCommandBase
  .extend({
    workId: collectiveWorkIdSchema,
    expectedRevision: z.number().int().positive(),
    accountabilityRequestId: collectiveWorkAccountabilityRequestIdSchema,
    decision: z.enum(['accept', 'decline']),
    assignment: collectiveProjectTaskAssignmentRequestSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.decision === 'decline' && request.assignment) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assignment'],
        message: 'A declined responsibility request cannot assign a Cat',
      });
    }
  });

export const decideCollectiveProjectWorkSuggestionRequestSchema = projectCommandBase
  .extend({
    workId: collectiveWorkIdSchema,
    expectedRevision: z.number().int().positive(),
    expectedRoadmapRevision: z.number().int().positive(),
    expectedTargetWorkRevision: z.number().int().positive().optional(),
    decision: z.enum(['accept', 'ignore']),
    title: z.string().trim().min(1).max(200).optional(),
    intendedOutcome: z.string().trim().min(1).max(32_000).optional(),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.decision === 'ignore' && (request.title || request.intendedOutcome)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An ignored suggestion cannot carry accepted Work edits',
      });
    }
  });

export type CollectiveProjectTaskAssignmentRequest = z.infer<typeof collectiveProjectTaskAssignmentRequestSchema>;
export type CollectiveProjectWorkSuggestionTarget = z.infer<typeof collectiveProjectWorkSuggestionTargetSchema>;
export type CollectiveProjectWorkSuggestion = z.infer<typeof collectiveProjectWorkSuggestionSchema>;
export type CollectiveWorkAccountabilityRequest = z.infer<typeof collectiveWorkAccountabilityRequestSchema>;
export type CreateCollectiveProjectRequest = z.infer<typeof createCollectiveProjectRequestSchema>;
export type CreateCollectiveProjectTaskRequest = z.infer<typeof createCollectiveProjectTaskRequestSchema>;
export type RequestCollectiveWorkAccountabilityRequest = z.infer<
  typeof requestCollectiveWorkAccountabilityRequestSchema
>;
export type RespondCollectiveWorkAccountabilityRequest = z.infer<
  typeof respondCollectiveWorkAccountabilityRequestSchema
>;
export type DecideCollectiveProjectWorkSuggestionRequest = z.infer<
  typeof decideCollectiveProjectWorkSuggestionRequestSchema
>;
