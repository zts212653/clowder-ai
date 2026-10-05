import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { type Options, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { buildCliDiagnostics } from '../../../../../utils/cli-diagnostics.js';
import { sanitizeCliStderr } from '../../../../../utils/sanitize-cli-stderr.js';
import { CliRawArchive } from '../../session/CliRawArchive.js';
import type {
  AgentFreshnessCarrierCapability,
  AgentMessage,
  AgentService,
  AgentServiceOptions,
  MessageMetadata,
  ToolExecutionPolicy,
} from '../../types.js';
import { resolveDefaultClaudeMcpServerPath } from './ClaudeAgentService.js';
import { ClaudeNativeToolBoundaryClassifier } from './claude-native-tool-boundary.js';
import { extractClaudeUsage, transformClaudeEvent } from './claude-ndjson-parser.js';
import { ClaudeSdkFreshness, ClaudeSdkInput } from './claude-sdk-input.js';
import { prepareClaudeSdkLaunch } from './claude-sdk-launch.js';
import { type RawArchiveSink, sanitizeRawEvent } from './codex-audit-hooks.js';
import { compileL0ViaSubprocess } from './l0-compiler.js';

const log = createModuleLogger('claude-sdk-agent');
export type ClaudeSdkQueryFn = (input: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<unknown> & { close(): void };
interface ClaudeSdkAgentServiceOptions {
  catId?: CatId;
  model?: string;
  mcpServerPath?: string;
  l0CompilerFn?: typeof compileL0ViaSubprocess;
  queryFn?: ClaudeSdkQueryFn;
  rawArchive?: RawArchiveSink;
}

/** One official SDK query per invocation. Accepted work is never retried by this carrier. */
export class ClaudeSdkAgentService implements AgentService {
  readonly catId: CatId;
  readonly _carrierTier = 'agent_sdk';
  private readonly model: string;
  private readonly mcpServerPath?: string;
  private readonly l0CompilerFn: typeof compileL0ViaSubprocess;
  private readonly queryFn: ClaudeSdkQueryFn;
  private readonly rawArchive: RawArchiveSink;

  constructor(options?: ClaudeSdkAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('opus');
    this.model = options?.model ?? getCatModel(this.catId);
    const configuredPath = options?.mcpServerPath ?? process.env.CAT_CAFE_MCP_SERVER_PATH;
    this.mcpServerPath =
      configuredPath === ''
        ? undefined
        : configuredPath
          ? isAbsolute(configuredPath)
            ? configuredPath
            : resolve(process.cwd(), configuredPath)
          : resolveDefaultClaudeMcpServerPath();
    this.l0CompilerFn = options?.l0CompilerFn ?? compileL0ViaSubprocess;
    this.queryFn = options?.queryFn ?? query;
    this.rawArchive = options?.rawArchive ?? new CliRawArchive();
  }
  injectsL0Natively(): boolean {
    return true;
  }
  supportsToolExecutionPolicy(policy: ToolExecutionPolicy): boolean {
    return policy.mode === 'read_only';
  }
  freshnessCarrierCapability(): AgentFreshnessCarrierCapability {
    return { provider: 'anthropic', carrier: 'claude_agent_sdk', deliverySemantics: 'queued_internal_turn' };
  }
  contextCapability(): import('../../types.js').AgentContextCapability {
    return {
      provider: 'anthropic',
      carrier: 'agent_sdk',
      reportsRuntimeWindow: true,
      authoritativeUsage: true,
      usageTelemetry: 'available',
      nativeWindowControl: false,
      nativeCompressionControl: false,
      observesCompression: true,
      reason: 'SDK streams native Claude usage and compact boundaries; no expectedTurn fence',
    };
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const abortController = new AbortController();
    const input = new ClaudeSdkInput();
    const firstUuid = randomUUID();
    const freshness = new ClaudeSdkFreshness(
      input,
      firstUuid,
      options?.auditContext?.threadId ?? 'unknown',
      options?.activeInvocationFreshness,
      (error) => log.warn({ err: error, invocationId: options?.invocationId }, 'SDK freshness owner operation failed'),
      async (notice, uuid) => {
        if (options?.invocationId)
          await this.rawArchive.append(options.invocationId, {
            type: 'sdk_input',
            kind: 'freshness_notice',
            uuid,
            noticeId: notice.noticeId,
            expectedInputUuid: firstUuid,
            contentFree: true,
          });
      },
    );
    const abort = () => {
      abortController.abort(options?.signal?.reason);
      freshness.cancel();
    };
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) abort();
    const metadata: MessageMetadata = { provider: 'anthropic', model: this.model };
    const streamState = {
      currentMessageId: undefined as string | undefined,
      partialTextMessageIds: new Set<string>(),
      lastTurnInputTokens: undefined as number | undefined,
      thinkingBuffer: '',
    };
    const boundaries = new ClaudeNativeToolBoundaryClassifier();
    let sdkQuery: ReturnType<ClaudeSdkQueryFn> | undefined;
    let stderr = '';
    let terminal = false;
    let failed = false;
    let lastTransientError: string | undefined;

    try {
      const prepared = await prepareClaudeSdkLaunch({
        prompt,
        model: this.model,
        catId: this.catId,
        mcpServerPath: this.mcpServerPath,
        l0CompilerFn: this.l0CompilerFn,
        abortController,
        options,
      });
      if (abortController.signal.aborted) {
        yield {
          type: 'done',
          catId: this.catId,
          metadata,
          ...(failed && !options?.signal?.aborted ? { errorCode: 'claude_sdk_failed' } : {}),
          timestamp: Date.now(),
        };
        return;
      }
      metadata.model = prepared.model;
      prepared.sdkOptions.stderr = (data) => {
        stderr = sanitizeCliStderr(stderr + data).slice(-4000);
      };
      input.push(prepared.prompt, options?.sessionId ?? '', firstUuid);
      if (options?.invocationId)
        await this.rawArchive
          .append(options.invocationId, { type: 'sdk_input', kind: 'primary', uuid: firstUuid })
          .catch((error) => log.warn({ err: error, invocationId: options?.invocationId }, 'SDK input archive failed'));
      sdkQuery = this.queryFn({ prompt: input, options: prepared.sdkOptions });
      freshness.start();
      for await (const event of sdkQuery) {
        if (abortController.signal.aborted) break;
        if (typeof event !== 'object' || event === null) continue;
        const raw = event as Record<string, unknown>;
        if (options?.invocationId)
          await this.rawArchive
            .append(options.invocationId, sanitizeRawEvent(event))
            .catch((error) => log.warn({ err: error, invocationId: options?.invocationId }, 'SDK raw archive failed'));
        if (typeof raw.session_id === 'string' && raw.session_id) {
          metadata.sessionId = raw.session_id;
          freshness.setSession(raw.session_id);
        }
        if (raw.type === 'result') {
          terminal = true;
          failed = raw.subtype !== 'success' || raw.is_error === true;
          metadata.usage = extractClaudeUsage(raw);
          if (metadata.usage && streamState.lastTurnInputTokens != null)
            metadata.usage.lastTurnInputTokens = streamState.lastTurnInputTokens;
          const outcome = await freshness.settle(raw);
          if (outcome === 'missed' || outcome === 'unconfirmed')
            yield {
              type: 'system_info',
              catId: this.catId,
              content: JSON.stringify({
                type: `claude_sdk_notice_${outcome}`,
                disposition: 'queued_or_unconfirmed',
                responsibility: 'freshness_owner',
                terminalReason: raw.terminal_reason ?? 'unknown',
              }),
              timestamp: Date.now(),
            };
        }
        for (const surface of boundaries.observe(event)) await freshness.poll(surface);
        // During a silent/long tool, the bounded timer feeds the same SDK input.
        // It never calls MCP or inserts notice text into tool output.
        const transformed = transformClaudeEvent(event, this.catId, streamState);
        if (transformed)
          for (const message of Array.isArray(transformed) ? transformed : [transformed]) {
            if (message.type === 'error') {
              if (message.errorDisposition === 'transient') {
                lastTransientError = message.error;
                continue;
              }
              failed = true;
              metadata.cliDiagnostics = buildCliDiagnostics({
                rawText: stderr,
                structuredErrorText: message.error,
                stderrEmpty: !stderr,
                debugRef: { command: 'claude-agent-sdk', signal: null, invocationId: options?.invocationId },
              });
            }
            yield { ...message, metadata };
          }
        // Stop at the primary result. A tail notice is retained as missed by its
        // owner, rather than authorizing an invisible extra development turn.
        if (terminal) break;
      }
      if (!terminal && !abortController.signal.aborted) throw new Error('claude_sdk_stream_ended_without_result');
    } catch (error) {
      failed = true;
      if (!abortController.signal.aborted) {
        const errorText = sanitizeCliStderr(
          lastTransientError ?? (error instanceof Error ? error.message : String(error)),
        );
        metadata.cliDiagnostics = buildCliDiagnostics({
          rawText: stderr || errorText,
          stderrEmpty: !stderr,
          debugRef: { command: 'claude-agent-sdk', signal: null, invocationId: options?.invocationId },
        });
        yield { type: 'error', catId: this.catId, error: errorText, metadata, timestamp: Date.now() };
      }
    } finally {
      input.close();
      try {
        sdkQuery?.close();
      } catch (error) {
        log.warn({ err: error, invocationId: options?.invocationId }, 'SDK query cleanup failed');
      }
      abortController.abort();
      options?.signal?.removeEventListener('abort', abort);
      await freshness
        .close(failed)
        .catch((error) =>
          log.warn({ err: error, invocationId: options?.invocationId }, 'SDK freshness terminal bookkeeping failed'),
        );
    }
    yield {
      type: 'done',
      catId: this.catId,
      metadata,
      ...(failed && !options?.signal?.aborted ? { errorCode: 'claude_sdk_failed' } : {}),
      timestamp: Date.now(),
    };
  }
}
