import { z } from 'zod';
import {
  collectiveConnectionCoordinatesSchema,
  collectiveCoordinatesSchema,
  collectiveEventIdSchema,
  collectiveLocationSchema,
  collectiveServiceUrlSchema,
} from './collective.js';
import { collectiveCollaborationActorSchema } from './collective-collaboration-actor.js';
import { collectiveRoadmapIdSchema, collectiveWorkIdSchema } from './collective-collaboration-identifiers.js';

export const collectiveTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'A valid IANA time zone is required');
export const collectiveTimeInputSchema = z
  .object({
    value: z.string().datetime({ offset: true }),
    timeZone: collectiveTimeZoneSchema,
  })
  .strict();
export const collectiveTimeFactSchema = collectiveTimeInputSchema
  .extend({
    actor: collectiveCollaborationActorSchema,
    at: z.string().datetime(),
    sourceRef: z.string().min(1).max(500),
    sourceEventId: collectiveEventIdSchema.optional(),
    sourceLocation: collectiveLocationSchema.optional(),
    suggestedBy: collectiveCollaborationActorSchema.optional(),
  })
  .strict();
export const collectiveWorkTimeFieldSchema = z.enum([
  'businessDeadline',
  'reviewBy',
  'plannedStart',
  'actualStart',
  'estimatedCompletion',
]);
export const collectiveWorkTimeSchema = z
  .object({
    businessDeadline: collectiveTimeFactSchema.optional(),
    reviewBy: collectiveTimeFactSchema.optional(),
    plannedStart: collectiveTimeFactSchema.optional(),
    actualStart: collectiveTimeFactSchema.optional(),
    estimatedCompletion: collectiveTimeFactSchema.optional(),
  })
  .strict();
const editableField = z.enum(['businessDeadline', 'reviewBy', 'plannedStart', 'estimatedCompletion']);
const promiseField = z.enum(['businessDeadline', 'reviewBy']);
export const collectiveTimeChangeSchema = z
  .object({
    field: collectiveWorkTimeFieldSchema,
    previous: collectiveTimeFactSchema.nullable(),
    current: collectiveTimeFactSchema.nullable(),
    suggestionId: z.string().optional(),
  })
  .strict();
export const collectiveTimeSuggestionSchema = z
  .object({
    suggestionId: z.string().startsWith('time_'),
    field: promiseField,
    time: collectiveTimeInputSchema.nullable(),
    reason: z.string().trim().min(1).max(1000),
    actor: collectiveCollaborationActorSchema,
    sourceRef: z.string().min(1).max(500),
    sourceEventId: collectiveEventIdSchema.optional(),
    sourceLocation: collectiveLocationSchema.optional(),
    at: z.string().datetime(),
    status: z.enum(['pending', 'accepted', 'kept']),
    resolvedBy: collectiveCollaborationActorSchema.optional(),
    resolvedAt: z.string().datetime().optional(),
  })
  .strict();

const command = {
  requestId: z.string().trim().min(1).max(200),
  workId: collectiveWorkIdSchema,
  expectedRevision: z.number().int().positive(),
};
const source = { sourceEventId: collectiveEventIdSchema.optional() };
const set = { action: z.literal('set'), field: editableField, time: collectiveTimeInputSchema.nullable(), ...source };
const suggest = {
  action: z.literal('suggest'),
  field: promiseField,
  time: collectiveTimeInputSchema.nullable(),
  reason: z.string().trim().min(1).max(1000),
  ...source,
};
const respond = {
  action: z.literal('respond'),
  suggestionId: z.string().startsWith('time_'),
  decision: z.enum(['accept', 'keep']),
};
export const changeCollectiveWorkTimeRequestSchema = z.discriminatedUnion('action', [
  collectiveCoordinatesSchema.extend({ ...command, ...set }).strict(),
  collectiveCoordinatesSchema.extend({ ...command, ...suggest }).strict(),
  collectiveCoordinatesSchema.extend({ ...command, ...respond }).strict(),
]);
const agent = collectiveConnectionCoordinatesSchema.extend({
  ...command,
  catId: z.string().trim().min(1).max(120),
  participationRevision: z.number().int().positive(),
});
export const changeCollectiveAgentWorkTimeRequestSchema = z.discriminatedUnion('action', [
  agent.extend(set).strict(),
  agent.extend(suggest).strict(),
]);
export const setCollectiveRoadmapTargetDateRequestSchema = collectiveCoordinatesSchema
  .extend({
    requestId: z.string().trim().min(1).max(200),
    roadmapId: collectiveRoadmapIdSchema,
    expectedRevision: z.number().int().positive(),
    time: collectiveTimeInputSchema.nullable(),
    ...source,
  })
  .strict();

export type CollectiveTimeInput = z.infer<typeof collectiveTimeInputSchema>;
export type CollectiveTimeFact = z.infer<typeof collectiveTimeFactSchema>;
export type CollectiveWorkTime = z.infer<typeof collectiveWorkTimeSchema>;
export type CollectiveTimeSuggestion = z.infer<typeof collectiveTimeSuggestionSchema>;
export type CollectiveWorkTimeField = z.infer<typeof collectiveWorkTimeFieldSchema>;
export type ChangeCollectiveWorkTimeRequest = z.infer<typeof changeCollectiveWorkTimeRequestSchema>;
export type ChangeCollectiveAgentWorkTimeRequest = z.infer<typeof changeCollectiveAgentWorkTimeRequestSchema>;
export type SetCollectiveRoadmapTargetDateRequest = z.infer<typeof setCollectiveRoadmapTargetDateRequestSchema>;

/** Discardable owner read. The Task is identified here, never created or updated by a calendar read. */
export const collectiveWorkCalendarItemSchema = collectiveConnectionCoordinatesSchema
  .extend({
    taskId: z.string().min(1).max(1000),
    taskRevision: z.number().int().positive(),
    workId: collectiveWorkIdSchema,
    workRevision: z.number().int().positive(),
    serviceUrl: collectiveServiceUrlSchema,
    location: collectiveLocationSchema,
    time: collectiveWorkTimeSchema,
  })
  .strict();
export type CollectiveWorkCalendarItem = z.infer<typeof collectiveWorkCalendarItemSchema>;
export const collectiveWorkCalendarReadSchema = z
  .object({
    items: z.array(collectiveWorkCalendarItemSchema),
    unavailableTaskIds: z.array(z.string().min(1).max(1000)),
  })
  .strict();
export const collectiveTaskPublicTimeSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unavailable') }).strict(),
  collectiveWorkCalendarItemSchema.extend({ state: z.literal('current') }).strict(),
]);
export type CollectiveTaskPublicTime = z.infer<typeof collectiveTaskPublicTimeSchema>;
