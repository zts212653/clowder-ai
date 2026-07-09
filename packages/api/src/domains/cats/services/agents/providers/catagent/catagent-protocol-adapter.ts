/**
 * CatAgent Protocol Adapter — F159 Phase G Slice G1
 *
 * Vendor-neutral seam between `CatAgentService` (the generic
 * "cat-as-an-agent" native provider) and protocol-specific wire implementations
 * (Anthropic Messages today; OpenAI Chat Completions in G2; Gemini in G3).
 *
 * `CatAgentService` only depends on this interface + the neutral types in
 * `catagent-protocol-types.ts`. No `Anthropic*` (or any other protocol-specific)
 * identifier may appear in service-layer code (AC-G12 — enforced by grep
 * verifier covering values, type imports, helper names, and local aliases).
 *
 * Each adapter is the truthful owner of its protocol:
 * - URL / headers / body serialisation
 * - Streaming response → neutral events parsing
 * - Transcript codec: encode service-held neutral blocks back into protocol-
 *   specific message shapes (`{ role, content }` for Anthropic; OpenAI's
 *   `{ role: 'assistant', content, tool_calls }` + `{ role: 'tool', ... }` etc.)
 * - Client family identity (used by account resolver to pick profile shape)
 * - Protocol id (used for audit + Hub UI label)
 */

import type {
  AdapterMessage,
  CatAgentNeutralBlock,
  CatAgentStreamEvent,
} from './catagent-protocol-types.js';

/** Credentials passed into the adapter at request build time (per-invocation). */
export interface AdapterCredentials {
  apiKey: string;
  baseURL?: string;
}

/** Tool definition surface used by `buildRequestBody`. Protocol-neutral. */
export interface AdapterToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

/**
 * Inputs to `buildRequestBody` — protocol-neutral fields that every adapter
 * must be able to render into a protocol-specific request body.
 */
export interface AdapterRequestInput {
  model: string;
  /**
   * The full opaque transcript (initial user prompt + per-turn assistant
   * encoded blocks + per-turn tool result encodings). Adapter internally
   * unwraps `payload` to its known shape; service never touches it.
   */
  messages: ReadonlyArray<AdapterMessage>;
  /** Tool definitions to expose to the model this turn. */
  tools: ReadonlyArray<AdapterToolDefinition>;
  /** Optional system prompt; placed per protocol convention. */
  systemPrompt?: string;
  /** Optional per-turn max output tokens cap (adapter may apply protocol default). */
  maxTokens?: number;
}

/**
 * Single tool execution result passed to `encodeToolResults` to compose the
 * next-turn user message (Anthropic) or tool message batch (OpenAI).
 */
export interface AdapterToolResult {
  /** Upstream protocol tool call id (echoed from the matching `CatAgentToolCallBlock.id`). */
  id: string;
  content: string;
  status: 'ok' | 'error';
}

/**
 * Protocol adapter seam.
 *
 * Per @gpt555 design gate (KD-17): the seam covers **HTTP + stream +
 * transcript codec + neutral identity** — not just HTTP/stream. Otherwise
 * service still has to know assistant-turn / tool-result message shapes,
 * and G2 (OpenAI Chat) would force a second refactor of the same surface.
 */
export interface CatAgentProtocolAdapter {
  /**
   * Account family identifier consumed by `resolveApiCredentials` to select
   * the correct profile shape (`'anthropic'` for `AnthropicMessagesAdapter`;
   * `'openai'` for the future `OpenAIChatAdapter`; etc.).
   */
  readonly clientFamily: string;

  /**
   * Protocol identifier used for audit + Hub UI label. Stable per
   * adapter class (e.g. `'anthropic-messages-v1'`).
   */
  readonly protocolId: string;

  // ── HTTP / wire layer ──

  /**
   * Build the absolute request URL. Adapter knows its default base URL +
   * endpoint path suffix; normalises trailing `/` and any redundant version
   * segments (see {@link https://github.com/clowder-labs/clowder-ai/pull/15
   * develop@90810122} `buildAnthropicMessagesUrl` for prior art).
   */
  buildRequestUrl(baseURL?: string): string;

  /**
   * Build HTTP headers — protocol version markers, auth, content type.
   * Caller provides only credentials; adapter knows its own version pins.
   */
  buildRequestHeaders(credentials: AdapterCredentials): Record<string, string>;

  /**
   * Build the request body as a JSON-serialisable object. Adapter is the
   * sole owner of body shape — service never constructs `{ model, messages,
   * stream, tools, system, max_tokens }` style structures directly.
   */
  buildRequestBody(input: AdapterRequestInput): unknown;

  // ── Stream layer ──

  /**
   * Consume the streaming HTTP response body and yield protocol-neutral
   * stream events. Internal SSE / chunked / JSONL parsing + Anthropic-shape
   * mapping (input usage, content block deltas, stop_reason) all stay inside
   * the adapter.
   */
  parseStreamEvents(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): AsyncIterable<CatAgentStreamEvent>;

  // ── Transcript codec (KD-17 core: the half that was missing pre-iteration) ──

  /**
   * Encode the initial user prompt into an `AdapterMessage`. Always the
   * first entry of `messages` in {@link AdapterRequestInput}.
   */
  encodeUserPrompt(prompt: string): AdapterMessage;

  /**
   * Encode an assistant turn (mix of text + tool_call blocks, in order)
   * into an `AdapterMessage`. The service accumulates `CatAgentNeutralBlock[]`
   * during streaming via `parseStreamEvents` and hands them off here at the
   * end of each turn — replacing the pre-G1 `messages.push({ role:
   * 'assistant', content: contentBlocks })` Anthropic shape leak at
   * `CatAgentService.ts:229`.
   */
  encodeAssistantTurn(blocks: ReadonlyArray<CatAgentNeutralBlock>): AdapterMessage;

  /**
   * Encode tool execution results into an `AdapterMessage`. Replaces the
   * pre-G1 `messages.push({ role: 'user', content: tool_result[] })`
   * Anthropic shape leak at `CatAgentService.ts:231`. Whether this maps to
   * Anthropic's `user`-with-`tool_result[]`, OpenAI's separate
   * `tool`-role messages, or something else is an adapter-internal concern.
   */
  encodeToolResults(results: ReadonlyArray<AdapterToolResult>): AdapterMessage;

  // ── Error formatting (protocol-neutral surface, protocol-aware text) ──

  /**
   * Map a HTTP-level fetch error (status + message) into a user-facing error
   * text. Replaces pre-G1 `service.handleFetchError` directly calling
   * `mapAnthropicError` (which emitted `"Anthropic API error (...)"` strings
   * straight from service code, leaking the protocol vendor name into a
   * service-layer responsibility).
   *
   * Service composes the returned `errorText` into the standard `error` +
   * `done` AgentMessage pair using its own context (catId, model, usage).
   */
  mapError(err: { status?: number; message?: string }): { errorText: string };

  // ── Stop-reason classification (protocol-aware terminal set) ──

  /**
   * Whether a `stop` event's `stopReason` indicates a terminal turn end
   * (model finished naturally, hit max tokens, refused, etc.) vs. a
   * pause-for-tool-use intermediate stop.
   *
   * Each protocol has its own terminal set:
   * - Anthropic: `end_turn` / `max_tokens` / `stop_sequence` / `refusal` /
   *   `model_context_window_exceeded`
   * - OpenAI: `stop` / `length` / `content_filter`
   * - Gemini: `STOP` / `MAX_TOKENS` / `SAFETY` / `RECITATION`
   *
   * Keeping this on the adapter (instead of letting service consult a shared
   * `TERMINAL_STOP_REASONS` constant) avoids the pre-G1 leak where service
   * had to know the Anthropic-specific terminal whitelist.
   */
  isTerminalStopReason(stopReason: string | null): boolean;
}
