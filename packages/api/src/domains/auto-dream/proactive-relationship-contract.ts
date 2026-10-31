import type { ProactiveEchoInput, ProactiveIntent } from '@cat-cafe/shared';
import { z } from 'zod';
import type { OwnedSeedRecord } from './private-seed-contract.js';

export type ProactiveIntentStatus = 'settled_silent' | 'ready' | 'visit_reserved' | 'projected' | 'echoed' | 'settled';
export type ProactiveVisitStatus = 'reserved' | 'projected' | 'echoed' | 'settled' | 'cancelled_unseen';
export type ForegroundBudgetClaimState = 'claimed' | 'consumed' | 'released';
export type ProactiveVisibilityBlock = 'quiet_hours' | 'budget_exhausted';
export type ProactiveEchoKind = ProactiveEchoInput['kind'] | 'natural_reply';

export const proactiveSurfaceSchema = z
  .object({
    kind: z.enum(['body_language', 'bubble', 'home_message']),
    refId: z.string().trim().min(1).max(240),
  })
  .strict();

export type ProactiveSurfaceRef = z.infer<typeof proactiveSurfaceSchema>;

export interface ProactiveIntentRecord {
  intentId: string;
  ownerUserId: string;
  catId: string;
  runId: string;
  seedId: string;
  status: ProactiveIntentStatus;
  visibilityKind: ProactiveIntent['kind'];
  expressionKind: ProactiveIntent['expressionKind'];
  firstAction: ProactiveIntent['firstAction'];
  visibilityBlock?: ProactiveVisibilityBlock;
  settledAt?: number;
  createdByInvocationId: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProactiveVisitRecord {
  visitId: string;
  ownerUserId: string;
  catId: string;
  runId: string;
  intentId: string;
  seedId: string;
  expressionKind: ProactiveIntent['expressionKind'];
  status: ProactiveVisitStatus;
  householdLocalDate: string;
  budgetClaimState: ForegroundBudgetClaimState;
  homeThreadId: string;
  pendingMessageBody?: string;
  canonicalMessageThreadId?: string;
  canonicalMessageId?: string;
  projectedSurfaces: ProactiveSurfaceRef[];
  echoedAt?: number;
  settledAt?: number;
  cancelledAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProactiveEchoRecord {
  echoId: string;
  ownerUserId: string;
  catId: string;
  visitId: string;
  seedId: string;
  kind: ProactiveEchoKind;
  sourceKind: 'typed' | 'natural_reply';
  clientEventId?: string;
  sourceThreadId?: string;
  sourceMessageId?: string;
  createdAt: number;
}

export interface ProactiveSettlementState {
  seed: OwnedSeedRecord | null;
  intent: ProactiveIntentRecord | null;
  visit: ProactiveVisitRecord | null;
  visibilityBlock: ProactiveVisibilityBlock | null;
}

export interface ProactiveVisitProjectionInput {
  visitId: string;
  surface: ProactiveSurfaceRef;
}

export interface AttachCanonicalMessageInput {
  visitId: string;
  threadId: string;
  messageId: string;
}

export interface AttachCanonicalMessageResult {
  visit: ProactiveVisitRecord;
  attached: boolean;
}

export interface ProactiveRecordListOptions<TStatus extends string> {
  status?: TStatus;
  limit?: number;
}

export interface NaturalProactiveEchoInput {
  visitId: string;
  kind: 'natural_reply';
  sourceThreadId: string;
  sourceMessageId: string;
}

export const naturalProactiveEchoInputSchema = z
  .object({
    visitId: z.string().trim().min(1).max(240),
    kind: z.literal('natural_reply'),
    sourceThreadId: z.string().trim().min(1).max(200),
    sourceMessageId: z.string().trim().min(1).max(240),
  })
  .strict();
