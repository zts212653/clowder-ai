/**
 * Hook Override Types — F237 PR3
 *
 * Types for the HookOverrideStore: per-workspace runtime override layer
 * for prompt hook enable/disable, content overrides, and change tracking.
 *
 * Design rationale (KD-12): changes happen in override layer (not base files),
 * verified by eval, then evidence-backed baseline sedimentation.
 */

// ---------------------------------------------------------------------------
// Override state
// ---------------------------------------------------------------------------

/** Who created this override: operator (human) or auto-eval (system). */
export type HookOverrideSource = 'operator' | 'auto-eval';

/** Per-hook override state. Stored in Redis HASH per workspace. */
export interface HookOverride {
  hookId: string;
  /** Override enable/disable. undefined = use manifest baseline. */
  enabled?: boolean;
  /** Who set the enabled field (field-level provenance, sol P1 fix). */
  enabledSource?: HookOverrideSource;
  /** Override template content. undefined = use manifest template. */
  contentOverride?: string;
  /** Override content version (incremented on each content change). */
  contentVersion?: number;
  /**
   * Active epoch version — stable monotonic ID (R7 fix).
   * Propagated to trace pipeline for per-version eval grouping.
   * Set by setContentOverride/activateVersion, cleared by rollback/clear.
   */
  activeEpochVersion?: number;
  /** Who set contentOverride (field-level provenance, sol P1 fix). */
  contentSource?: HookOverrideSource;
  /**
   * Last operation source. Retained for backward compat but NOT reliable
   * for per-field provenance — use enabledSource/contentSource instead.
   * Sol finding: enable() after setContentOverride() overwrites this field,
   * corrupting provenance for limited-edit reconciliation.
   */
  source: HookOverrideSource;
  /** Last update timestamp (ms). */
  updatedAt: number;
  /** catId or 'system' who made the change. */
  updatedBy: string;
}

// ---------------------------------------------------------------------------
// Change event (ZSET time-indexed)
// ---------------------------------------------------------------------------

/** Possible override actions, recorded as change events. */
export type OverrideAction = 'enable' | 'disable' | 'content-set' | 'content-clear' | 'rollback' | 'version-activate';

/** Immutable record of an override change. TTL=0 (permanent, Iron Law 5). */
export interface OverrideChangeEvent {
  eventId: string;
  hookId: string;
  workspaceId: string;
  action: OverrideAction;
  source: HookOverrideSource;
  timestamp: number;
  actorId: string;
  /** Why this change was made (audit trail). */
  reason?: string;
  /** Content version at time of event (content-set only). Absent on legacy events. */
  contentVersion?: number;
  /**
   * Stable epoch version ID (P1-3 R6 fix). Monotonic, never resets.
   * Maps 1:1 to chain VersionEpoch.version. Used for snapshot keys
   * and version-activate target resolution. Absent on pre-R6 events.
   */
  epochVersion?: number;
}

// ---------------------------------------------------------------------------
// Sync snapshot (for pipeline hot-path)
// ---------------------------------------------------------------------------

/**
 * Pre-loaded override map for synchronous resolution in HookRegistry.
 * Loaded async once, then used sync in the pipeline hot path.
 */
export type HookOverrideSnapshot = ReadonlyMap<string, HookOverride>;
