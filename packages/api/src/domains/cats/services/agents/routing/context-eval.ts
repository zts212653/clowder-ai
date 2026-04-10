// F148 OQ-2 Step 2: Pure function to extract context quality evaluation signals.
// Used at invocation completion to log automated quality metrics.
//
// Counting scope (砚砚 constraint #2):
// - All counts are per-invocation only (reset each worklist iteration / per-cat Map).
// - selfServeRetrievalCount: only search_evidence + get_thread_context (substring match
//   on toolName, covers both native MCP and HTTP callback name variants).

import type { CoverageMap } from './context-transport.js';

/** Self-serve retrieval tool name patterns (substring match) */
const RETRIEVAL_PATTERNS = ['search_evidence', 'get_thread_context'];

/** Input for extractContextEvalSignals */
export interface ContextEvalInput {
  coverageMap: CoverageMap;
  /** Tool names called during the invocation */
  toolNames: string[];
  /** Estimated token count of the cat's text response */
  responseTokenEstimate: number;
}

/** Structured evaluation signals for telemetry */
export interface ContextEvalSignals {
  /** Number of self-serve retrieval tool calls (search_evidence, get_thread_context) */
  selfServeRetrievalCount: number;
  /** Total tool calls during invocation */
  toolCallCount: number;
  /** Estimated token count of response text */
  responseTokenEstimate: number;
  /** Messages in the recent burst window */
  burstCount: number;
  /** Messages omitted (tombstoned) */
  omittedCount: number;
  /** Anchor messages injected */
  anchorCount: number;
  /** Whether threadMemory was available */
  hadThreadMemory: boolean;
  /** Number of retrieval hints provided */
  retrievalHintCount: number;
}

/**
 * Extract automated context quality signals from invocation data.
 * Pure function — no side effects, no LLM calls.
 */
export function extractContextEvalSignals(input: ContextEvalInput): ContextEvalSignals {
  const { coverageMap, toolNames, responseTokenEstimate } = input;

  const selfServeRetrievalCount = toolNames.filter((name) =>
    RETRIEVAL_PATTERNS.some((pattern) => name.includes(pattern)),
  ).length;

  return {
    selfServeRetrievalCount,
    toolCallCount: toolNames.length,
    responseTokenEstimate,
    burstCount: coverageMap.burst.count,
    omittedCount: coverageMap.omitted.count,
    anchorCount: coverageMap.anchorIds.length,
    hadThreadMemory: coverageMap.threadMemory?.available ?? false,
    retrievalHintCount: coverageMap.retrievalHints.length,
  };
}
