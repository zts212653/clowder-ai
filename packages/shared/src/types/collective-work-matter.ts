import { z } from 'zod';
import {
  collectiveConnectionCoordinatesSchema,
  collectiveEventIdSchema,
  collectiveLocationSchema,
} from './collective.js';
import {
  collectiveRoadmapIdSchema,
  collectiveWorkIdSchema,
  collectiveWorkLifecycleSchema,
  collectiveWorkProjectionSchema,
  collectiveWorkStatusSchema,
} from './collective-collaboration.js';
import { collectiveTimeFactSchema } from './collective-time.js';

export const collectiveWorkProjectSummarySchema = z
  .object({
    roadmapId: collectiveRoadmapIdSchema,
    sourceEventId: collectiveEventIdSchema,
    sourceLocation: collectiveLocationSchema,
    title: z.string().trim().min(1).max(200),
    purpose: z.string().trim().min(1).max(4000),
    status: z.enum(['active', 'completed']),
    revision: z.number().int().positive(),
    targetDate: collectiveTimeFactSchema.optional(),
  })
  .strict();

export const collectiveWorkDependencySummarySchema = z
  .object({
    workId: collectiveWorkIdSchema,
    sourceEventId: collectiveEventIdSchema,
    sourceLocation: collectiveLocationSchema,
    title: z.string().trim().min(1).max(200),
    intendedOutcomePreview: z.string().max(500),
    lifecycle: collectiveWorkLifecycleSchema,
    status: collectiveWorkStatusSchema,
    resultEventId: collectiveEventIdSchema.optional(),
    resultRevision: z.number().int().positive().optional(),
    revision: z.number().int().positive(),
  })
  .strict();

export const collectiveWorkProjectContextSchema = z
  .object({
    projects: z.array(collectiveWorkProjectSummarySchema).max(12),
    unreadableProjectCount: z.number().int().nonnegative(),
    projectsHasMore: z.boolean(),
    dependencies: z.array(collectiveWorkDependencySummarySchema).max(30),
    unreadableDependencyCount: z.number().int().nonnegative(),
    dependenciesHasMore: z.boolean(),
  })
  .strict();

/** Bounded public matter candidates; no private Task, thread, admission receipt or full history. */
export const collectiveWorkMatterSchema = collectiveWorkProjectionSchema
  .pick({
    workId: true,
    sourceEventId: true,
    sourceLocation: true,
    title: true,
    accountableHumanId: true,
    assignment: true,
    assignmentEventId: true,
    lifecycle: true,
    resultEventId: true,
    resultRevision: true,
    revision: true,
    status: true,
    executionStatus: true,
    time: true,
    timeSuggestions: true,
    materialLinks: true,
  })
  .extend({
    intendedOutcomePreview: z.string().max(500),
    /** Exact outcome for a current-source proposal or accepted unassigned Task that this Cat may claim. */
    proposedOutcome: z.string().max(32_000).optional(),
    executionRevision: z.number().int().positive().optional(),
    requestKind: z.string().max(240).optional(),
    /** Current, visibility-filtered Project and dependency truth; unreadable counts distinguish absence from denial. */
    projectContext: collectiveWorkProjectContextSchema,
  })
  .strict();
export const collectiveWorkSourceReadRequestSchema = collectiveConnectionCoordinatesSchema
  .extend({
    sourceEventId: collectiveEventIdSchema,
    catId: z.string().min(1).max(120),
    participationRevision: z.number().int().positive(),
  })
  .strict();
export const collectiveWorkRoutingReadRequestSchema = collectiveWorkSourceReadRequestSchema
  .omit({ catId: true, participationRevision: true })
  .strict();
export const collectiveWorkSourceContextSchema = z
  .object({
    sourceEventId: collectiveEventIdSchema,
    matters: z.array(collectiveWorkMatterSchema).max(30),
    relatedWorkIds: z.array(collectiveWorkIdSchema).max(30),
    hasMore: z.boolean(),
  })
  .strict();
export type CollectiveWorkMatter = z.infer<typeof collectiveWorkMatterSchema>;
export type CollectiveWorkProjectContext = z.infer<typeof collectiveWorkProjectContextSchema>;
export type CollectiveWorkSourceReadRequest = z.infer<typeof collectiveWorkSourceReadRequestSchema>;
export type CollectiveWorkRoutingReadRequest = z.infer<typeof collectiveWorkRoutingReadRequestSchema>;
export type CollectiveWorkSourceContext = z.infer<typeof collectiveWorkSourceContextSchema>;
