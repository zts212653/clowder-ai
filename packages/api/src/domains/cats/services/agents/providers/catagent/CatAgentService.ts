/**
 * CatAgent Native Provider — F159 Phase D: Read-Only Tools + Agentic Loop
 *
 * Calls Anthropic Messages API directly (no CLI subprocess).
 * Uses raw fetch — no @anthropic-ai/sdk dependency.
 *
 * Phase D adds: read_file / list_files / search_content tools + multi-turn loop.
 * Loop terminates on terminal stop_reason or MAX_TOOL_TURNS.
 * tool_use / tool_result events are yielded to upstream audit chain.
 */

import type { CatConfig, CatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata, TokenUsage } from '../../../types.js';
import { mergeTokenUsage } from '../../../types.js';
import { resolveApiCredentials } from './catagent-credentials.js';
import type { AnthropicMessageResponse, AnthropicToolUseBlock } from './catagent-event-bridge.js';
import { mapAnthropicError, mapAnthropicResponse, mapAnthropicUsage } from './catagent-event-bridge.js';
import { buildToolRegistry, findTool, getToolSchemas } from './catagent-read-tools.js';
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
      log.error(`[${this.catId}] Model resolution failed — no model configured`);
      yield* emitError('Model resolution failed — no configured model', this.catId, 'unknown', now);
      return;
    }

    const credentials = resolveApiCredentials(this.projectRoot, this.catId as string, this.catConfig);
    if (!credentials) {
      log.error(`[${this.catId}] Credential resolution failed — cannot invoke`);
      yield* emitError('Credential resolution failed — no bound account', this.catId, model, now);
      return;
    }

    const sessionId = `catagent-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const metadata: MessageMetadata = { provider: 'catagent', model, sessionId };
    yield { type: 'session_init', catId: this.catId, sessionId, metadata, timestamp: now };

    yield* this.callApi(prompt, model, metadata, credentials, options);
  }

  /** Agentic loop: call API → yield events → execute tools → repeat until terminal. */
  private async *callApi(
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
      let response: AnthropicMessageResponse;
      try {
        response = await this.callApiOnce(messages, toolSchemas, model, credentials, options);
      } catch (err: unknown) {
        yield* this.handleFetchError(err, metadata, model, totalUsage);
        return;
      }

      totalUsage = mergeTokenUsage(totalUsage, mapAnthropicUsage(response.usage));
      const mapped = mapAnthropicResponse(response, this.catId, 'catagent');

      yield* this.yieldEvents(mapped, metadata, totalUsage);
      if (mapped.some((m) => m.type === 'done')) return;

      // Non-terminal: execute tool calls and build next turn
      const toolBlocks = response.content.filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use');
      if (toolBlocks.length === 0) {
        const reason = response.stop_reason ?? 'unknown';
        log.warn(`[${this.catId}] Non-terminal stop_reason "${reason}" with no tool calls`);
        yield {
          type: 'error',
          catId: this.catId,
          error: `Unexpected non-terminal response (stop_reason: ${reason}) with no tool calls`,
          metadata,
          timestamp: Date.now(),
        };
        yield {
          type: 'done',
          catId: this.catId,
          metadata: { ...metadata, usage: totalUsage ?? { inputTokens: 0, outputTokens: 0 } },
          timestamp: Date.now(),
        };
        return;
      }

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
      messages.push({ role: 'assistant', content: response.content });
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
    yield {
      type: 'done',
      catId: this.catId,
      metadata: { ...metadata, usage: totalUsage ?? { inputTokens: 0, outputTokens: 0 } },
      timestamp: Date.now(),
    };
  }

  private async callApiOnce(
    messages: Array<{ role: string; content: unknown }>,
    tools: Array<{ name: string; description: string; input_schema: unknown }>,
    model: string,
    credentials: { apiKey: string; baseURL?: string },
    options?: AgentServiceOptions,
  ): Promise<AnthropicMessageResponse> {
    const url = `${(credentials.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/messages`;
    const body: Record<string, unknown> = { model, max_tokens: DEFAULT_MAX_TOKENS, messages };
    if (tools.length > 0) body.tools = tools;
    if (options?.systemPrompt) body.system = options.systemPrompt;

    log.info(`[${this.catId}] API call: model=${model}, turns=${messages.length}`);
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
    return (await resp.json()) as AnthropicMessageResponse;
  }

  /** Yield mapped events, fixing done's usage to accumulated total. */
  private *yieldEvents(
    mapped: AgentMessage[],
    metadata: MessageMetadata,
    totalUsage: TokenUsage | undefined,
  ): Iterable<AgentMessage> {
    for (const msg of mapped) {
      const merged = { ...metadata, ...msg.metadata };
      yield { ...msg, metadata: msg.type === 'done' ? { ...merged, usage: totalUsage } : merged };
    }
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
      yield {
        type: 'done',
        catId: this.catId,
        metadata: { ...metadata, usage: totalUsage ?? { inputTokens: 0, outputTokens: 0 } },
        timestamp: Date.now(),
      };
      return;
    }
    const httpStatus = (err as { httpStatus?: number }).httpStatus;
    const message = err instanceof Error ? err.message : String(err);
    const status = httpStatus ?? 0;
    if (httpStatus) {
      log.warn(`[${this.catId}] API error ${httpStatus}: ${message.slice(0, 200)}`);
    } else {
      log.error(`[${this.catId}] Unexpected error: ${message}`);
    }
    for (const msg of mapAnthropicError({ status, message }, this.catId, 'catagent', model)) {
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
