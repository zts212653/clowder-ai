import { z } from 'zod';
import {
  collectiveCoordinatesSchema,
  collectiveEventIdSchema,
  collectiveHumanIdSchema,
  collectiveLocationSchema,
} from './collective.js';

const publicObjectId = (prefix: string) =>
  z
    .string()
    .min(prefix.length + 8)
    .max(160)
    .regex(new RegExp(`^${prefix}[A-Za-z0-9_-]+$`));

export const collectiveVoteIdSchema = publicObjectId('vote_');
export const collectiveVoteOptionIdSchema = publicObjectId('vote_option_');

const voteHumanSchema = z
  .object({
    humanId: collectiveHumanIdSchema,
    displayName: z.string().trim().min(1).max(120),
  })
  .strict();

export const collectiveVoteOptionSchema = z
  .object({
    optionId: collectiveVoteOptionIdSchema,
    label: z.string().trim().min(1).max(120),
  })
  .strict();

export const collectiveVoteBallotSchema = voteHumanSchema
  .extend({
    optionId: collectiveVoteOptionIdSchema,
    castAt: z.string().datetime(),
  })
  .strict();

export const collectiveVoteHistoryEntrySchema = z
  .object({
    revision: z.number().int().positive(),
    action: z.enum(['created', 'ballot_cast', 'ballot_changed', 'closed']),
    actor: voteHumanSchema,
    at: z.string().datetime(),
    optionId: collectiveVoteOptionIdSchema.optional(),
  })
  .strict();

const collectiveVoteRecordBaseSchema = collectiveCoordinatesSchema
  .extend({
    v: z.literal(1),
    voteId: collectiveVoteIdSchema,
    sourceEventId: collectiveEventIdSchema,
    sourceLocation: collectiveLocationSchema,
    kind: z.literal('informal_poll'),
    effect: z.literal('preference_only'),
    eligibility: z.literal('current_members'),
    ballotVisibility: z.literal('named'),
    question: z.string().trim().min(1).max(500),
    options: z.array(collectiveVoteOptionSchema).min(2).max(8),
    ballots: z.array(collectiveVoteBallotSchema).max(5000),
    createdBy: voteHumanSchema,
    closesAt: z.string().datetime(),
    lifecycle: z.enum(['open', 'closed']),
    closedAt: z.string().datetime().optional(),
    revision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    history: z.array(collectiveVoteHistoryEntrySchema).max(10_000),
  })
  .strict();

const refineCollectiveVote = (vote: z.infer<typeof collectiveVoteRecordBaseSchema>, context: z.RefinementCtx) => {
  const options = new Set(vote.options.map((option) => option.optionId));
  if (options.size !== vote.options.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Vote option IDs must be unique' });
  }
  const voters = new Set<string>();
  for (const [index, ballot] of vote.ballots.entries()) {
    if (!options.has(ballot.optionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ballots', index, 'optionId'],
        message: 'Ballot must reference one Vote option',
      });
    }
    if (voters.has(ballot.humanId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ballots', index, 'humanId'],
        message: 'Each Human has one current ballot',
      });
    }
    voters.add(ballot.humanId);
  }
  if (vote.lifecycle === 'closed' && !vote.closedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['closedAt'], message: 'Closed Vote needs closedAt' });
  }
};

export const collectiveVoteRecordSchema = collectiveVoteRecordBaseSchema.superRefine(refineCollectiveVote);

export const collectiveVoteProjectionSchema = collectiveVoteRecordBaseSchema
  .extend({ status: z.enum(['open', 'expired', 'closed']) })
  .strict()
  .superRefine(refineCollectiveVote);

const voteCommandBase = collectiveCoordinatesSchema.extend({ requestId: z.string().trim().min(1).max(200) });

export const createCollectiveVoteRequestSchema = voteCommandBase
  .extend({
    sourceEventId: collectiveEventIdSchema,
    question: z.string().trim().min(1).max(500),
    options: z.array(z.string().trim().min(1).max(120)).min(2).max(8),
    closesAt: z.string().datetime(),
  })
  .strict();

export const castCollectiveVoteRequestSchema = voteCommandBase
  .extend({ voteId: collectiveVoteIdSchema, optionId: collectiveVoteOptionIdSchema })
  .strict();

export const closeCollectiveVoteRequestSchema = voteCommandBase.extend({ voteId: collectiveVoteIdSchema }).strict();

export type CollectiveVoteRecord = z.infer<typeof collectiveVoteRecordSchema>;
export type CollectiveVoteProjection = z.infer<typeof collectiveVoteProjectionSchema>;
export type CreateCollectiveVoteRequest = z.infer<typeof createCollectiveVoteRequestSchema>;
export type CastCollectiveVoteRequest = z.infer<typeof castCollectiveVoteRequestSchema>;
export type CloseCollectiveVoteRequest = z.infer<typeof closeCollectiveVoteRequestSchema>;
