/**
 * CatAgent Protocol Types — F159 Phase G Slice G1
 *
 * Protocol-neutral block / event / usage types for CatAgent.
 *
 * G1 把 service 层从 Anthropic-specific 类型解耦：service 只持有 neutral
 * 类型；协议特定的形状（Anthropic content blocks / tool_result / usage 字段）
 * 封闭在 adapter 内（见 anthropic-messages-adapter.ts）。
 *
 * 这是 KD-17 / AC-G11 的实施：CatAgentStreamEvent 必须只引用 neutral 类型，
 * 不再 import 任何 `Anthropic*` 类型。
 */

import type { TokenUsage } from '../../../types.js';

// ── Neutral content blocks (assistant turn state) ──

/** Neutral text block — adapter maps from protocol-specific text content. */
export interface CatAgentTextBlock {
  type: 'text';
  text: string;
}

/**
 * Neutral tool call block — adapter maps from
 *   Anthropic `tool_use` / OpenAI `function_call` / Gemini `functionCall` etc.
 *
 * `id` is the upstream protocol's tool call ID (Anthropic `toolu_*`,
 * OpenAI `call_*`). Carried back into next-turn `tool_result` / `tool_call_id`
 * by `adapter.encodeToolResults`.
 */
export interface CatAgentToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Discriminated union — service-side turn state type.
 *
 * Replaces `AnthropicContentBlock` as the type of `contentBlocks` in `TurnResult`
 * and the per-block accumulator in `consumeTurn` (`CatAgentService.ts:253/293`
 * before G1).
 */
export type CatAgentNeutralBlock = CatAgentTextBlock | CatAgentToolCallBlock;

// ── Neutral usage delta ──

/**
 * Neutral usage delta — adapter normalises protocol-specific usage shape
 * (Anthropic `input_tokens` / `output_tokens` / `cache_*`; OpenAI
 * `prompt_tokens` / `completion_tokens`; Gemini `promptTokenCount` /
 * `candidatesTokenCount`) before yielding `usage_update`.
 *
 * Carries the same fields as {@link TokenUsage} but every field is optional
 * because a single `usage_update` event may only deliver part of the delta
 * (e.g. Anthropic `message_start` delivers input, `message_delta` delivers
 * output). The service merges these into a complete `TokenUsage` per turn.
 *
 * NOTE: `cacheReadTokens` / `cacheCreationTokens` are kept on this event
 * surface (rather than collapsed into `inputTokens`) so audit / OTel
 * downstream can keep the Anthropic prompt-cache observability without
 * leaking Anthropic-shaped types into service-layer code.
 */
export interface CatAgentUsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

// ── Adapter message (opaque to service) ──

/**
 * Opaque transcript message — service holds `messages: AdapterMessage[]` and
 * **never reads / destructures it**. The adapter's `encodeAssistantTurn` /
 * `encodeToolResults` produce these; only the adapter's `buildRequestBody`
 * knows how to serialise them back into the protocol-specific request shape.
 *
 * AC-G12: opacity is enforced by the type system (no exported shape) + grep
 * verifier (service module must not import / alias / inspect any
 * `Anthropic*` typedef). The `__adapterMessage` brand exists purely to make
 * the type nominal — accidental object literals don't satisfy it.
 */
export interface AdapterMessage {
  readonly __adapterMessage: true;
  /** Adapter-internal payload — concrete adapters use whatever shape they need. */
  readonly payload: unknown;
}

// ── Stream event surface (replaces AnthropicContentBlock-bearing variant) ──

/**
 * Protocol-neutral stream event.
 *
 * All `CatAgentProtocolAdapter.parseStreamEvents` implementations yield this
 * discriminated union; service consumes it without any Anthropic-specific
 * knowledge.
 *
 * Moved here from `catagent-stream-parser.ts` as part of G1 to enforce
 * neutrality at the type boundary (AC-G11). The parser file becomes a private
 * implementation helper of `AnthropicMessagesAdapter`.
 */
export type CatAgentStreamEvent =
  | { type: 'text_delta'; text: string; blockIndex: number }
  | { type: 'content_block_complete'; block: CatAgentNeutralBlock; blockIndex: number }
  | { type: 'usage_update'; usage: CatAgentUsageDelta }
  | { type: 'stop'; stopReason: string | null }
  | { type: 'stream_error'; error: string };
