import { z } from 'zod';
import {
  WATCHER_DEFAULT_CONCURRENCY,
  watcherPanelMemberSchema,
  watcherRoutingConfigSchema,
} from './watcher-routing.js';

export { watcherPanelMemberSchema } from './watcher-routing.js';

const watcherScopeSchema = z.enum(['all', 'selected']);

/** F335 experiment: several watchers judge the same settled turn with ordinary context. Absent = off. */
export const watcherPanelConfigSchema = z
  .object({
    enabled: z.boolean(),
    members: z
      .array(watcherPanelMemberSchema)
      .max(5)
      .refine((members) => new Set(members.map((member) => member.catId)).size === members.length, {
        message: 'watcher panel members must be distinct',
      }),
    /** Member runs across all threads; the rest wait in order. */
    maxConcurrentRuns: z.number().int().min(1).max(12),
  })
  .strict()
  .refine((panel) => !panel.enabled || panel.members.length > 0, {
    message: 'an enabled comparison requires at least one member',
  });

export type WatcherPanelConfig = z.infer<typeof watcherPanelConfigSchema>;

export const WATCHER_PANEL_DEFAULTS: Readonly<WatcherPanelConfig> = Object.freeze({
  enabled: false,
  members: [],
  maxConcurrentRuns: WATCHER_DEFAULT_CONCURRENCY,
});

export const watcherConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    scope: watcherScopeSchema.optional(),
    memberCatId: z.string().min(1).max(100).optional(),
    routing: watcherRoutingConfigSchema.optional(),
    doNotDisturbLabelIds: z.array(z.string().min(1).max(100)).max(100).optional(),
    panel: watcherPanelConfigSchema.optional(),
  })
  .strict();

export const watcherConfigSchema = watcherConfigPatchSchema.extend({
  enabled: z.boolean(),
  // Existing records that predate scope keep their original selected-thread semantics.
  // New installations use the explicit all/off values in WATCHER_CONFIG_DEFAULTS.
  scope: watcherScopeSchema.default('selected'),
  // Empty only for an unconfigured, disabled installation. PUT requires a real member.
  memberCatId: z.string().max(100),
  revision: z.number().int().nonnegative(),
  startedAfterSequence: z.number().int().nonnegative().optional(),
  /** A restart is distinct even when no work settled while watching was off. */
  activationRevision: z.number().int().nonnegative().optional(),
  activatedAt: z.number().int().nonnegative().optional(),
});

export type WatcherConfig = z.infer<typeof watcherConfigSchema>;
export type WatcherConfigPatch = z.infer<typeof watcherConfigPatchSchema>;

export const WATCHER_CONFIG_DEFAULTS: Readonly<WatcherConfig> = Object.freeze({
  enabled: false,
  scope: 'all',
  memberCatId: '',
  revision: 0,
});

/** Undefined is a new preference. Corrupt existing state is never treated as a default. */
export function parseWatcherConfig(raw: unknown): WatcherConfig {
  return watcherConfigSchema.parse(raw === undefined ? WATCHER_CONFIG_DEFAULTS : raw);
}

export function applyWatcherConfigPatch(current: WatcherConfig, raw: WatcherConfigPatch): WatcherConfig {
  const patch = watcherConfigPatchSchema.parse(raw);
  return watcherConfigSchema.parse({
    ...current,
    ...patch,
    ...(patch.routing ? { memberCatId: patch.routing.primary.catId, scope: 'all' } : {}),
    revision: current.revision + 1,
  });
}

export const watcherThreadControlSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    enabled: z.boolean().optional(),
    pausedUntil: z.number().int().nonnegative().optional(),
    changedAt: z.number().int().nonnegative().optional(),
    sourceMessageId: z.string().min(1).max(200).optional(),
    startedAfterSequence: z.number().int().nonnegative().optional(),
    activationRevision: z.number().int().nonnegative().optional(),
    activatedAt: z.number().int().nonnegative().optional(),
    undoOf: z.string().min(1).max(200).optional(),
    previousControl: z
      .object({ enabled: z.boolean().optional(), pausedUntil: z.number().int().nonnegative().optional() })
      .strict()
      .optional(),
  })
  .strict();

export const watcherThreadControlPatchSchema = z
  .object({
    enabled: z.boolean().nullable().optional(),
    pausedUntil: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export type WatcherControlWriteMetadata = {
  changedAt?: number;
  sourceMessageId?: string;
  startedAfterSequence?: number;
  undoOf?: string;
  previousControl?: { enabled?: boolean; pausedUntil?: number };
};

export type WatcherThreadControl = z.infer<typeof watcherThreadControlSchema>;
export type WatcherThreadControlPatch = z.infer<typeof watcherThreadControlPatchSchema>;

export function parseWatcherThreadControl(raw: unknown): WatcherThreadControl {
  return watcherThreadControlSchema.parse(raw === undefined ? { revision: 0 } : raw);
}

export function applyWatcherThreadControlPatch(
  current: WatcherThreadControl,
  raw: WatcherThreadControlPatch,
  metadata: WatcherControlWriteMetadata = {},
): WatcherThreadControl {
  const patch = watcherThreadControlPatchSchema.parse(raw);
  const next = { ...current, ...metadata, changedAt: metadata.changedAt ?? Date.now(), revision: current.revision + 1 };
  if (metadata.startedAfterSequence !== undefined) {
    next.activationRevision = next.revision;
    next.activatedAt = next.changedAt;
  }
  if (patch.enabled === null) delete next.enabled;
  else if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.pausedUntil === null) delete next.pausedUntil;
  else if (patch.pausedUntil !== undefined) next.pausedUntil = patch.pausedUntil;
  return watcherThreadControlSchema.parse(next);
}

export type WatcherCapability =
  | { supported: true; mechanism: 'native_revert'; maxWorkingContextTokens: 30000; toolPolicy: 'watcher' }
  | { supported: false; reason: string };

export const watcherCheckpointSchema = z
  .object({
    v: z.literal(1),
    notes: z.string().max(8000),
    consumedThrough: z.string().max(200),
    outcome: z.enum(['quiet', 'remembered', 'nudged', 'proposed']),
  })
  .strict();

export const watcherSessionStateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    afterSequence: z.number().int().nonnegative(),
    activationCut: z
      .string()
      .regex(/^\d+:\d+$/u)
      .optional(),
    rawSince: z.number().int().nonnegative().optional(),
    toolSchemaHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    notes: z.string().max(8000),
    rawWindowTokens: z.number().int().min(128).max(2500).optional(),
    skippedWindows: z.number().int().nonnegative().optional(),
    /** Bounded read receipts for this wake only; not a second memory store. */
    directoryReads: z
      .array(z.object({ key: z.string(), hash: z.string(), callId: z.string(), page: z.string().max(12000) }).strict())
      .max(6)
      .optional(),
    consumedThrough: z.string().max(200).optional(),
    wakeInvocationId: z.string().min(1).optional(),
    /** Raw body window may end inside a large message, without fabricating a summary. */
    messageOffset: z.number().int().nonnegative().optional(),
    backfillAfter: z
      .object({ messageId: z.string().min(1).max(200), offset: z.number().int().nonnegative() })
      .strict()
      .optional(),
    attempt: z
      .object({
        invocationId: z.string().min(1),
        sourceInvocationId: z.string().min(1),
        sourceSequence: z.number().int().nonnegative(),
        startedAt: z.number().int().nonnegative(),
        retries: z.number().int().nonnegative().optional(),
        /** Provider recovery probes are reserved durably before any CLI launch; not model attempts. */
        recoveryAttempts: z.number().int().nonnegative().optional(),
        recoveryRetryAt: z.number().int().nonnegative().optional(),
        recoveryControlKey: z.string().max(100).optional(),
        nativeTurnId: z.string().optional(),
        phase: z.enum(['running', 'prune_pending', 'finalize_pending', 'failed']),
        /** Exact completed native turn was reverted; only owner settlement remains. */
        prunedAt: z.number().int().nonnegative().optional(),
        failure: z.string().max(500).optional(),
        checkpoint: watcherCheckpointSchema.optional(),
        window: z
          .object({
            frontier: z.string().max(200),
            tokenBudget: z.number().int().min(128).max(2500).optional(),
            blockedMessageId: z.string().max(200).optional(),
            complete: z.boolean().optional(),
            resumeCursor: z
              .object({ messageId: z.string().min(1).max(200), offset: z.number().int().nonnegative() })
              .strict()
              .optional(),
            offset: z.number().int().nonnegative(),
            messageIds: z.array(z.string()).max(40),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type WatcherSessionState = z.infer<typeof watcherSessionStateSchema>;
/** Session-owner metadata, outside the strict watcherState grammar so older readers retain their cursor. */
export const watcherSurfaceRetirementSchema = z
  .object({
    id: z.string().min(1).max(200),
    wakeInvocationId: z.string().min(1),
    sourceInvocationId: z.string().min(1),
    sourceSequence: z.number().int().nonnegative(),
    oldSchemaHash: z.string().regex(/^[a-f0-9]{64}$/u),
    nativeCliSessionId: z.string().min(1).optional(),
    nativeTurnId: z.string().min(1).optional(),
    phase: z.enum(['pending', 'idle', 'retired']),
    probes: z.number().int().min(0).max(3),
    retryAt: z.number().int().nonnegative().optional(),
    lastFailure: z.string().max(500).optional(),
    successorSessionId: z.string().min(1).optional(),
  })
  .strict();
export type WatcherSurfaceRetirement = z.infer<typeof watcherSurfaceRetirementSchema>;
export type WatcherCheckpoint = z.infer<typeof watcherCheckpointSchema>;
export const watcherUsageSchema = z
  .object({
    reportedAt: z.number().int().nonnegative(),
    prefixTokens: z.number().int().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheCreationTokens: z.number().int().nonnegative().optional(),
    rewrittenTokens: z.number().int().nonnegative().optional(),
    // Request budget upper bound (estimated input + reserved output), not measured context usage.
    workingContextTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type WatcherUsage = z.infer<typeof watcherUsageSchema>;
export function parseWatcherSessionState(raw: unknown): WatcherSessionState {
  return watcherSessionStateSchema.parse(raw === undefined ? { revision: 0, afterSequence: 0, notes: '' } : raw);
}
