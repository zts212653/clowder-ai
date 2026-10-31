import { z } from 'zod';
import {
  collectiveCoordinatesSchema,
  collectiveEventIdSchema,
  collectiveHumanIdSchema,
  collectiveLocationSchema,
} from './collective.js';
import { collectiveVoteOptionIdSchema, collectiveVoteOptionSchema } from './collective-vote.js';

const publicObjectId = (prefix: string) =>
  z
    .string()
    .min(prefix.length + 8)
    .max(160)
    .regex(new RegExp(`^${prefix}[A-Za-z0-9_-]+$`));

export const collectiveBindingVoteIdSchema = publicObjectId('binding_vote_');
export const collectiveDecisionIdSchema = publicObjectId('decision_');

const voterSchema = z
  .object({ humanId: collectiveHumanIdSchema, displayName: z.string().trim().min(1).max(120) })
  .strict();

export const collectiveBindingVoteChoiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('option'), optionId: collectiveVoteOptionIdSchema }).strict(),
  z.object({ kind: z.literal('abstain') }).strict(),
]);

export const collectiveBindingVoteBallotSchema = voterSchema
  .extend({ choice: collectiveBindingVoteChoiceSchema, castAt: z.string().datetime() })
  .strict();

export const collectiveBindingVoteTargetSchema = z
  .object({
    kind: z.literal('roadmap'),
    roadmapId: publicObjectId('roadmap_'),
    roadmapRevision: z.number().int().positive(),
  })
  .strict();

export const collectiveBindingVoteAuthoritySchema = z
  .object({
    kind: z.literal('roadmap_accountable_human'),
    humanId: collectiveHumanIdSchema,
    scope: z.literal('decision_only'),
    evidenceRef: z.string().trim().min(1).max(320),
  })
  .strict();

export const collectiveBindingVoteRulesSchema = z
  .object({
    version: z.literal(1),
    eligibleVoters: z.array(voterSchema).min(1).max(5000),
    quorumCount: z.number().int().positive(),
    passCount: z.number().int().positive(),
    allowAbstain: z.literal(true),
    settlement: z.literal('deadline_or_all_ballots'),
  })
  .strict();

export const collectiveBindingVoteResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('passed'),
      winningOptionId: collectiveVoteOptionIdSchema,
      eligibleCount: z.number().int().positive(),
      participationCount: z.number().int().nonnegative(),
      supportCount: z.number().int().nonnegative(),
      settledAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('no_decision'),
      eligibleCount: z.number().int().positive(),
      participationCount: z.number().int().nonnegative(),
      supportCount: z.number().int().nonnegative(),
      settledAt: z.string().datetime(),
    })
    .strict(),
]);

export const collectiveBindingVoteHistoryEntrySchema = z
  .object({
    revision: z.number().int().positive(),
    action: z.enum(['created', 'ballot_cast', 'ballot_changed', 'ballot_withdrawn', 'settled', 'invalidated']),
    actor: voterSchema,
    at: z.string().datetime(),
    choice: collectiveBindingVoteChoiceSchema.optional(),
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

const bindingVoteBaseSchema = collectiveCoordinatesSchema
  .extend({
    v: z.literal(1),
    bindingVoteId: collectiveBindingVoteIdSchema,
    sourceEventId: collectiveEventIdSchema,
    sourceLocation: collectiveLocationSchema,
    kind: z.literal('binding_vote'),
    question: z.string().trim().min(1).max(500),
    options: z.array(collectiveVoteOptionSchema).min(2).max(8),
    ballots: z.array(collectiveBindingVoteBallotSchema).max(5000),
    target: collectiveBindingVoteTargetSchema,
    authority: collectiveBindingVoteAuthoritySchema,
    rules: collectiveBindingVoteRulesSchema,
    closesAt: z.string().datetime(),
    lifecycle: z.enum(['open', 'settled', 'invalidated']),
    result: collectiveBindingVoteResultSchema.optional(),
    decisionId: collectiveDecisionIdSchema.optional(),
    invalidationReason: z.enum(['eligible_voter_lost_access', 'roadmap_authority_changed']).optional(),
    revision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    history: z.array(collectiveBindingVoteHistoryEntrySchema).max(10_000),
  })
  .strict();

const refineBindingVote = (vote: z.infer<typeof bindingVoteBaseSchema>, context: z.RefinementCtx) => {
  const optionIds = new Set(vote.options.map((option) => option.optionId));
  const eligibleIds = new Set(vote.rules.eligibleVoters.map((voter) => voter.humanId));
  if (optionIds.size !== vote.options.length || eligibleIds.size !== vote.rules.eligibleVoters.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Binding Vote options and eligible Humans must be unique',
    });
  }
  const ballotHumans = new Set<string>();
  for (const [index, ballot] of vote.ballots.entries()) {
    if (!eligibleIds.has(ballot.humanId) || ballotHumans.has(ballot.humanId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ballots', index],
        message: 'Ballot identity is invalid',
      });
    }
    if (ballot.choice.kind === 'option' && !optionIds.has(ballot.choice.optionId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['ballots', index, 'choice'], message: 'Unknown option' });
    }
    ballotHumans.add(ballot.humanId);
  }
  if (
    vote.rules.quorumCount !== vote.rules.passCount ||
    vote.rules.passCount !== Math.floor(eligibleIds.size / 2) + 1
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rules'],
      message: 'Binding Vote must use frozen majority',
    });
  }
  if (vote.lifecycle === 'settled' && !vote.result) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['result'], message: 'Settled Vote needs a result' });
  }
  if (vote.decisionId && vote.result?.outcome !== 'passed') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['decisionId'],
      message: 'Only a passed Vote creates a Decision',
    });
  }
};

export const collectiveBindingVoteRecordSchema = bindingVoteBaseSchema.superRefine(refineBindingVote);
export const collectiveBindingVoteProjectionSchema = bindingVoteBaseSchema
  .extend({ status: z.enum(['open', 'expired', 'settled', 'invalidated']) })
  .strict()
  .superRefine(refineBindingVote);

export const collectiveDecisionRecordSchema = collectiveCoordinatesSchema
  .extend({
    v: z.literal(1),
    decisionId: collectiveDecisionIdSchema,
    bindingVoteId: collectiveBindingVoteIdSchema,
    sourceEventId: collectiveEventIdSchema,
    sourceLocation: collectiveLocationSchema,
    statement: z.string().trim().min(1).max(120),
    target: collectiveBindingVoteTargetSchema,
    authority: collectiveBindingVoteAuthoritySchema,
    rules: collectiveBindingVoteRulesSchema,
    result: collectiveBindingVoteResultSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

const commandBase = collectiveCoordinatesSchema.extend({ requestId: z.string().trim().min(1).max(200) });
export const createCollectiveBindingVoteRequestSchema = commandBase
  .extend({
    roadmapId: publicObjectId('roadmap_'),
    expectedRoadmapRevision: z.number().int().positive(),
    question: z.string().trim().min(1).max(500),
    options: z.array(z.string().trim().min(1).max(120)).min(2).max(8),
    closesAt: z.string().datetime(),
  })
  .strict();
export const castCollectiveBindingVoteRequestSchema = commandBase
  .extend({ bindingVoteId: collectiveBindingVoteIdSchema, choice: collectiveBindingVoteChoiceSchema })
  .strict();
export const withdrawCollectiveBindingVoteRequestSchema = commandBase
  .extend({ bindingVoteId: collectiveBindingVoteIdSchema })
  .strict();
export const settleCollectiveBindingVoteRequestSchema = withdrawCollectiveBindingVoteRequestSchema;

export type CollectiveBindingVoteChoice = z.infer<typeof collectiveBindingVoteChoiceSchema>;
export type CollectiveBindingVoteRecord = z.infer<typeof collectiveBindingVoteRecordSchema>;
export type CollectiveBindingVoteProjection = z.infer<typeof collectiveBindingVoteProjectionSchema>;
export type CollectiveDecisionRecord = z.infer<typeof collectiveDecisionRecordSchema>;
export type CreateCollectiveBindingVoteRequest = z.infer<typeof createCollectiveBindingVoteRequestSchema>;
export type CastCollectiveBindingVoteRequest = z.infer<typeof castCollectiveBindingVoteRequestSchema>;
export type WithdrawCollectiveBindingVoteRequest = z.infer<typeof withdrawCollectiveBindingVoteRequestSchema>;
