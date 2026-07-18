/**
 * OpenAI Chat Adapter — F159 Phase G Slice G2 Axis 5
 *
 * Concrete implementation of {@link CatAgentProtocolAdapter} for OpenAI-style
 * Chat Completions streaming (`POST /v1/chat/completions`, Bearer auth, SSE
 * `data:` frames ending with `[DONE]`).
 *
 * Mirrors the Anthropic adapter's contract layers:
 * - URL / headers / request body
 * - Streaming chunk → neutral events
 * - Transcript codec for assistant turns + tool results
 * - Truthful client family / protocol identifiers
 */

import type {
  AdapterCredentials,
  AdapterRequestInput,
  AdapterToolDefinition,
  AdapterToolResult,
  CatAgentProtocolAdapter,
} from './catagent-protocol-adapter.js';
import type { AdapterMessage, CatAgentNeutralBlock, CatAgentStreamEvent } from './catagent-protocol-types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com';
const DEFAULT_MAX_TOKENS = 4096;
const MAX_TOOL_INPUT_BYTES = 65_536;
const TERMINAL_STOP_REASONS = new Set(['stop', 'length', 'content_filter']);

interface OpenAIChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIChatToolCall[];
  tool_call_id?: string;
}

interface OpenAIChoiceDeltaToolCall {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIStreamContext {
  text: string;
  textSeen: boolean;
  toolCalls: Map<number, OpenAIToolCallAccumulator>;
  sawAnyEvent: boolean;
  sawDone: boolean;
  /** True once any choice carries a non-null finish_reason. */
  sawFinishReason: boolean;
  /** Set when a data frame fails to parse — terminates the stream fail-closed. */
  parseError?: string;
}

interface OpenAIToolCallAccumulator {
  id: string;
  name: string;
  argumentsJson: string;
  argumentBytes: number;
}

function buildOpenAIChatCompletionsUrl(baseURL?: string): string {
  const rawBaseUrl = baseURL?.trim() || DEFAULT_BASE_URL;
  const root = rawBaseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
  return `${root}/v1/chat/completions`;
}

function wrapMessages(payload: OpenAIChatMessage[]): AdapterMessage {
  return { __adapterMessage: true, payload };
}

function unwrapMessages(message: AdapterMessage): OpenAIChatMessage[] {
  return message.payload as OpenAIChatMessage[];
}

function buildToolDefinitions(tools: ReadonlyArray<AdapterToolDefinition>): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function neutralToolCallToOpenAI(block: Extract<CatAgentNeutralBlock, { type: 'tool_call' }>): OpenAIChatToolCall {
  return {
    id: block.id,
    type: 'function',
    function: {
      name: block.name,
      arguments: JSON.stringify(block.input),
    },
  };
}

function finaliseToolCallInput(acc: OpenAIToolCallAccumulator): Record<string, unknown> {
  if (acc.argumentBytes > MAX_TOOL_INPUT_BYTES) return { _error: 'Tool input exceeded size limit' };
  try {
    return JSON.parse(acc.argumentsJson || '{}');
  } catch {
    return { _error: 'Invalid tool input JSON' };
  }
}

async function* parseOpenAIChatStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<CatAgentStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';
  const dataLines: string[] = [];
  const ctx: OpenAIStreamContext = {
    text: '',
    textSeen: false,
    toolCalls: new Map(),
    sawAnyEvent: false,
    sawDone: false,
    sawFinishReason: false,
  };

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
        const maybeEvent = flushDataLine(line, dataLines);
        if (maybeEvent !== undefined) {
          yield* handleOpenAIDataEvent(maybeEvent, ctx);
          // A malformed frame is terminal — do not emit accumulated tool_call blocks.
          if (ctx.parseError) return;
        }
      }
    }

    if (buffer.trim()) {
      const maybeEvent = flushDataLine(buffer, dataLines);
      if (maybeEvent !== undefined) {
        yield* handleOpenAIDataEvent(maybeEvent, ctx);
        if (ctx.parseError) return;
      }
    }
    if (dataLines.length > 0) {
      yield* handleOpenAIDataEvent(dataLines.join('\n'), ctx);
      if (ctx.parseError) return;
    }

    // Fail closed: suppress tool calls if the stream never carried a terminal
    // finish_reason — executing tool_calls from a non-terminal stream is unsafe.
    if (ctx.toolCalls.size > 0 && !ctx.sawFinishReason) {
      yield {
        type: 'stream_error',
        error:
          'Stream ended without finish_reason — suppressed accumulated tool calls to prevent execution from non-terminal stream',
      };
      // Still emit text blocks (safe, no side effects)
      if (ctx.textSeen) {
        yield {
          type: 'content_block_complete',
          block: { type: 'text', text: ctx.text },
          blockIndex: 0,
        };
      }
    } else {
      yield* emitOpenAIContentBlocks(ctx);
    }

    if (ctx.sawAnyEvent && !ctx.sawDone) {
      yield { type: 'stream_error', error: 'Stream ended without [DONE]' };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    yield { type: 'stream_error', error: `Stream read error: ${msg}` };
  } finally {
    reader.releaseLock();
  }
}

function flushDataLine(line: string, dataLines: string[]): string | undefined {
  if (line === '') {
    if (dataLines.length === 0) return undefined;
    const event = dataLines.join('\n');
    dataLines.length = 0;
    return event;
  }
  if (line.startsWith(':')) return undefined;
  if (line.startsWith('data:')) {
    dataLines.push(line.slice(5).trimStart());
  }
  return undefined;
}

function* handleOpenAIDataEvent(eventData: string, ctx: OpenAIStreamContext): Iterable<CatAgentStreamEvent> {
  if (!eventData) return;
  if (eventData === '[DONE]') {
    ctx.sawDone = true;
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(eventData);
  } catch (err) {
    // Fail closed: a malformed frame must not be silently dropped. If it were,
    // a later [DONE] would end the stream "cleanly" and any tool_call accumulated
    // from earlier deltas would be emitted and executed with stopReason === null.
    ctx.parseError = err instanceof Error ? err.message : String(err);
    yield { type: 'stream_error', error: `Malformed OpenAI data frame: ${ctx.parseError}` };
    return;
  }

  ctx.sawAnyEvent = true;

  const usage = parsed.usage as Record<string, unknown> | undefined;
  if (usage) {
    const promptTokensDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    yield {
      type: 'usage_update',
      usage: {
        ...(typeof usage.prompt_tokens === 'number' ? { inputTokens: usage.prompt_tokens } : {}),
        ...(typeof usage.completion_tokens === 'number' ? { outputTokens: usage.completion_tokens } : {}),
        ...(typeof promptTokensDetails?.cached_tokens === 'number'
          ? { cacheReadTokens: promptTokensDetails.cached_tokens as number }
          : {}),
      },
    };
  }

  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  if (!choice) return;

  const delta = choice.delta as Record<string, unknown> | undefined;
  if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
    ctx.textSeen = true;
    ctx.text += delta.content;
    yield { type: 'text_delta', text: delta.content, blockIndex: 0 };
  }

  if (delta && Array.isArray(delta.tool_calls)) {
    for (const entry of delta.tool_calls) {
      if (!entry || typeof entry !== 'object') continue;
      const toolCall = entry as OpenAIChoiceDeltaToolCall;
      const index = typeof toolCall.index === 'number' ? toolCall.index : 0;
      const acc = ctx.toolCalls.get(index) ?? { id: '', name: '', argumentsJson: '', argumentBytes: 0 };
      if (typeof toolCall.id === 'string' && toolCall.id.length > 0) acc.id ||= toolCall.id;
      if (toolCall.function?.name) acc.name += toolCall.function.name;
      if (typeof toolCall.function?.arguments === 'string') {
        acc.argumentBytes += Buffer.byteLength(toolCall.function.arguments);
        if (acc.argumentBytes <= MAX_TOOL_INPUT_BYTES) acc.argumentsJson += toolCall.function.arguments;
      }
      ctx.toolCalls.set(index, acc);
    }
  }

  const finishReason = choice.finish_reason;
  if (finishReason !== undefined && finishReason !== null) {
    ctx.sawFinishReason = true;
    yield { type: 'stop', stopReason: String(finishReason) };
  }
}

function* emitOpenAIContentBlocks(ctx: OpenAIStreamContext): Iterable<CatAgentStreamEvent> {
  let nextIndex = 0;
  if (ctx.textSeen) {
    yield {
      type: 'content_block_complete',
      block: { type: 'text', text: ctx.text },
      blockIndex: nextIndex,
    };
    nextIndex++;
  }
  for (const [index, acc] of [...ctx.toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    // Fail-closed: reject tool calls whose upstream never provided an id.
    // The id is the correlation key echoed back via tool_call_id; fabricating
    // one would let a malformed stream trigger L1/L2 tools (Codex R8 P2).
    if (!acc.id) {
      yield {
        type: 'stream_error',
        error: `Tool call at index ${index} missing upstream id — suppressed to prevent unverified execution`,
      };
      continue;
    }
    yield {
      type: 'content_block_complete',
      block: {
        type: 'tool_call',
        id: acc.id,
        name: acc.name || 'unknown_tool',
        input: finaliseToolCallInput(acc),
      },
      blockIndex: nextIndex + index,
    };
  }
}

export class OpenAIChatAdapter implements CatAgentProtocolAdapter {
  readonly clientFamily = 'openai' as const;
  readonly protocolId = 'openai-chat-v1' as const;

  buildRequestUrl(baseURL?: string): string {
    return buildOpenAIChatCompletionsUrl(baseURL);
  }

  buildRequestHeaders(credentials: AdapterCredentials): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credentials.apiKey}`,
    };
  }

  buildRequestBody(input: AdapterRequestInput): unknown {
    const messages = input.messages.flatMap((message) => unwrapMessages(message));
    const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
    // o-series models (o1, o3, o4-mini, etc.) reject max_tokens in favor of
    // max_completion_tokens. Detect by model name prefix.
    const isOSeries = /^o\d/i.test(input.model);
    const body: Record<string, unknown> = {
      model: input.model,
      ...(isOSeries ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      messages: input.systemPrompt ? [{ role: 'system' as const, content: input.systemPrompt }, ...messages] : messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (input.tools.length > 0) body.tools = buildToolDefinitions(input.tools);
    return body;
  }

  parseStreamEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<CatAgentStreamEvent> {
    return parseOpenAIChatStream(body, signal);
  }

  encodeUserPrompt(prompt: string): AdapterMessage {
    return wrapMessages([{ role: 'user', content: prompt }]);
  }

  encodeAssistantTurn(blocks: ReadonlyArray<CatAgentNeutralBlock>): AdapterMessage {
    const text = blocks
      .filter((block): block is Extract<CatAgentNeutralBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const toolCalls = blocks
      .filter((block): block is Extract<CatAgentNeutralBlock, { type: 'tool_call' }> => block.type === 'tool_call')
      .map((block) => neutralToolCallToOpenAI(block));
    return wrapMessages([
      {
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    ]);
  }

  encodeToolResults(results: ReadonlyArray<AdapterToolResult>): AdapterMessage {
    return wrapMessages(
      results.map((result) => ({
        role: 'tool' as const,
        tool_call_id: result.id,
        content: result.content,
      })),
    );
  }

  mapError(err: { status?: number; message?: string }): { errorText: string } {
    const status = err.status ?? 0;
    const msg = err.message ?? 'Unknown API error';
    return { errorText: `OpenAI API error (${status}): ${msg}` };
  }

  isTerminalStopReason(stopReason: string | null): boolean {
    return stopReason != null && TERMINAL_STOP_REASONS.has(stopReason);
  }
}
