/**
 * Agent Service Types
 * Agent 服务的共享类型定义
 */

import type { CatId, MessageContent, ReplyPreview } from '@cat-cafe/shared';
import type { Span } from '@opentelemetry/api';
import type { CliSpawnOptions } from '../../../utils/cli-types.js';

/** F8: Unified token usage type across all three cats.
 *  inputTokens = TOTAL input tokens (new + cached). Normalised at extraction
 *  so that the field has the same semantics regardless of provider.
 *  cacheReadTokens = subset of inputTokens served from cache. */
export interface TokenUsage {
  inputTokens?: number; // Total input (normalised across providers) — AGGREGATED across turns
  outputTokens?: number;
  totalTokens?: number; // Gemini fallback (doesn't split in/out)
  cacheReadTokens?: number; // Subset of inputTokens from cache (Claude + Codex)
  cacheCreationTokens?: number; // Subset of inputTokens written to cache (Claude only)
  costUsd?: number; // Claude only
  durationMs?: number; // Claude: total duration
  durationApiMs?: number; // Claude: pure API duration
  numTurns?: number; // Claude: number of turns
  contextWindowSize?: number; // F24: context window capacity (Claude: exact, others: fallback)
  /** F24-fix: Last API turn's total input tokens (= actual context fill).
   *  Unlike inputTokens which is aggregated across all turns, this value
   *  represents the single most recent API call's input size. */
  lastTurnInputTokens?: number;
  /** Codex session token_count: exact current context usage shown by CLI status. */
  contextUsedTokens?: number;
  /** Codex session token_count: reset timestamp (epoch ms) for display-only hint. */
  contextResetsAtMs?: number;
}

/** F8: Accumulate token usage — adds numeric fields from `incoming` into `existing` */
export function mergeTokenUsage(existing: TokenUsage | undefined, incoming: TokenUsage): TokenUsage {
  if (!existing) return { ...incoming };
  const result = { ...existing };
  const numericKeys: (keyof TokenUsage)[] = [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
    'costUsd',
    'durationMs',
    'durationApiMs',
    'numTurns',
  ];
  for (const key of numericKeys) {
    const val = incoming[key];
    if (val != null) {
      result[key] = ((result[key] as number) ?? 0) + (val as number);
    }
  }
  // Non-aggregating contextual fields should keep the most recent snapshot.
  const latestKeys: (keyof TokenUsage)[] = [
    'contextWindowSize',
    'lastTurnInputTokens',
    'contextUsedTokens',
    'contextResetsAtMs',
  ];
  for (const key of latestKeys) {
    const val = incoming[key];
    if (val != null) {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Metadata about the provider/model behind an agent message
 */
export interface MessageMetadata {
  provider: string;
  model: string;
  sessionId?: string;
  usage?: TokenUsage;
  /** F061: false when provider cannot verify which model actually ran (e.g. CDP bridge) */
  modelVerified?: boolean;
  /** F061: diagnostic context attached when empty_response is triggered */
  diagnostics?: Record<string, unknown>;
}

/**
 * Correlation fields used by audit pipelines to connect service-level events.
 */
export interface AuditContext {
  invocationId: string;
  threadId: string;
  userId: string;
  catId: CatId;
}

/**
 * Types of messages that can be yielded from an agent
 */
export type AgentMessageType =
  | 'session_init'
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'error'
  | 'done'
  | 'a2a_handoff'
  | 'system_info' // budget warnings, cancel feedback, extraction progress, thinking
  | 'provider_signal' // F149: upstream capacity/retry signals — skipped by invocation timeout & content flags
  | 'liveness_signal'; // F149: stream idle watchdog — skipped by invocation timeout & content flags

/**
 * A message yielded from an agent during invocation
 */
export interface AgentMessage {
  /** The type of this message */
  type: AgentMessageType;
  /** Which cat (agent) produced this message */
  catId: CatId;
  /** Text content (for 'text' and 'tool_result' types) */
  content?: string;
  /** Session ID (for 'session_init' type) */
  sessionId?: string;
  /** ACP transport: sessionId is per-invocation, not a persistent CLI session.
   *  When true, a different sessionId does NOT mean "session replaced" — skip seal. */
  ephemeralSession?: boolean;
  /** Tool name (for 'tool_use' type) */
  toolName?: string;
  /** Tool input parameters (for 'tool_use' type) */
  toolInput?: Record<string, unknown>;
  /** Error message (for 'error' type) */
  error?: string;
  /** Whether this is the final 'done' in a multi-cat invocation (for 'done' type) */
  isFinal?: boolean;
  /** Provider/model metadata (set by agent services) */
  metadata?: MessageMetadata;
  /** Message origin: stream = CLI stdout (thinking), callback = MCP post_message (speech) */
  origin?: 'stream' | 'callback';
  /** Backend stored-message ID (set for callback post-message, used for rich_block correlation) */
  messageId?: string;
  /** F52: Cross-thread origin metadata (set for cross-thread callback messages) */
  extra?: { crossPost?: { sourceThreadId: string; sourceInvocationId?: string }; targetCats?: string[] };
  /** F121: ID of the message this message is replying to */
  replyTo?: string;
  /** F121: Hydrated preview of the replied-to message */
  replyPreview?: ReplyPreview;
  /** F061: Whether this message mentions the co-creator (@user/@铲屎官/configured patterns) */
  mentionsUser?: boolean;
  /** F108: Invocation ID — allows frontend to distinguish messages from concurrent invocations */
  invocationId?: string;
  /** F070: Structured error code for recoverable failures (e.g. GOVERNANCE_BOOTSTRAP_REQUIRED) */
  errorCode?: string;
  /** When this message was created */
  timestamp: number;
}

/**
 * Override factory: replaces spawnCli() for tmux-based execution.
 * Same event contract — callers iterate events identically.
 */
export type SpawnCliOverride = (options: CliSpawnOptions) => AsyncGenerator<unknown, void, undefined>;

/**
 * Options for invoking an agent
 */
export interface AgentServiceOptions {
  /** Session ID to resume (optional) */
  sessionId?: string;
  /** Working directory for the agent */
  workingDirectory?: string;
  /** Env vars to pass to CLI process for MCP callback auth */
  callbackEnv?: Record<string, string>;
  /** Rich content blocks (e.g. images) to pass to the CLI agent */
  contentBlocks?: readonly MessageContent[];
  /** Upload directory for resolving image paths */
  uploadDir?: string;
  /** AbortSignal to cancel the invocation */
  signal?: AbortSignal;
  /** Correlation context for audit logging and raw trace linking */
  auditContext?: AuditContext;
  /** Static identity prompt (Claude: --append-system-prompt, others: prepend to prompt) */
  systemPrompt?: string;
  /** F089: Override spawnCli with tmux-based spawner (set per-invocation) */
  spawnCliOverride?: SpawnCliOverride;
  /** F118: Invocation ID for diagnostic enrichment of __cliTimeout */
  invocationId?: string;
  /** F118: CLI session ID for diagnostic enrichment of __cliTimeout */
  cliSessionId?: string;
  /** F118 Phase B: Liveness probe config (undefined = disabled) */
  livenessProbe?: {
    sampleIntervalMs?: number;
    softWarningMs?: number;
    stallWarningMs?: number;
    boundedExtensionFactor?: number;
    /** #774: Auto-kill on idle-silent suspected_stall instead of waiting for full timeout */
    stallAutoKill?: boolean;
  };
  /** F127: Extra --config key=value pairs to pass to the CLI. */
  cliConfigArgs?: readonly string[];
  /** F153 Phase B: Parent OTel span for creating CLI session child span */
  parentSpan?: Span;
}

/**
 * Interface that all agent services must implement
 */
export interface AgentService {
  /**
   * Invoke the agent with a prompt and stream back messages
   * @param prompt The user's prompt/message
   * @param options Optional configuration
   * @returns An async iterable of agent messages
   */
  invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage>;
}
