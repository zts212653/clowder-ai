import { z } from 'zod';

/** Observed cache facts owned by one canonical session. No prompts or credentials. */
export interface SessionCacheObservation {
  invocationId: string;
  nativeSessionId: string;
  runtime: string;
  model: string;
  /** Source-turn Host account/workspace/carrier fingerprint; absent on older observations. */
  executionBoundaryRef?: string;
  requestStartedAt: number;
  /** Conservative lower bound when a carrier does not expose every internal API request start. */
  timeSource: 'invocation_start_lower_bound';
  observedAt: number;
  contextTokens: number;
  /** Only present when one request's read count and total context can be paired exactly. */
  cacheReadTokens?: number;
  compressionCount: number | null;
  retentionMs?: number;
  retentionSource?: 'usage_ttl' | 'empirical_session';
  /** Bounded matched-runtime/model observations, not a vendor retention guarantee. */
  confirmedWarmGapsMs: number[];
}

const timestamp = z.number().int().nonnegative();
export const sessionCacheWarmthSchema = z
  .object({
    status: z.enum(['warm', 'expired', 'unknown']),
    estimated: z.literal(true),
    source: z.enum(['usage_ttl', 'empirical_session', 'cache_retention', 'unavailable']),
    maintenanceInvocationId: z.string().max(500).optional(),
    retaining: z.boolean().optional(),
    bindingSource: z.enum(['catalog_default', 'frozen_execution', 'observed_session']).optional(),
    reason: z.string().max(200).optional(),
    sessionId: z.string().max(500).optional(),
    threadId: z.string().max(500).optional(),
    model: z.string().max(500).optional(),
    runtime: z.string().max(200).optional(),
    contextTokens: z.number().int().nonnegative().optional(),
    requestStartedAt: timestamp.optional(),
    timeSource: z.literal('invocation_start_lower_bound').optional(),
    observedAt: timestamp.optional(),
    expiresAt: timestamp.optional(),
    /** Upper bound from the terminal observation, distinct from the safe warm-until lower bound. */
    latestExpiresAt: timestamp.optional(),
    lastCompressionAt: timestamp.optional(),
  })
  .strict();

export type SessionCacheWarmth = z.infer<typeof sessionCacheWarmthSchema>;

export interface CacheRetentionSessionStatus {
  threadId: string;
  sessionId: string;
  state: 'waiting' | 'retaining' | 'stopped';
  retainUntil?: number;
  reason?: string;
  lastReturnReadRatio?: number;
}

export interface CacheRetentionMemberStatus {
  catId: string;
  supported: boolean;
  enabled: boolean;
  reason?: string;
  sessions: CacheRetentionSessionStatus[];
}
