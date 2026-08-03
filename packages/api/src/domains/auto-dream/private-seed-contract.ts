import { type SeedDecision } from '@cat-cafe/shared';
import { z } from 'zod';

export const privateCueSourceRefSchema = z
  .object({
    threadId: z.string().trim().min(1).max(200),
    messageId: z.string().trim().min(1).max(240).optional(),
    sessionId: z.string().trim().min(1).max(240).optional(),
    eventNo: z.number().int().nonnegative().optional(),
    invocationId: z.string().trim().min(1).max(240).optional(),
  })
  .strict();

export const f255PendingCueInputSchema = z
  .object({
    outputId: z.string().trim().min(1).max(240),
    ownerUserId: z.string().trim().min(1).max(160),
    catId: z.string().trim().min(1).max(120),
    kind: z.literal('desire_cue'),
    normalizedClaim: z.string().trim().min(1).max(4_000),
    reason: z.string().trim().min(1).max(4_000),
    sourceRef: privateCueSourceRefSchema,
    producer: z.literal('f271-session-close-v1'),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type F255PendingCueInput = z.infer<typeof f255PendingCueInputSchema>;
export type PrivateCueSourceRef = z.infer<typeof privateCueSourceRefSchema>;

export interface F255PendingCueReceipt {
  cueId: string;
}

export interface F255PendingCueSink {
  ingestPendingCue(input: F255PendingCueInput): Promise<F255PendingCueReceipt>;
}

export type PrivateCueStatus = 'pending' | 'adopted' | 'rejected';
export type OwnedSeedStatus = 'owned' | 'dormant' | 'retired';

export interface PrivateCueRecord {
  cueId: string;
  ownerUserId: string;
  catId: string;
  kind: 'desire_cue';
  normalizedClaim: string;
  reason: string;
  sourceRef: PrivateCueSourceRef;
  producer: 'f271-session-close-v1';
  sourceOutputId: string;
  sourceCreatedAt: string;
  status: PrivateCueStatus;
  decidedByRunId?: string;
  ownedSeedId?: string;
  decidedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface OwnedSeedRecord {
  seedId: string;
  ownerUserId: string;
  catId: string;
  sourceKind: 'cue' | 'originated';
  sourceCueId?: string;
  claim: string;
  status: OwnedSeedStatus;
  sourceRunId: string;
  createdByInvocationId: string;
  dormantAt?: number;
  retiredAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PrivateSeedDecisionInput {
  runId: string;
  decision: SeedDecision;
}

export interface PrivateSeedDecisionResult {
  cue: PrivateCueRecord | null;
  seed: OwnedSeedRecord | null;
}

export interface PrivateCueListOptions {
  status?: PrivateCueStatus;
  limit?: number;
}

export interface OwnedSeedListOptions {
  status?: OwnedSeedStatus;
  limit?: number;
}
