/**
 * CatAgent Native Provider — F159 Phase E (G1: vendor-neutral adapter seam)
 *
 * Generic "cat-as-an-agent" native provider. Protocol-specific wire shape
 * (URL, headers, body, stream events, transcript codec, error formatting,
 * terminal-stop classification) is delegated to a {@link CatAgentProtocolAdapter}
 * obtained from {@link createCatAgentProtocolAdapter}. This file is intended
 * to be vendor-neutral: AC-G12 grep verifier asserts no `Anthropic*`
 * identifier appears here (imports, types, helper names, or local aliases).
 *
 * Pre-G1 (Phase E) this file directly called `parseAnthropicSSE`, held
 * `AnthropicContentBlock[]` turn state, and pushed `{ role: 'assistant',
 * content }` / `{ role: 'user', content: tool_result[] }` messages — see
 * F159 Phase G spec for the design gate that drove the refactor.
 */

import type { CatConfig, CatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import { AuditEventTypes, getEventAuditLog } from '../../../orchestration/EventAuditLog.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata, TokenUsage } from '../../../types.js';
import { mergeTokenUsage } from '../../../types.js';
import { resolveApiCredentials } from './catagent-credentials.js';
import type { CatAgentProtocolAdapter } from './catagent-protocol-adapter.js';
import { createCatAgentProtocolAdapter } from './catagent-protocol-factory.js';
import type {
  AdapterMessage,
  CatAgentNeutralBlock,
  CatAgentStreamEvent,
  CatAgentToolCallBlock,
} from './catagent-protocol-types.js';
import { buildToolRegistry, findTool, getToolSchemas } from './catagent-read-tools.js';
import { validateToolInput } from './catagent-tool-guard.js';
import type {
  CatAgentTool,
  CatAgentToolAuditEvent,
  CatAgentToolAuditSink,
  CatAgentToolRegistryOptions,
} from './catagent-tools.js';

const log = createModuleLogger('catagent');

const MAX_TOOL_TURNS = 15;
const TOOL_RESULT_DIGEST_LIMIT = 500;

interface CatAgentServiceOptions {
  catId: CatId;
  projectRoot: string;
  catConfig: CatConfig | null;
}

/** Per-turn result accumulated from stream events. */
interface TurnResult {
  contentBlocks: CatAgentNeutralBlock[];
  stopReason: string | null;
  isTerminal: boolean;
  turnUsage: TokenUsage;
  hadStreamError: boolean;
}

/**
 * F153 Phase J AC-J2 (R1 P2 fix): structured tool execution outcome.
 * `status` is set from the execution-edge branch, NOT from content-string
 * heuristics — so a successful tool legitimately returning "Error: 200 OK"
 * style content does not get mis-marked as `error` (KD-38 honesty).
 */
export interface CatAgentToolExecResult {
  id: string;
  name: string;
  content: string;
  status: 'ok' | 'error';
}

/**
 * Execute neutral tool_call blocks against the local tool registry.
 * (G1: signature changed from `AnthropicToolUseBlock[]` to neutral
 * `ReadonlyArray<CatAgentToolCallBlock>`; field reads are identical because
 * the neutral block carries the same `id` / `name` / `input` triple.)
 *
 * Exported (vs the previous private method) so unit tests can verify the
 * status mapping without standing up the full streaming HTTP pipeline.
 *
 * Branches:
 * - unknown tool → `status: 'error'`, content prefixed with "Error: unknown tool"
 * - successful execution → `status: 'ok'` regardless of returned text content
 * - thrown error (schema validation, tool.execute reject) → `status: 'error'`
 */
export async function executeCatAgentTools(
  blocks: ReadonlyArray<CatAgentToolCallBlock>,
  tools: CatAgentTool[],
): Promise<CatAgentToolExecResult[]> {
  const results: CatAgentToolExecResult[] = [];
  for (const block of blocks) {
    const tool = findTool(tools, block.name);
    if (!tool) {
      results.push({
        id: block.id,
        name: block.name,
        content: `Error: unknown tool "${block.name}"`,
        status: 'error',
      });
      continue;
    }
    try {
      validateToolInput(tool.schema, block.input);
      const output = await tool.execute(block.input);
      // Status comes from the execution edge (no exception thrown), not from
      // content inspection — a tool may legitimately return text starting
      // with "Error:" (e.g. log/file content).
      results.push({ id: block.id, name: block.name, content: output, status: 'ok' });
    } catch (err: unknown) {
      results.push({
        id: block.id,
        name: block.name,
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        status: 'error',
      });
    }
  }
  return results;
}

export class CatAgentService implements AgentService {
  readonly catId: CatId;
  private readonly projectRoot: string;
  private readonly catConfig: CatConfig | null;
  private readonly adapter: CatAgentProtocolAdapter;

  constructor(options: CatAgentServiceOptions) {
    this.catId = options.catId;
    this.projectRoot = options.projectRoot;
    this.catConfig = options.catConfig;
    // G1: protocol adapter is the single source of truth for vendor-specific
    // wire shape; service never instantiates AnthropicMessagesAdapter directly
    // (AC-G12 grep verifier asserts service contains no `new
    // AnthropicMessagesAdapter` call).
    this.adapter = createCatAgentProtocolAdapter(options.catConfig);
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
    // G1: credentials resolution now keyed on adapter.clientFamily so future
    // OpenAI / Gemini adapters select their own profile family.
    const credentials = resolveApiCredentials(
      this.projectRoot,
      this.catId as string,
      this.catConfig,
      this.adapter.clientFamily,
    );
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
    const tools = await buildToolRegistry(workDir, this.createToolRegistryOptions(options));
    const toolSchemas = getToolSchemas(tools);
    // G1: messages held as opaque AdapterMessage; service never destructures.
    // Initial user prompt + per-turn assistant blocks + per-turn tool results
    // are all encoded by the adapter (replaces pre-G1 service-side `{ role,
    // content }` construction at CatAgentService.ts:157/229/231).
    const messages: AdapterMessage[] = [this.adapter.encodeUserPrompt(prompt)];
    let totalUsage: TokenUsage | undefined;

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      let resp: Response;
      try {
        resp = await this.fetchApi(messages, toolSchemas, model, credentials, options);
      } catch (err: unknown) {
        yield* this.handleFetchError(err, metadata, totalUsage);
        return;
      }

      const result = yield* this.consumeTurn(resp, metadata, options?.signal);
      totalUsage = mergeTokenUsage(totalUsage, result.turnUsage);

      if (result.hadStreamError) {
        const orphanTools = result.contentBlocks.filter((b): b is CatAgentToolCallBlock => b.type === 'tool_call');
        for (const t of orphanTools) {
          // F153 Phase J AC-J2: carry native tool_use_id + structured error status.
          yield {
            type: 'tool_result',
            catId: this.catId,
            content: 'Error: stream interrupted before tool execution',
            toolName: t.name,
            toolUseId: t.id,
            toolResultStatus: 'error',
            metadata,
            timestamp: Date.now(),
          };
        }
        yield* emitDone(this.catId, metadata, totalUsage);
        return;
      }

      if (result.isTerminal) {
        yield { type: 'done', catId: this.catId, metadata: { ...metadata, usage: totalUsage }, timestamp: Date.now() };
        return;
      }

      const toolBlocks = result.contentBlocks.filter((b): b is CatAgentToolCallBlock => b.type === 'tool_call');
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
        // F153 Phase J AC-J2 (R1 P2 fix): status comes from executeTools execution
        // edge — not from content inspection. A tool legitimately returning text
        // starting with "Error:" is still `ok` per KD-38 honesty.
        yield {
          type: 'tool_result',
          catId: this.catId,
          content: r.content.slice(0, TOOL_RESULT_DIGEST_LIMIT),
          toolName: r.name,
          toolUseId: r.id,
          toolResultStatus: r.status,
          metadata,
          timestamp: Date.now(),
        };
      }
      // G1: assistant turn + tool results encoded by adapter — replaces pre-G1
      // direct push of `{ role: 'assistant', content: contentBlocks }` and
      // `{ role: 'user', content: tool_result[] }` (the Anthropic shape leak
      // @gpt555 flagged at CatAgentService.ts:229-233 during design gate).
      messages.push(this.adapter.encodeAssistantTurn(result.contentBlocks));
      messages.push(this.adapter.encodeToolResults(toolResults));
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

  /** Consume one streaming turn, yielding text deltas and tool_call events. */
  private async *consumeTurn(
    resp: Response,
    metadata: MessageMetadata,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentMessage, TurnResult> {
    const contentBlocks: CatAgentNeutralBlock[] = [];
    const blocksByIndex = new Map<number, CatAgentNeutralBlock>();
    let stopReason: string | null = null;
    // G1: turn usage merged directly from neutral CatAgentUsageDelta events.
    // No more `mapAnthropicUsage(evt.inputUsage)` call from service — the
    // adapter has already normalised the input usage upstream (parser).
    const turnUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let hadStreamError = false;

    if (!resp.body) {
      yield { type: 'error', catId: this.catId, error: 'Response has no body', metadata, timestamp: Date.now() };
      return { contentBlocks, stopReason, isTerminal: false, turnUsage, hadStreamError: true };
    }

    for await (const evt of this.adapter.parseStreamEvents(resp.body, signal)) {
      yield* this.mapStreamEvent(evt, metadata, blocksByIndex);

      if (evt.type === 'usage_update') {
        if (evt.usage.inputTokens !== undefined) turnUsage.inputTokens = evt.usage.inputTokens;
        if (evt.usage.outputTokens !== undefined) turnUsage.outputTokens = evt.usage.outputTokens;
        if (evt.usage.cacheReadTokens !== undefined) turnUsage.cacheReadTokens = evt.usage.cacheReadTokens;
        if (evt.usage.cacheCreationTokens !== undefined) turnUsage.cacheCreationTokens = evt.usage.cacheCreationTokens;
      } else if (evt.type === 'stop') {
        stopReason = evt.stopReason;
      } else if (evt.type === 'stream_error') {
        hadStreamError = true;
      }
    }

    // Rebuild content blocks sorted by index (P1: preserve full assistant content)
    const sortedIndices = [...blocksByIndex.keys()].sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      const block = blocksByIndex.get(idx);
      if (block) contentBlocks.push(block);
    }

    // G1: terminal classification deferred to adapter (replaces pre-G1 direct
    // service-side `TERMINAL_STOP_REASONS.has(...)` consult — that whitelist
    // was Anthropic-specific and leaked the vendor's terminal set into
    // generic loop logic).
    const isTerminal = this.adapter.isTerminalStopReason(stopReason);
    return { contentBlocks, stopReason, isTerminal, turnUsage, hadStreamError };
  }

  /** Map a single neutral stream event to AgentMessage(s). */
  private *mapStreamEvent(
    evt: CatAgentStreamEvent,
    metadata: MessageMetadata,
    blocksByIndex: Map<number, CatAgentNeutralBlock>,
  ): Iterable<AgentMessage> {
    if (evt.type === 'text_delta') {
      yield { type: 'text', catId: this.catId, content: evt.text, metadata, timestamp: Date.now() };
    } else if (evt.type === 'content_block_complete') {
      blocksByIndex.set(evt.blockIndex, evt.block);
      if (evt.block.type === 'tool_call') {
        // F153 Phase J AC-J2: carry upstream protocol tool call id (neutral
        // CatAgentToolCallBlock.id; adapter mapped from Anthropic tool_use.id
        // / OpenAI call_*).
        yield {
          type: 'tool_use',
          catId: this.catId,
          toolName: evt.block.name,
          toolInput: evt.block.input,
          toolUseId: evt.block.id,
          metadata,
          timestamp: Date.now(),
        };
      }
    } else if (evt.type === 'stream_error') {
      yield { type: 'error', catId: this.catId, error: evt.error, metadata, timestamp: Date.now() };
    }
  }

  private async fetchApi(
    messages: ReadonlyArray<AdapterMessage>,
    tools: Array<{ name: string; description: string; input_schema: unknown }>,
    model: string,
    credentials: { apiKey: string; baseURL?: string },
    options?: AgentServiceOptions,
  ): Promise<Response> {
    // G1: URL / headers / body shape all delegated to adapter — service has
    // no idea about `/v1/messages`, `x-api-key`, `anthropic-version`, or
    // `{ model, max_tokens, messages, stream, tools, system }` shape.
    const url = this.adapter.buildRequestUrl(credentials.baseURL);
    const headers = this.adapter.buildRequestHeaders({ apiKey: credentials.apiKey });
    const body = this.adapter.buildRequestBody({
      model,
      messages,
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })),
      ...(options?.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    });

    log.info(
      `[${this.catId}] API call: model=${model}, turns=${messages.length}, stream=true, protocol=${this.adapter.protocolId}`,
    );
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => 'unknown error');
      throw Object.assign(new Error(text), { httpStatus: resp.status });
    }
    return resp;
  }

  private executeTools(
    blocks: ReadonlyArray<CatAgentToolCallBlock>,
    tools: CatAgentTool[],
    _metadata: MessageMetadata,
  ): Promise<CatAgentToolExecResult[]> {
    return executeCatAgentTools(blocks, tools);
  }

  private createToolRegistryOptions(options?: AgentServiceOptions): CatAgentToolRegistryOptions {
    return {
      nativeToolLevel: this.catConfig?.nativeToolLevel,
      commandPolicy: this.catConfig?.commandPolicy,
      audit: this.createToolAuditSink(options),
      scopedCallbacks: options?.catAgentScopedCallbacks,
    };
  }

  private createToolAuditSink(options?: AgentServiceOptions): CatAgentToolAuditSink | undefined {
    const ctx = options?.auditContext;
    if (!ctx) return undefined;
    return async (event: CatAgentToolAuditEvent) => {
      await getEventAuditLog().append({
        type: AuditEventTypes.CATAGENT_SIDE_EFFECT,
        threadId: ctx.threadId,
        data: {
          invocationId: ctx.invocationId,
          threadId: ctx.threadId,
          userId: ctx.userId,
          catId: ctx.catId,
          provider: 'catagent',
          ...event,
        },
      });
    };
  }

  private *handleFetchError(
    err: unknown,
    metadata: MessageMetadata,
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
    // G1: adapter formats the protocol-aware error text; service composes the
    // neutral error + done AgentMessage pair around it. Replaces pre-G1
    // direct `mapAnthropicError(...)` call (Anthropic identifier in service).
    const { errorText } = this.adapter.mapError({ status: httpStatus ?? 0, message });
    const now = Date.now();
    yield { type: 'error', catId: this.catId, error: errorText, metadata, timestamp: now };
    yield {
      type: 'done',
      catId: this.catId,
      metadata: { ...metadata, usage: totalUsage ?? { inputTokens: 0, outputTokens: 0 } },
      timestamp: now,
    };
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
