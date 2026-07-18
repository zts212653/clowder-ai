/**
 * CatAgent SSE Stream Parser — F159 Phase E (G1: now yields neutral events)
 *
 * Parses Anthropic Messages API SSE stream into protocol-neutral
 * `CatAgentStreamEvent`s. Anthropic-shaped types (`AnthropicContentBlock`,
 * `AnthropicUsage`) stay strictly inside this file as Anthropic-specific
 * intermediate types; the parser maps them to neutral
 * `CatAgentNeutralBlock` / `CatAgentUsageDelta` before yielding.
 *
 * G1 design note: This file is logically a private implementation detail of
 * `AnthropicMessagesAdapter` — but is kept at this path to minimise rename
 * churn during the refactor. The grep verifier (AC-G12) treats this file as
 * adapter-owned, not service-layer, so `Anthropic*` imports here are
 * expected and allowed.
 *
 * Handles proper SSE framing (multi-line data, CRLF, comments, event:error).
 * No @anthropic-ai/sdk dependency — raw fetch + TextDecoder.
 */

import type { AnthropicContentBlock, AnthropicUsage } from './catagent-event-bridge.js';
import { mapAnthropicUsage } from './catagent-event-bridge.js';
import type { CatAgentNeutralBlock, CatAgentStreamEvent, CatAgentUsageDelta } from './catagent-protocol-types.js';

const MAX_TOOL_INPUT_BYTES = 65_536;

// ── Neutral block / usage normalisation (Anthropic → neutral, adapter-private) ──

function anthropicBlockToNeutral(block: AnthropicContentBlock): CatAgentNeutralBlock {
  if (block.type === 'text') return { type: 'text', text: block.text };
  // block.type === 'tool_use'
  return { type: 'tool_call', id: block.id, name: block.name, input: block.input };
}

function anthropicInputUsageToNeutral(usage: AnthropicUsage): CatAgentUsageDelta {
  // Reuse mapAnthropicUsage to keep the cache-aware totalInput convention
  // (raw + cache_read + cache_creation) — single source of truth for
  // Anthropic prompt-cache observability normalisation.
  const tokenUsage = mapAnthropicUsage(usage);
  const delta: CatAgentUsageDelta = { inputTokens: tokenUsage.inputTokens };
  if (tokenUsage.cacheReadTokens !== undefined) delta.cacheReadTokens = tokenUsage.cacheReadTokens;
  if (tokenUsage.cacheCreationTokens !== undefined) delta.cacheCreationTokens = tokenUsage.cacheCreationTokens;
  return delta;
}

// ── SSE line parser state ──

interface SSEParserState {
  eventType: string;
  dataLines: string[];
}

// ── Content block accumulator ──

interface BlockAccumulator {
  index: number;
  type: 'text' | 'tool_use';
  text: string;
  toolId: string;
  toolName: string;
  toolInputJson: string;
  toolInputBytes: number;
}

/** Mutable context shared between the main loop and event handlers. */
interface StreamContext {
  blocks: Map<number, BlockAccumulator>;
  sawMessageStop: boolean;
  sawAnyEvent: boolean;
  /** Set when a data frame fails to parse — terminates the stream fail-closed. */
  parseError?: string;
}

/** Parse an Anthropic SSE stream into CatAgentStreamEvents. */
export async function* parseAnthropicSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<CatAgentStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';
  const sseState: SSEParserState = { eventType: '', dataLines: [] };
  const ctx: StreamContext = { blocks: new Map(), sawMessageStop: false, sawAnyEvent: false };

  try {
    while (true) {
      if (signal?.aborted) {
        yield { type: 'stream_error', error: 'Request aborted' };
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        yield* processAndHandle(line, sseState, ctx);
        if (ctx.parseError) break;
      }
      if (ctx.parseError) break;
    }
    if (!ctx.parseError && buffer.trim()) yield* processAndHandle(buffer, sseState, ctx);
    if (!ctx.parseError) {
      const final = flushSSEState(sseState);
      if (final) yield* handleSSEEvent(final, ctx);
    }

    // P1: EOF must be message_stop with no unclosed blocks (check specific first)
    if (ctx.blocks.size > 0) {
      yield { type: 'stream_error', error: `Stream ended with ${ctx.blocks.size} unclosed content block(s)` };
    } else if (ctx.sawAnyEvent && !ctx.sawMessageStop) {
      yield { type: 'stream_error', error: 'Stream ended without message_stop' };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    yield { type: 'stream_error', error: `Stream read error: ${msg}` };
  } finally {
    reader.releaseLock();
  }
}

function* processAndHandle(line: string, sseState: SSEParserState, ctx: StreamContext): Iterable<CatAgentStreamEvent> {
  for (const evt of processSSELine(line, sseState)) {
    yield* handleSSEEvent(evt, ctx);
  }
}

// ── SSE line processing ──

interface ParsedSSEEvent {
  type: string;
  data: string;
}

function processSSELine(line: string, state: SSEParserState): ParsedSSEEvent[] {
  const results: ParsedSSEEvent[] = [];

  if (line === '') {
    // Empty line = event boundary
    const evt = flushSSEState(state);
    if (evt) results.push(evt);
    return results;
  }
  if (line.startsWith(':')) return results; // Comment/ping
  if (line.startsWith('event:')) {
    state.eventType = line.slice(6).trim();
  } else if (line.startsWith('data:')) {
    state.dataLines.push(line.slice(5).trimStart());
  }
  return results;
}

function flushSSEState(state: SSEParserState): ParsedSSEEvent | null {
  if (state.dataLines.length === 0) {
    state.eventType = '';
    return null;
  }
  const evt: ParsedSSEEvent = {
    type: state.eventType || 'message',
    data: state.dataLines.join('\n'),
  };
  state.eventType = '';
  state.dataLines = [];
  return evt;
}

// ── SSE event → CatAgentStreamEvent mapping ──

function* handleSSEEvent(evt: ParsedSSEEvent, ctx: StreamContext): Iterable<CatAgentStreamEvent> {
  if (evt.type === 'error') {
    yield { type: 'stream_error', error: evt.data };
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(evt.data);
  } catch (err) {
    // Fail closed: a malformed frame must not be silently dropped. If it were,
    // a later message_stop would end the stream "cleanly" and any tool_use blocks
    // accumulated from earlier deltas would be emitted and executed.
    ctx.parseError = err instanceof Error ? err.message : String(err);
    yield { type: 'stream_error', error: `Malformed Anthropic data frame: ${ctx.parseError}` };
    return;
  }

  ctx.sawAnyEvent = true;
  const eventType = parsed.type as string;

  if (eventType === 'message_start') {
    const message = parsed.message as Record<string, unknown> | undefined;
    const usage = message?.usage as AnthropicUsage | undefined;
    if (usage) yield { type: 'usage_update', usage: anthropicInputUsageToNeutral(usage) };
    return;
  }

  if (eventType === 'content_block_start') {
    const index = parsed.index as number;
    const cb = parsed.content_block as Record<string, unknown>;
    ctx.blocks.set(index, {
      index,
      type: cb?.type === 'tool_use' ? 'tool_use' : 'text',
      text: '',
      toolId: (cb?.id as string) ?? '',
      toolName: (cb?.name as string) ?? '',
      toolInputJson: '',
      toolInputBytes: 0,
    });
    return;
  }

  if (eventType === 'content_block_delta') {
    const index = parsed.index as number;
    const delta = parsed.delta as Record<string, unknown>;
    const block = ctx.blocks.get(index);
    if (!block) return;

    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      block.text += delta.text;
      yield { type: 'text_delta', text: delta.text, blockIndex: index };
    } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      const chunk = delta.partial_json;
      block.toolInputBytes += Buffer.byteLength(chunk);
      if (block.toolInputBytes <= MAX_TOOL_INPUT_BYTES) {
        block.toolInputJson += chunk;
      }
    }
    return;
  }

  if (eventType === 'content_block_stop') {
    const index = parsed.index as number;
    const block = ctx.blocks.get(index);
    if (!block) return;
    ctx.blocks.delete(index);

    if (block.type === 'text') {
      yield {
        type: 'content_block_complete',
        block: anthropicBlockToNeutral({ type: 'text', text: block.text }),
        blockIndex: index,
      };
    } else {
      let input: Record<string, unknown> = {};
      if (block.toolInputBytes > MAX_TOOL_INPUT_BYTES) {
        input = { _error: 'Tool input exceeded size limit' };
      } else {
        try {
          input = JSON.parse(block.toolInputJson || '{}');
        } catch {
          input = { _error: 'Invalid tool input JSON' };
        }
      }
      // Fail-closed: reject tool_use blocks whose upstream never provided an id.
      // Parity with OpenAI adapter's missing-id guard (Codex R9 P2).
      if (!block.toolId) {
        yield {
          type: 'stream_error',
          error: `Anthropic tool_use block at index ${index} missing upstream id — suppressed to prevent unverified execution`,
        };
      } else {
        yield {
          type: 'content_block_complete',
          block: anthropicBlockToNeutral({ type: 'tool_use', id: block.toolId, name: block.toolName, input }),
          blockIndex: index,
        };
      }
    }
    return;
  }

  if (eventType === 'message_delta') {
    const delta = parsed.delta as Record<string, unknown> | undefined;
    const usage = parsed.usage as Record<string, unknown> | undefined;
    const outputTokens = usage?.output_tokens as number | undefined;
    if (outputTokens !== undefined) yield { type: 'usage_update', usage: { outputTokens } };
    const stopReason = delta?.stop_reason as string | null | undefined;
    if (stopReason !== undefined) yield { type: 'stop', stopReason };
    return;
  }

  if (eventType === 'message_stop') {
    ctx.sawMessageStop = true;
    return;
  }
}
