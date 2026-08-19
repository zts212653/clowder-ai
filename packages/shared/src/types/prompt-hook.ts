import type { CrossThreadCoordination } from './cross-thread-coordination.js';

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

  // -- operator-facing --
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
  reasonCode?: string;
}

export interface InjectionTraceSummary {
  turnId: string;
  sessionId: string;
  threadId: string;
  catId: string;
  timestamp: number;
  hooks: TraceEventSummary[];
  delivery: StageDeliveryDecision[];
  totalTokens: number;
  totalHooksFired: number;
  totalHooksSkipped: number;
  totalDurationMs: number;
}

/** Full trace detail — debug layer with content hashes, durations (TTL=7d) */
export interface InjectionTraceDetail {
  turnId: string;
  threadId: string;
  catId: string;
  timestamp: number;
  hooks: TraceEvent[];
}

// ---------------------------------------------------------------------------
// HookResolver — P2-B: resolver interface
// ---------------------------------------------------------------------------

export interface HookResolver {
  /**
   * Evaluate whether this hook should fire and prepare template variables.
   * Pure function — no mutable state, no store queries, no side effects.
   * All data comes from AssemblerInput (gathered by ContextAssembler).
   */
  resolve(input: AssemblerInput): ResolveResult;
}

// ---------------------------------------------------------------------------
// AssemblerInput — P2-B: centralized typed context bag
// ---------------------------------------------------------------------------

/** Routing mode for the current invocation. */
export type RoutingMode = 'independent' | 'serial' | 'parallel';

/** Snapshot of a cat's configuration (config lookups done once by assembler). */
export interface CatConfigSnapshot {
  displayName: string;
  nickname?: string;
  name: string;
  roleDescription: string;
  personality: string;
  defaultModel?: string;
  variantLabel?: string;
  isDefaultVariant?: boolean;
  mentionPatterns: readonly string[];
  restrictions?: readonly string[];
  caution?: string;
  clientId?: string;
  breedId?: string;
  teamStrengths?: string;
}

/** Pre-computed callable mention analysis. */
export interface CallableMentionsData {
  mentions: readonly string[];
  hasDuplicateDisplayNames: boolean;
  uniqueHandleExample: string | null;
}

/** Pre-resolved teammate info for D6. */
export interface TeammateSnapshot {
  id: string;
  displayName: string;
  nickname?: string;
  name: string;
  roleDescription: string;
}

/** Pre-resolved direct message info for D2/D3. */
export interface DirectMessageInfo {
  fromCatId: string;
  fromLabel: string;
  fromModel: string;
  fromDisplayName: string;
  fromVariantLabel?: string;
  isSameBreed: boolean;
}

/** Cross-thread reply hint for D4. */
export interface CrossThreadHintInput {
  sourceThreadId: string;
  senderCatId: string;
  effectClass?: string;
  coordination?: CrossThreadCoordination;
}

/** Ping-pong warning info for D5. */
export interface PingPongInput {
  otherLabel: string;
  count: number;
}

/** Active participant info for D12. */
export interface ActiveParticipantInput {
  catId: string;
  label: string;
  lastMessageAt: number;
}

/** SOP stage hint info for D14. */
export interface SopStageInput {
  featureId: string;
  stage: string;
  suggestedSkill: string;
  suggestedSkillSource?: string;
}

/** Bootcamp state info for D16. */
export interface BootcampInput {
  phase: string;
  leadCat?: string;
  selectedTaskId?: string;
}

/**
 * AssemblerInput — everything hooks need, gathered once by ContextAssembler.
 * Resolvers read from this bag — no store queries, no config lookups.
 */
export interface AssemblerInput {
  // --- Core identity (from catRegistry + config + runtime resolution) ---
  catId: string;
  catConfig: CatConfigSnapshot;
  runtimeModel: string;
  providerLabel: string;

  // --- Session-init computed (by ContextAssembler) ---
  callableMentions: CallableMentionsData;
  rosterContent: string | null;
  workflowTriggerContent: string | null;
  coCreatorName: string;
  coCreatorHandles: string;
  governanceDigest: string;
  mcpToolsSection: string;

  // --- Pack blocks ---
  packMasksBlock: string | null;
  packWorkflowsBlock: string | null;
  packGuardrailBlock: string | null;
  packDefaultsBlock: string | null;
  packWorldDriverSummary: string | null;

  // --- Routing context ---
  mode: RoutingMode;
  chainIndex: number | null;
  chainTotal: number | null;
  mcpAvailable: boolean;
  nativeL0Injected: boolean;
  a2aEnabled: boolean;

  // --- Per-turn dynamic (pre-resolved by assembler) ---
  directMessage: DirectMessageInfo | null;
  crossThreadReplyHint: CrossThreadHintInput | null;
  pingPongWarning: PingPongInput | null;
  teammates: readonly TeammateSnapshot[];
  mentionRoutingItems: readonly string[];
  promptTags: readonly string[];
  activeParticipants: readonly ActiveParticipantInput[];
  routingPolicyParts: string | null;
  sopStageHint: SopStageInput | null;
  voiceMode: boolean;
  bootcampState: BootcampInput | null;
  threadId: string | null;
  bootcampMemberCount: number | null;
  guidePromptLines: string | null;
  conciergeLines: readonly string[] | null;

  // --- World / Knowledge / Signals ---
  worldContext: WorldContextInput | null;
  alwaysOnDocsBlock: string | null;
  activeSignalsBlock: string | null;

  // --- Pre-loaded template content (for D8/D21 which use file loading) ---
  a2aBallCheckContent: string | null;
  handoffDecisionTreeContent: string | null;

  // --- Co-creator mention (for D21 template {{CC_MENTION}}) ---
  coCreatorFirstMention: string;
}

/** Flattened world context for D18 resolver. */
export interface WorldContextInput {
  worldName: string;
  worldStatus: string;
  constitutionLine: string;
  sceneName: string;
  sceneStatus: string;
  charactersBlock: string;
  canonBlock: string;
  recentEventsBlock: string;
  careHintLine: string;
}
