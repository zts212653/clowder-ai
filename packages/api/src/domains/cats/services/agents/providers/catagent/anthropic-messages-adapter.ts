/**
 * Anthropic Messages Adapter — F159 Phase G Slice G1
 *
 * Concrete implementation of {@link CatAgentProtocolAdapter} for the Anthropic
 * Messages API (`POST /v1/messages`, `anthropic-version: 2023-06-01`, SSE
 * stream).
 *
 * KD-15 (truthful naming): adapter is intentionally named `Anthropic*` —
 * this file owns the Anthropic-specific wire shape (URL, headers, body,
 * stream events, transcript codec). The neutral seam in
 * `CatAgentService` only sees `CatAgentProtocolAdapter`.
 *
 * KD-17: this adapter covers all four seam layers — HTTP, stream, transcript
 * codec, and family/id — so service never has to know the Anthropic message
 * shape (`{ role: 'assistant', content: AnthropicContentBlock[] }`,
 * `{ role: 'user', content: tool_result[] }` etc.).
 *
 * Per @gpt555 step-3 advisory: `AdapterMessage` opacity is preserved by the
 * private {@link wrapMessage} factory + AC-G12 grep verifier — service must
 * never construct `{ __adapterMessage: true, payload: ... }` directly.
 */

import type {
  AdapterCredentials,
  AdapterRequestInput,
  AdapterToolResult,
  CatAgentProtocolAdapter,
} from './catagent-protocol-adapter.js';
import type { AnthropicContentBlock } from './catagent-event-bridge.js';
import type {
  AdapterMessage,
  CatAgentNeutralBlock,
  CatAgentStreamEvent,
} from './catagent-protocol-types.js';
import { TERMINAL_STOP_REASONS } from './catagent-event-bridge.js';
import { parseAnthropicSSE } from './catagent-stream-parser.js';

// ── Anthropic protocol constants (adapter-owned, not service-owned) ──

const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Build the Anthropic Messages endpoint URL, normalising trailing `/v1` so
 * proxies that publish `baseUrl: https://gateway.example/v1` (OpenAI-style
 * convention) don't double-prefix into `/v1/v1/messages`.
 *
 * Moved here from `CatAgentService.ts` (develop@90810122) as part of G1 —
 * the helper is Anthropic-protocol-specific and belongs in the adapter.
 */
function buildAnthropicMessagesUrl(baseURL?: string): string {
  const rawBaseUrl = baseURL?.trim() || DEFAULT_BASE_URL;
  const root = rawBaseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
  return `${root}/v1/messages`;
}

// ── AdapterMessage factory (private — opacity guardrail) ──

/**
 * Internal AdapterMessage payload shape for Anthropic Messages protocol —
 * `{ role: 'user' | 'assistant', content: <text | content[] | tool_result[]> }`.
 * Service-layer code never sees or constructs this; only the adapter does.
 */
interface AnthropicMessagePayload {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[] | AnthropicToolResultBlock[];
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

/**
 * Private factory — only place in the adapter (and the whole codebase) where
 * a fresh `AdapterMessage` is constructed. AC-G12 grep verifier asserts no
 * other module — especially `CatAgentService` — contains `__adapterMessage`
 * as a literal key. Per @gpt555 step-3 advisory.
 */
function wrapMessage(payload: AnthropicMessagePayload): AdapterMessage {
  return { __adapterMessage: true, payload };
}

function unwrapMessage(message: AdapterMessage): AnthropicMessagePayload {
  return message.payload as AnthropicMessagePayload;
}

// ── Neutral block → Anthropic content block ──

function neutralBlockToAnthropic(block: CatAgentNeutralBlock): AnthropicContentBlock {
  if (block.type === 'text') return { type: 'text', text: block.text };
  return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
}

// ── The adapter ──

export class AnthropicMessagesAdapter implements CatAgentProtocolAdapter {
  readonly clientFamily = 'anthropic' as const;
  readonly protocolId = 'anthropic-messages-v1' as const;

  buildRequestUrl(baseURL?: string): string {
    return buildAnthropicMessagesUrl(baseURL);
  }

  buildRequestHeaders(credentials: AdapterCredentials): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': credentials.apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    };
  }

  buildRequestBody(input: AdapterRequestInput): unknown {
    const messages = input.messages.map((m) => unwrapMessage(m));
    const body: Record<string, unknown> = {
      model: input.model,
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      stream: true,
    };
    if (input.tools.length > 0) {
      // Anthropic tool schema shape: { name, description, input_schema }
      body.tools = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }
    if (input.systemPrompt) body.system = input.systemPrompt;
    return body;
  }

  parseStreamEvents(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): AsyncIterable<CatAgentStreamEvent> {
    // Parser already yields neutral CatAgentStreamEvent post-G1 step 4.
    return parseAnthropicSSE(body, signal);
  }

  encodeUserPrompt(prompt: string): AdapterMessage {
    return wrapMessage({ role: 'user', content: prompt });
  }

  encodeAssistantTurn(blocks: ReadonlyArray<CatAgentNeutralBlock>): AdapterMessage {
    const content: AnthropicContentBlock[] = blocks.map(neutralBlockToAnthropic);
    return wrapMessage({ role: 'assistant', content });
  }

  isTerminalStopReason(stopReason: string | null): boolean {
    return stopReason != null && TERMINAL_STOP_REASONS.has(stopReason);
  }

  mapError(err: { status?: number; message?: string }): { errorText: string } {
    // Byte-stable with pre-G1 mapAnthropicError text format
    // (catagent-event-bridge.ts:163) so AC-G10 golden-wire test locks down
    // the user-facing error message shape across the refactor.
    const status = err.status ?? 0;
    const msg = err.message ?? 'Unknown API error';
    return { errorText: `Anthropic API error (${status}): ${msg}` };
  }

  encodeToolResults(results: ReadonlyArray<AdapterToolResult>): AdapterMessage {
    // G1 refactor-only: byte-stable with pre-G1 service code at
    // CatAgentService.ts:231 — only { type, tool_use_id, content } are
    // emitted. AdapterToolResult.status flows through the AgentMessage
    // tool_result event (carried by service into the audit chain via
    // toolResultStatus) but is intentionally NOT mapped into the Anthropic
    // wire transcript here, preserving the exact pre-G1 request body shape
    // that AC-G10 golden-wire test will lock down. Future iterations may
    // surface status as Anthropic `is_error` — that's a behavior change and
    // must go through its own design gate.
    const content: AnthropicToolResultBlock[] = results.map((r) => ({
      type: 'tool_result' as const,
      tool_use_id: r.id,
      content: r.content,
    }));
    return wrapMessage({ role: 'user', content });
  }
}
