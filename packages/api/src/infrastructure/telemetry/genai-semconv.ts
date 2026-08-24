/**
 * F152: GenAI Semantic Convention isolation layer.
 *
 * OTel GenAI Semantic Conventions are still Development-stage.
 * All internal code references these constants; upstream renames
 * only affect this file.
 */

// --- Stable attributes ---
export const GENAI_SYSTEM = 'gen_ai.system';
export const GENAI_MODEL = 'gen_ai.request.model';

// --- Development-stage attributes (may rename) ---
export const GENAI_TOKENS_INPUT = 'gen_ai.usage.input_tokens';
export const GENAI_TOKENS_OUTPUT = 'gen_ai.usage.output_tokens';

// --- Custom Clowder AI attributes ---
export const AGENT_ID = 'agent.id';
export const OPERATION_NAME = 'operation.name';
export const STATUS = 'status';
export const STREAM_ERROR_PATH = 'cat_cafe.stream_error.path';
export const TRIGGER = 'trigger';
/**
 * F192 build verdict 2026-06-03: thread-kind discriminator for C2 counters so
 * `eval:a2a` attribution can separate eval-domain / connector-hub noise from
 * real product-thread friction. Bounded values: 'eval_domain' | 'connector_hub'
 * | 'product'.
 */
export const THREAD_SYSTEM_KIND = 'thread.system_kind';

// --- Tool use span attributes ---
export const TOOL_NAME = 'tool.name';
export const TOOL_INPUT_KEYS = 'tool.input_keys';
export const TOOL_CATEGORY = 'tool.category';

// --- Routing decision span attributes ---
export const ROUTING_STRATEGY = 'cat_cafe.routing.strategy';
export const ROUTING_TARGET_CATS = 'cat_cafe.routing.target_cats';
export const ROUTING_INTENT = 'cat_cafe.routing.intent';
/** Bounded F177 event-wait resolver reject reason (12 enum values maximum). */
export const ROUTING_EVENT_WAIT_REASON = 'routing_event_wait_reason';
/** F167 Phase S bounded successor cardinality mode: single | parallel. */
export const ACTION_SUCCESSOR_MODE = 'action_successor.mode';

// --- F174 Phase D1: callback auth failure attributes ---
export const CALLBACK_TOOL = 'callback.tool';
export const CALLBACK_REASON = 'callback.reason';
/** Bounded F254 relevance suppressions; values come from FreshnessRelevanceReason. */
export const FRESHNESS_RELEVANCE_REASON = 'freshness.relevance_reason';

// --- F236 Track-1: anchor-first telemetry attributes ---
/**
 * Which anchor-first read-tool returned the payload:
 * pending-mentions | thread-context | list-tasks | get-message.
 * Bounded set (4 values) — safe as a metric label. Dedicated key (not
 * CALLBACK_TOOL) so the eval-domain query namespace `cat_cafe.anchor.*`
 * stays self-describing.
 */
export const ANCHOR_TOOL = 'anchor.tool';

// --- F231 AC-C3: profile update pipeline attributes ---
export const SIGNAL_KIND = 'signal.kind';
export const SEAL_REASON = 'seal.reason';

// --- F167 Phase O PR-O2: claim grounding telemetry attributes ---
/**
 * Bounded grounding attributes for shadow-mode telemetry counters.
 * Cardinality: claim_type(7) × verdict(3) = 21 max per tool.
 *
 * All values are from bounded enums in infrastructure/grounding/types.ts.
 */
export const GROUNDING_CLAIM_TYPE = 'grounding.claim_type';
export const GROUNDING_VERDICT = 'grounding.verdict';
export const GROUNDING_ACTION_FAMILY = 'grounding.action_family';
export const GROUNDING_SOURCE_TIER = 'grounding.source_tier';

// --- F296 B4b: bounded context-projection metric attributes ---
// These keys are metric-safe only because every producer value is normalized
// through the closed contract in context-projection-telemetry-contract.ts.
// IDs, epochs, refs and body-bearing values are intentionally absent.
export const CONTEXT_PROJECTION_DISPOSITION = 'context_projection.disposition';
export const CONTEXT_PROJECTION_REASON = 'context_projection.reason';
export const CONTEXT_PROJECTION_TRANSITION = 'context_projection.transition';
export const CONTEXT_PROJECTION_MODE = 'context_projection.mode';
export const CONTEXT_PROJECTION_DELTA_SIZE = 'context_projection.delta_size';
export const CONTEXT_PROJECTION_TIER = 'context_projection.tier';
export const CONTEXT_PROJECTION_LEDGER_OUTCOME = 'context_projection.ledger_outcome';

// --- Route aggregate attributes (set at route completion) ---
export const ROUTE_TOTAL_CATS_INVOKED = 'route.total_cats_invoked';
export const ROUTE_TOTAL_TOKENS = 'route.total_tokens';
export const ROUTE_HAS_A2A_HANDOFF = 'route.has_a2a_handoff';

/**
 * F153: Caller trace context for cross-route A2A propagation.
 * Aligns with W3C TraceContext fields (traceId, spanId, traceFlags).
 */
export interface CallerTraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}
