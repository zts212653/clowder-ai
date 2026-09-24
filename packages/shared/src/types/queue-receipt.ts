export type QueueHandledDisposition = 'responded' | 'completed_with_turn';

export type MessageWorkDisposition = 'continue_current' | 'next_work';

/** Exact provider + concrete transport truth used by composer, Queue and receipts. */
export type FreshnessCarrierProvider = 'openai_codex' | 'anthropic' | 'opencode' | 'kimi' | 'other';
export type FreshnessCarrier =
  | 'codex_app_server'
  | 'codex_exec_json'
  | 'claude_agent_sdk'
  | 'claude_print_sdk'
  | 'claude_stream_json'
  | 'kimi_stream_json'
  | 'mcp_result_piggyback'
  | 'other';
export type FreshnessCarrierDeliverySemantics =
  | 'exact_active_turn'
  | 'queued_internal_turn'
  | 'mcp_result_piggyback'
  | 'unsupported'
  | 'undeclared';
export type ActiveInvocationGuidanceCapability = 'supported' | 'unsupported' | 'undeclared';

export interface FreshnessCarrierCapability {
  provider: FreshnessCarrierProvider;
  carrier: FreshnessCarrier;
  deliverySemantics: FreshnessCarrierDeliverySemantics;
  /** Whether this concrete adapter can append input to its current invocation without interrupting it. */
  activeInvocationGuidance: ActiveInvocationGuidanceCapability;
}

export const FRESHNESS_CARRIER_PROVIDERS = [
  'openai_codex',
  'anthropic',
  'opencode',
  'kimi',
  'other',
] as const satisfies readonly FreshnessCarrierProvider[];

export const FRESHNESS_CARRIERS = [
  'codex_app_server',
  'codex_exec_json',
  'claude_agent_sdk',
  'claude_print_sdk',
  'claude_stream_json',
  'kimi_stream_json',
  'mcp_result_piggyback',
  'other',
] as const satisfies readonly FreshnessCarrier[];

export const FRESHNESS_CARRIER_DELIVERY_SEMANTICS = [
  'exact_active_turn',
  'queued_internal_turn',
  'mcp_result_piggyback',
  'unsupported',
  'undeclared',
] as const satisfies readonly FreshnessCarrierDeliverySemantics[];
export const ACTIVE_INVOCATION_GUIDANCE_CAPABILITIES = [
  'supported',
  'unsupported',
  'undeclared',
] as const satisfies readonly ActiveInvocationGuidanceCapability[];

const FRESHNESS_CARRIER_PROVIDER_SET = new Set<string>(FRESHNESS_CARRIER_PROVIDERS);
const FRESHNESS_CARRIER_SET = new Set<string>(FRESHNESS_CARRIERS);
const FRESHNESS_CARRIER_DELIVERY_SEMANTICS_SET = new Set<string>(FRESHNESS_CARRIER_DELIVERY_SEMANTICS);
const ACTIVE_INVOCATION_GUIDANCE_CAPABILITY_SET = new Set<string>(ACTIVE_INVOCATION_GUIDANCE_CAPABILITIES);

/** Runtime parser shared by API and Web so new carrier literals cannot silently become undeclared. */
export function parseFreshnessCarrierCapability(value: unknown): FreshnessCarrierCapability | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.provider !== 'string' ||
    typeof candidate.carrier !== 'string' ||
    typeof candidate.deliverySemantics !== 'string' ||
    typeof candidate.activeInvocationGuidance !== 'string' ||
    !FRESHNESS_CARRIER_PROVIDER_SET.has(candidate.provider) ||
    !FRESHNESS_CARRIER_SET.has(candidate.carrier) ||
    !FRESHNESS_CARRIER_DELIVERY_SEMANTICS_SET.has(candidate.deliverySemantics) ||
    !ACTIVE_INVOCATION_GUIDANCE_CAPABILITY_SET.has(candidate.activeInvocationGuidance)
  ) {
    return undefined;
  }
  return candidate as unknown as FreshnessCarrierCapability;
}

/**
 * Product capability for adding input to the member's current invocation.
 * Freshness precision is a separate fact: exact-active-turn and queued-internal-turn
 * carriers can both guide the same invocation, while only the former proves that
 * the currently visible provider turn consumed the input.
 */
export function supportsActiveInvocationGuidance(capability: FreshnessCarrierCapability | undefined): boolean {
  return capability?.activeInvocationGuidance === 'supported';
}

export type QueueAuthorIntentFallbackReason =
  | 'no_active_parent'
  | 'carrier_capability_undeclared'
  | 'unsupported_carrier'
  | 'parent_terminal_before_exposure'
  | 'parent_non_success_after_exposure';

/**
 * Immutable author request plus an append-only fail-closed fallback fact.
 * `continue_current` requests non-interrupting guidance of the member's current
 * invocation. It is still only delivery permission: neither the request nor
 * provider/local acceptance is proof that the currently visible turn read it.
 */
export interface QueueAuthorIntent {
  requested: MessageWorkDisposition;
  /** Immutable admission-time snapshot; missing is accepted only for legacy stored receipts. */
  carrierCapability?: FreshnessCarrierCapability;
  boundParentInvocationId?: string;
  fallbackAt?: number;
  fallbackReason?: QueueAuthorIntentFallbackReason;
}

export interface QueueAuthorIntentReceipt extends QueueAuthorIntent {
  effective: MessageWorkDisposition;
}

export interface QueueLineageEvidenceRef {
  kind: 'invocation_lineage';
  invocationId: string;
}

/** Durable terminal child truth without a persisted timeline lineage. */
export interface QueueTurnExecutionEvidenceRef {
  kind: 'turn_execution';
  invocationId: string;
}

export type QueueTargetOutcomeEvidenceRef = QueueLineageEvidenceRef | QueueTurnExecutionEvidenceRef;

export interface QueueTerminalSilentConsumptionWitness {
  kind: 'terminal_silent';
  projectionState: 'covered_empty';
  wake: 'coordination_terminal';
}

/**
 * Durable proof that this exact child published one or more user-visible
 * outputs which explicitly name the enclosing Queue source message.
 */
export interface QueueSourceResponseConsumptionWitness {
  kind: 'source_response';
  outputMessageIds: string[];
}

/** Existing structured tools consumed one managed wake by establishing its successor condition. */
export interface QueueManagedHoldContinuationWitness {
  kind: 'managed_hold_continued';
  sourceMessageId: string;
  taskId: string;
  transition: 'reheld' | 'event_wait' | 'transferred';
  /** New event_wait commits require this exact private Task registration reference. */
  waitRegistration?: { taskId: string; generation: number };
}

/**
 * Durable proof that an exact A2A carrier was terminally handled while the
 * provider ended before independently grounded owner work could continue.
 */
export interface QueueDispatchHandledContinuationWitness {
  kind: 'dispatch_handled_continuation';
  sourceMessageId: string;
  dispositionEventId: string;
  dispositionAt: number;
}

export type QueueTerminalConsumptionWitness =
  | QueueTerminalSilentConsumptionWitness
  | QueueSourceResponseConsumptionWitness
  | QueueManagedHoldContinuationWitness
  | QueueDispatchHandledContinuationWitness;

export interface QueueTargetOutcome {
  invocationId: string;
  disposition: QueueHandledDisposition;
  evidenceRef: QueueTargetOutcomeEvidenceRef;
  handledAt: number;
  consumption?: QueueTerminalConsumptionWitness;
}

/**
 * One immutable delivery attempt for one target of an authored Queue message.
 * A retry always appends a new attempt; it never rewrites the failed one or
 * creates a second user message.
 */
export type QueueTargetAttemptState =
  | 'queued'
  | 'starting'
  | 'appended'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'handled';
export type QueueTargetAttemptTerminalReason =
  | 'invocation_failed'
  | 'control_plane_unavailable'
  | 'execution_owner_lost'
  | 'prestart_timeout'
  | 'runtime_restart'
  | 'invocation_cancelled'
  | 'source_withdrawn';

export interface QueueTargetAttempt {
  id: string;
  targetCatId: string;
  sequence: number;
  state: QueueTargetAttemptState;
  createdAt: number;
  updatedAt: number;
  invocationId?: string;
  /** Exact prompt-body exposure time when this attempt reached a reply. */
  seenAt?: number;
  /**
   * Durable provider acknowledgement that this source entered an already-active
   * invocation through the client's generic append capability. Mere exposure,
   * batching, or matching invocation ids must never populate this field.
   */
  activeAppendAcceptedAt?: number;
  terminalReason?: QueueTargetAttemptTerminalReason;
}

/** One server-projected Queue escape hatch, including its exact executable request. */
export interface QueueRecoveryRequest {
  method: 'POST' | 'DELETE';
  path: string;
  body?: Readonly<Record<string, string>>;
}

export type QueueRecoveryAction =
  | {
      id: string;
      entryId: string;
      kind: 'steer';
      request: QueueRecoveryRequest;
    }
  | {
      id: string;
      entryId: string;
      kind: 'retry_target';
      targetCatId: string;
      request: QueueRecoveryRequest;
    }
  | {
      id: string;
      entryId: string;
      kind: 'force_reset';
      request: QueueRecoveryRequest;
    }
  | {
      id: string;
      entryId: string;
      kind: 'withdraw';
      request: QueueRecoveryRequest;
    };
