/**
 * CatAgent Native Provider — F159 Phase E: SSE Streaming + Agentic Loop
 *
 * Calls Anthropic Messages API directly with SSE streaming.
 * Phase E adds: per-token text streaming, streaming tool collection,
 * proper EOF validation. Strict streaming fail-closed — no non-streaming fallback.
 */

import type { CatConfig, CatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata, TokenUsage } from '../../../types.js';
import { mergeTokenUsage } from '../../../types.js';
import { resolveApiCredentials } from './catagent-credentials.js';
import type { AnthropicContentBlock, AnthropicToolUseBlock } from './catagent-event-bridge.js';
import { mapAnthropicError, mapAnthropicUsage, TERMINAL_STOP_REASONS } from './catagent-event-bridge.js';
import { buildToolRegistry, findTool, getToolSchemas } from './catagent-read-tools.js';
import type { CatAgentStreamEvent } from './catagent-stream-parser.js';
import { parseAnthropicSSE } from './catagent-stream-parser.js';
import { validateToolInput } from './catagent-tool-guard.js';
import type { CatAgentTool } from './catagent-tools.js';

const log = createModuleLogger('catagent');

const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 4096;
const MAX_TOOL_TURNS = 15;
const TOOL_RESULT_DIGEST_LIMIT = 500;

interface CatAgentServiceOptions {
  catId: CatId;
  projectRoot: string;
  catConfig: CatConfig | null;
}

/** Per-turn result accumulated from stream events. */
interface TurnResult {
  contentBlocks: AnthropicContentBlock[];
  stopReason: string | null;
  turnUsage: TokenUsage;
  hadStreamError: boolean;
}

export class CatAgentService implements AgentService {
  readonly catId: CatId;
  private readonly projectRoot: string;
  private readonly catConfig: CatConfig | null;

  constructor(options: CatAgentServiceOptions) {
    this.catId = options.catId;
    this.projectRoot = options.projectRoot;
    this.catConfig = options.catConfig;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const now = Date.now();
    let model: string;
    try {
      model = getCatModel(this.catId as string);
    } catch {
      yield* emitError('Model resolution failed — no configured model', this.catId, 'unknown', now);
      return;
    }
    const credentials = resolveApiCredentials(this.projectRoot, this.catId as string, this.catConfig);
    if (!credentials) {
      yield* emitError('Credential resolution failed — no bound account', this.catId, model, now);
      return;
    }
    const sessionId = `catagent-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const metadata: MessageMetadata = { provider: 'catagent', model, sessionId };
    yield { type: 'session_init', catId: this.catId, sessionId, metadata, timestamp: now };
    yield* this.agenticLoop(prompt, model, metadata, credentials, options);
  }

  /** Agentic loop: stream API → yield text deltas → execute tools → repeat. */
  private async *agenticLoop(
    prompt: string,
    model: string,
    metadata: MessageMetadata,
    credentials: { apiKey: string; baseURL?: string },
    options?: AgentServiceOptions,
  ): AsyncIterable<AgentMessage> {
    const workDir = options?.workingDirectory;
    const tools = workDir ? await buildToolRegistry(workDir) : [];
    const toolSchemas = getToolSchemas(tools);
    const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: prompt }];
    let totalUsage: TokenUsage | undefined;

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      let resp: Response;
      try {
        resp = await this.fetchApi(messages, toolSchemas, model, credentials, options);
      } catch (err: unknown) {
        yield* this.handleFetchError(err, metadata, model, totalUsage);
        return;
      }

      const result = yield* this.consumeTurn(resp, metadata, options?.signal);
      totalUsage = mergeTokenUsage(totalUsage, result.turnUsage);

      if (result.hadStreamError) {
        const orphanTools = result.contentBlocks.filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use');
        for (const t of orphanTools) {
          yield {
            type: 'tool_result',
            catId: this.catId,
            content: 'Error: stream interrupted before tool execution',
            toolName: t.name,
            metadata,
            timestamp: Date.now(),
          };
        }
        yield* emitDone(this.catId, metadata, totalUsage);
        return;
      }

      const isTerminal = result.stopReason != null && TERMINAL_STOP_REASONS.has(result.stopReason);
      if (isTerminal) {
        yield { type: 'done', catId: this.catId, metadata: { ...metadata, usage: totalUsage }, timestamp: Date.now() };
        return;
      }

      const toolBlocks = result.contentBlocks.filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use');
      if (toolBlocks.length === 0) {
        const reason = result.stopReason ?? 'unknown';
        log.warn(`[${this.catId}] Non-terminal stop_reason "${reason}" with no tool calls`);
        yield {
          type: 'error',
          catId: this.catId,
          error: `Unexpected non-terminal response (stop_reason: ${reason}) with no tool calls`,
          metadata,
          timestamp: Date.now(),
        };
        yield* emitDone(this.catId, metadata, totalUsage);
        return;
      }

      // Execute tools and build next turn
      const toolResults = await this.executeTools(toolBlocks, tools, metadata);
      for (const r of toolResults) {
        yield {
          type: 'tool_result',
          catId: this.catId,
          content: r.content.slice(0, TOOL_RESULT_DIGEST_LIMIT),
          toolName: r.name,
          metadata,
          timestamp: Date.now(),
        };
      }
      messages.push({ role: 'assistant', content: result.contentBlocks });
      messages.push({
        role: 'user',
        content: toolResults.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })),
      });
    }

    log.warn(`[${this.catId}] Tool loop exceeded ${MAX_TOOL_TURNS} turns`);
    yield {
      type: 'error',
      catId: this.catId,
      error: `Tool loop exceeded ${MAX_TOOL_TURNS} turns`,
      metadata,
      timestamp: Date.now(),
    };
    yield* emitDone(this.catId, metadata, totalUsage);
  }

  /** Consume one streaming turn, yielding text deltas and tool_use events. */
  private async *consumeTurn(
    resp: Response,
    metadata: MessageMetadata,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentMessage, TurnResult> {
    const contentBlocks: AnthropicContentBlock[] = [];
    const blocksByIndex = new Map<number, AnthropicContentBlock>();
    let stopReason: string | null = null;
    let inputUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let outputTokens = 0;
    let hadStreamError = false;

    if (!resp.body) {
      yield { type: 'error', catId: this.catId, error: 'Response has no body', metadata, timestamp: Date.now() };
      return { contentBlocks, stopReason, turnUsage: inputUsage, hadStreamError: true };
    }

    for await (const evt of parseAnthropicSSE(resp.body, signal)) {
      yield* this.mapStreamEvent(evt, metadata, blocksByIndex);

      if (evt.type === 'usage_update') {
        if (evt.inputUsage) inputUsage = mapAnthropicUsage(evt.inputUsage);
        if (evt.outputTokens !== undefined) outputTokens = evt.outputTokens;
      } else if (evt.type === 'stop') {
        stopReason = evt.stopReason;
      } else if (evt.type === 'stream_error') {
        hadStreamError = true;
      }
    }

    // Rebuild content blocks sorted by index (P1: preserve full assistant content)
    const sortedIndices = [...blocksByIndex.keys()].sort((a, b) => a - b);
    for (const idx of sortedIndices) contentBlocks.push(blocksByIndex.get(idx)!);

    const turnUsage: TokenUsage = { ...inputUsage, outputTokens };
    return { contentBlocks, stopReason, turnUsage, hadStreamError };
  }

  /** Map a single stream event to AgentMessage(s). */
  private *mapStreamEvent(
    evt: CatAgentStreamEvent,
    metadata: MessageMetadata,
    blocksByIndex: Map<number, AnthropicContentBlock>,
  ): Iterable<AgentMessage> {
    if (evt.type === 'text_delta') {
      yield { type: 'text', catId: this.catId, content: evt.text, metadata, timestamp: Date.now() };
    } else if (evt.type === 'content_block_complete') {
      blocksByIndex.set(evt.blockIndex, evt.block);
      if (evt.block.type === 'tool_use') {
        yield {
          type: 'tool_use',
          catId: this.catId,
          toolName: evt.block.name,
          toolInput: evt.block.input,
          metadata,
          timestamp: Date.now(),
        };
      }
    } else if (evt.type === 'stream_error') {
      yield { type: 'error', catId: this.catId, error: evt.error, metadata, timestamp: Date.now() };
    }
  }

  private async fetchApi(
    messages: Array<{ role: string; content: unknown }>,
    tools: Array<{ name: string; description: string; input_schema: unknown }>,
    model: string,
    credentials: { apiKey: string; baseURL?: string },
    options?: AgentServiceOptions,
  ): Promise<Response> {
    const url = `${(credentials.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/messages`;
    const body: Record<string, unknown> = { model, max_tokens: DEFAULT_MAX_TOKENS, messages, stream: true };
    if (tools.length > 0) body.tools = tools;
    if (options?.systemPrompt) body.system = options.systemPrompt;

    log.info(`[${this.catId}] API call: model=${model}, turns=${messages.length}, stream=true`);
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': credentials.apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => 'unknown error');
      throw Object.assign(new Error(text), { httpStatus: resp.status });
    }
    return resp;
  }

  private async executeTools(
    blocks: AnthropicToolUseBlock[],
    tools: CatAgentTool[],
    _metadata: MessageMetadata,
  ): Promise<Array<{ id: string; name: string; content: string }>> {
    const results: Array<{ id: string; name: string; content: string }> = [];
    for (const block of blocks) {
      const tool = findTool(tools, block.name);
      if (!tool) {
        results.push({ id: block.id, name: block.name, content: `Error: unknown tool "${block.name}"` });
        continue;
      }
      try {
        validateToolInput(tool.schema, block.input);
        const output = await tool.execute(block.input);
        results.push({ id: block.id, name: block.name, content: output });
      } catch (err: unknown) {
        results.push({
          id: block.id,
          name: block.name,
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return results;
  }

  private *handleFetchError(
    err: unknown,
    metadata: MessageMetadata,
    model: string,
    totalUsage: TokenUsage | undefined,
  ): Iterable<AgentMessage> {
    if (err instanceof DOMException && err.name === 'AbortError') {
      log.info(`[${this.catId}] Request aborted`);
      yield { type: 'error', catId: this.catId, error: 'Request aborted', metadata, timestamp: Date.now() };
      yield* emitDone(this.catId, metadata, totalUsage);
      return;
    }
    const httpStatus = (err as { httpStatus?: number }).httpStatus;
    const message = err instanceof Error ? err.message : String(err);
    if (httpStatus) {
      log.warn(`[${this.catId}] API error ${httpStatus}: ${message.slice(0, 200)}`);
    } else {
      log.error(`[${this.catId}] Unexpected error: ${message}`);
    }
    for (const msg of mapAnthropicError({ status: httpStatus ?? 0, message }, this.catId, 'catagent', model)) {
      const usage = totalUsage ?? msg.metadata?.usage;
      yield { ...msg, metadata: { ...metadata, ...msg.metadata, usage } };
    }
  }
}

function emitError(message: string, catId: CatId, model: string, timestamp: number): AgentMessage[] {
  const metadata: MessageMetadata = { provider: 'catagent', model };
  return [
    { type: 'error', catId, error: message, metadata, timestamp },
    { type: 'done', catId, metadata: { ...metadata, usage: { inputTokens: 0, outputTokens: 0 } }, timestamp },
  ];
}

function* emitDone(
  catId: CatId,
  metadata: MessageMetadata,
  totalUsage: TokenUsage | undefined,
): Iterable<AgentMessage> {
  yield {
    type: 'done',
    catId,
    metadata: { ...metadata, usage: totalUsage ?? { inputTokens: 0, outputTokens: 0 } },
    timestamp: Date.now(),
  };
}
