import { z } from 'zod';
import { bounded, ownerTruthRefV1Schema } from './capability-evolution-refs.js';

const humanInput = z
  .object({
    threadId: bounded(512),
    messageId: bounded(512),
  })
  .strict();

// The submitter is authenticated by F117. Clients may cite input, never supply its author.
const responsibility = z.union([
  z.object({ kind: z.literal('cat'), basis: z.literal('technical') }).strict(),
  z
    .object({
      kind: z.literal('cat'),
      basis: z.literal('existing_authorization'),
      input: humanInput,
    })
    .strict(),
  z.object({ kind: z.literal('human'), input: humanInput }).strict(),
]);

export const preparationRecommendationSchema = z
  .object({
    summary: bounded(240),
    reason: bounded(2_000),
    basisRefs: z.array(ownerTruthRefV1Schema).min(1).max(16),
  })
  .strict();

/** A preparation choice records intent; it cannot execute, authorize or adopt anything. */
export const preparationDecisionSchema = z.union([
  z
    .object({
      state: z.literal('undecided'),
      reason: bounded(2_000),
      neededFrom: z.enum(['cat', 'human', 'unknown']),
    })
    .strict(),
  z
    .object({
      state: z.enum(['explore', 'fixed', 'excluded']),
      reason: bounded(2_000),
      responsibility,
      basisRefs: z.array(ownerTruthRefV1Schema).min(1).max(16),
    })
    .strict(),
]);
