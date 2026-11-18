import { z } from 'zod';

/** Observed cache facts owned by one canonical session. No prompts or credentials. */
export interface SessionCacheObservation {
  invocationId: string;
  nativeSessionId: string;
  runtime: string;
  model: string;
  requestStartedAt: number;
  /** Conservative lower bound when a carrier does not expose every internal API request start. */
  timeSource: 'invocation_start_lower_bound';
  observedAt: number;
  contextTokens: number;
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
    source: z.enum(['usage_ttl', 'empirical_session', 'unavailable']),
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
