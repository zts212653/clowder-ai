/**
 * Prompt Hook Pipeline Types — F237 Phase 2
 *
 * Defines the hook manifest schema, registry interfaces, trace events,
 * and override store types for the declarative prompt hook pipeline.
 */

// ---------------------------------------------------------------------------
// Hook Stages
// ---------------------------------------------------------------------------

/** The two pipeline execution stages, matching existing builder functions. */
export type HookStage = 'session-init' | 'per-turn';

// ---------------------------------------------------------------------------
// Safety / Governance Tiers (carried from Phase 1 manifest)
// ---------------------------------------------------------------------------

export type SafetyTier = 'readonly' | 'limited-edit' | 'editable';
export type TransparencyTier = 'visible-by-default' | 'opt-in-view' | 'debug-only';
export type GovernanceTier = 'immutable' | 'human-gated' | 'auto-evolve';

// ---------------------------------------------------------------------------
// HookManifest — parsed from hook.yaml
// ---------------------------------------------------------------------------

export interface HookManifest {
  /** Stable segment identifier (S1, D5, L3, etc.) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Which pipeline stage this hook belongs to */
  stage: HookStage;
  /** Execution order within stage (100-step spacing for builtins) */
  order: number;
  /** Current content version */
  version: number;
  /** Whether this hook is enabled by default */
  enabled: boolean;

  // -- Content resolution --
  /** Path to content template file (relative to hook directory) */
  template: string;
  /** Resolver class name (optional — hooks without resolver always fire) */
  resolver?: string;

  // -- Dependencies --
  /** AssemblerInput fields this hook reads */
  inputs: string[];

  // -- Override constraints --
  /** Whether runtime disable is allowed (false = immutable, e.g. S1/D8/L1-L7) */
  disableable: boolean;

  // -- Classification (Phase 1 3-axis) --
  safetyTier: SafetyTier;
  transparencyTier: TransparencyTier;
  governanceTier: GovernanceTier;

  // -- CVO-facing --
  userExplanation?: string;
}

// ---------------------------------------------------------------------------
// RegisteredHook — manifest + resolved runtime state
// ---------------------------------------------------------------------------

export interface RegisteredHook {
  manifest: HookManifest;
  /** Absolute path to the hook directory */
  dirPath: string;
  /** Absolute path to the template file */
  templatePath: string;
}

// ---------------------------------------------------------------------------
// EffectiveHookState — override ?? baseline
// ---------------------------------------------------------------------------

export interface EffectiveHookState {
  enabled: boolean;
  version: number;
  templateOverride: string | null;
  source: 'baseline' | 'operator' | 'auto-eval';
}

// ---------------------------------------------------------------------------
// HookOverride — runtime override record
// ---------------------------------------------------------------------------

export interface HookOverride {
  enabled?: boolean;
  version?: number;
  templateContent?: string;
  source: 'operator' | 'auto-eval';
  updatedAt: number;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Override constraint violation
// ---------------------------------------------------------------------------

export interface OverrideConstraintError {
  hookId: string;
  constraint: 'disableable' | 'safetyTier' | 'governanceTier';
  message: string;
}

// ---------------------------------------------------------------------------
// Resolve result (discriminated union)
// ---------------------------------------------------------------------------

export type ResolveResult =
  | { status: 'fired'; vars: Record<string, string>; templateVersion?: number }
  | { status: 'skipped'; reasonCode: string; reason: string };

// ---------------------------------------------------------------------------
// TraceEvent (discriminated union)
// ---------------------------------------------------------------------------

interface TraceEventBase {
  hookId: string;
  stage: HookStage;
  timestamp: number;
}

export interface TraceEventFired extends TraceEventBase {
  status: 'fired';
  version: number;
  contentHash: string;
  tokenEstimate: number;
}

export interface TraceEventSkipped extends TraceEventBase {
  status: 'skipped';
  reasonCode: string;
  reason: string;
}

export interface TraceEventDisabled extends TraceEventBase {
  status: 'disabled';
  disabledBy: 'manifest' | 'operator' | 'auto-eval';
}

export interface TraceEventObserved extends TraceEventBase {
  status: 'observed';
  contentHash: string;
  tokenEstimate: number;
}

export type TraceEvent = TraceEventFired | TraceEventSkipped | TraceEventDisabled | TraceEventObserved;

// ---------------------------------------------------------------------------
// Delivery channel awareness
// ---------------------------------------------------------------------------

export type DeliveryChannel = 'message-prepend' | 'native-l0' | 'pack-only' | 'always-delivered';

export interface StageDeliveryDecision {
  stage: HookStage;
  delivered: boolean;
  channel: DeliveryChannel;
  reason: string;
}

// ---------------------------------------------------------------------------
// PromptPatch — output of a fired hook
// ---------------------------------------------------------------------------

export interface PromptPatch {
  hookId: string;
  content: string;
  order: number;
}

// ---------------------------------------------------------------------------
// InjectionTrace — persistence layers
// ---------------------------------------------------------------------------

export interface TraceEventSummary {
  hookId: string;
  status: TraceEvent['status'];
  version?: number;
  tokenEstimate?: number;
}

export interface InjectionTraceSummary {
  turnId: string;
  sessionId: string;
  threadId: string;
  catId: string;
  hooks: TraceEventSummary[];
  delivery: StageDeliveryDecision[];
  totalTokens: number;
  totalHooksFired: number;
}
