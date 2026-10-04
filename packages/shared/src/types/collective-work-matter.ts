import { z } from 'zod';
import { collectiveConnectionCoordinatesSchema, collectiveEventIdSchema } from './collective.js';
import { collectiveWorkIdSchema, collectiveWorkProjectionSchema } from './collective-collaboration.js';

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
  })
  .extend({
    intendedOutcomePreview: z.string().max(500),
    /** Exact current-source pending proposal only; no private content or channel-wide expansion. */
    proposedOutcome: z.string().max(32_000).optional(),
    executionRevision: z.number().int().positive().optional(),
    requestKind: z.string().max(240).optional(),
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
export type CollectiveWorkSourceReadRequest = z.infer<typeof collectiveWorkSourceReadRequestSchema>;
export type CollectiveWorkRoutingReadRequest = z.infer<typeof collectiveWorkRoutingReadRequestSchema>;
export type CollectiveWorkSourceContext = z.infer<typeof collectiveWorkSourceContextSchema>;
