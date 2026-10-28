import { z } from 'zod';
import { collectiveRoadmapIdSchema, collectiveWorkIdSchema } from './collective-collaboration-identifiers.js';

export const collectiveHostProjectAttentionFocusSchema = z
  .object({
    type: z.literal('collective:host-focus-project-attention'),
    bridgeId: z.string().min(8).max(120),
    contextId: z.string().min(8).max(120),
    contextRevision: z.number().int().positive(),
    roadmapId: collectiveRoadmapIdSchema.optional(),
    channelId: z.string().trim().min(1).max(160),
    attention: z.enum(['triage', 'date_suggestion', 'overdue', 'work_dates']),
    workId: collectiveWorkIdSchema.optional(),
    workRevision: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((focus, context) => {
    if (focus.attention !== 'work_dates' && !focus.roadmapId)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Project attention requires its Project' });
    if (
      focus.attention === 'triage' ? Boolean(focus.workId || focus.workRevision) : !focus.workId || !focus.workRevision
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Project focus must name its exact kind of source' });
  });
export type CollectiveHostProjectAttentionFocus = z.infer<typeof collectiveHostProjectAttentionFocusSchema>;

export function collectiveWorkDatesActionRef(input: {
  connectionId: string;
  channelId: string;
  workId: string;
  workRevision: number;
}) {
  return `/collective?${new URLSearchParams({
    target: 'project-attention',
    attention: 'work_dates',
    connectionId: input.connectionId,
    channelId: input.channelId,
    workId: input.workId,
    workRevision: String(input.workRevision),
  })}`;
}
