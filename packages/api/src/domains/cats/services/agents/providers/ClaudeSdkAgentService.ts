import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import {
  type Options as ClaudeSdkOptions,
  query as claudeQuery,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { buildCliDiagnostics } from '../../../../../utils/cli-diagnostics.js';
import { sanitizeCliStderr } from '../../../../../utils/sanitize-cli-stderr.js';
import { CliRawArchive } from '../../session/CliRawArchive.js';
import type {
  AgentClientActiveRunHandle,
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
import { sdkCompactionHooks } from './claude-sdk-compaction-hooks.js';
import { ClaudeSdkFreshness } from './claude-sdk-input.js';
import { prepareClaudeSdkLaunch } from './claude-sdk-launch.js';
import { withActiveRunControlDeadline } from './claude-sdk-runtime-helpers.js';
import { ClaudeSdkTurnInputState, createSdkUserMessage } from './claude-sdk-turn-input-state.js';
import { type RawArchiveSink, sanitizeRawEvent } from './codex-audit-hooks.js';
import { appendLocalImagePathHints } from './image-cli-bridge.js';
import { compileL0ViaSubprocess } from './l0-compiler.js';

const log = createModuleLogger('claude-sdk-agent');

export type ClaudeSdkQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: ClaudeSdkOptions;
}) => AsyncIterable<unknown> & { close(): void; interrupt?(): Promise<unknown> };
interface ClaudeSdkAgentServiceOptions {
  catId?: CatId;
  model?: string;
  mcpServerPath?: string;
  l0CompilerFn?: typeof compileL0ViaSubprocess;
  queryFn?: ClaudeSdkQueryFn;
  rawArchive?: RawArchiveSink;
  activeRunControlTimeoutMs?: number;
}

const DEFAULT_ACTIVE_RUN_CONTROL_TIMEOUT_MS = 15_000;
const MAX_SDK_STDERR_CHARS = 4_000;

/** SDK send correlation and model consumption have different contracts. */
function consumedClientInputIds(raw: Record<string, unknown>): readonly unknown[] {
  if (raw.parent_tool_use_id) return [];
  switch (raw.type) {
    case 'assistant':
      // Synthetic API-error assistants also echo the triggering send UUID.
      if (raw.error !== undefined) return [];
      break;
    case 'stream_event': {
      const event = raw.event as { type?: unknown } | null | undefined;
      if (!event || typeof event !== 'object' || typeof event.type !== 'string' || event.type === 'ping') return [];
      break;
    }
    case 'result':
      // The consumed list is absent on failed delivery/zeroed results. A single
      // result UUID is only a join key; num_turns and eventual success are not proof.
      if (raw.local_command !== undefined) return [];
      return Array.isArray(raw.user_message_uuids) ? raw.user_message_uuids : [];
    default:
      return [];
  }
  // Older main-query reply frames have the documented single-UUID form.
  return Array.isArray(raw.user_message_uuids) ? raw.user_message_uuids : [raw.user_message_uuid];
}

/**
 * Claude's official Agent SDK carrier. Unlike `claude -p`, the SDK exposes a
 * streaming input channel and an explicit interrupt operation, so Append and
 * Steer are delivered to the exact active query without involving MCP tools.
 */
export class ClaudeSdkAgentService implements AgentService {
  readonly catId: CatId;
  readonly _carrierTier = 'agent_sdk';
  private readonly model: string;
  private readonly mcpServerPath: string | undefined;
  private readonly l0CompilerFn: typeof compileL0ViaSubprocess;
  private readonly queryFn: ClaudeSdkQueryFn;
  private readonly rawArchive: RawArchiveSink;
  private readonly activeRunControlTimeoutMs: number;

  constructor(options?: ClaudeSdkAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('opus');
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.l0CompilerFn = options?.l0CompilerFn ?? compileL0ViaSubprocess;
    this.queryFn = options?.queryFn ?? claudeQuery;
    this.rawArchive = options?.rawArchive ?? new CliRawArchive();
    this.activeRunControlTimeoutMs = options?.activeRunControlTimeoutMs ?? DEFAULT_ACTIVE_RUN_CONTROL_TIMEOUT_MS;
    const configuredPath = options?.mcpServerPath ?? process.env.CAT_CAFE_MCP_SERVER_PATH;
    this.mcpServerPath =
      configuredPath === ''
        ? undefined
        : configuredPath
          ? isAbsolute(configuredPath)
            ? configuredPath
            : resolve(process.cwd(), configuredPath)
          : resolveDefaultClaudeMcpServerPath();
  }

  injectsL0Natively(): boolean {
    return true;
  }

  supportsToolExecutionPolicy(policy: ToolExecutionPolicy): boolean {
    return policy.mode === 'read_only';
  }

  freshnessCarrierCapability(): AgentFreshnessCarrierCapability {
    return {
      provider: 'anthropic',
      carrier: 'claude_agent_sdk',
      deliverySemantics: 'queued_internal_turn',
      activeInvocationGuidance: 'supported',
    };
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
      reason: 'Claude Agent SDK streams native usage and compact-boundary events',
    };
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const abortController = new AbortController();
    const turnInputs = new ClaudeSdkTurnInputState();
    const inputReadCallbacks = new Map<string, () => Promise<void>>();
    const inputReadInFlight = new Set<string>();
    const initialMessageId = randomUUID();
    let noticeId: string | null = null;
    const freshness = new ClaudeSdkFreshness(
      {
        push: (text, sessionId) => (noticeId = turnInputs.pushNotice(text, sessionId)),
        close: () => {
          if (noticeId) turnInputs.withdrawNotice(noticeId);
        },
      },
      initialMessageId,
      options?.auditContext?.threadId ?? 'unknown',
      options?.activeInvocationFreshness,
      (err) => log.warn({ err, invocationId: options?.invocationId }, 'SDK freshness owner operation failed'),
      async (notice, uuid) => {
        if (options?.invocationId)
          await this.rawArchive.append(options.invocationId, {
            type: 'sdk_input',
            kind: 'freshness_notice',
            uuid,
            noticeId: notice.noticeId,
            expectedInputUuid: initialMessageId,
            contentFree: true,
          });
      },
    );
    const abort = () => {
      abortController.abort(options?.signal?.reason);
      freshness.cancel();
      turnInputs.close();
    };
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) abort();

    let stderrBuffer = '';
    let activeSessionId = options?.sessionId ?? '';
    const metadata: MessageMetadata = { provider: 'anthropic', model: this.model };
    const streamState = {
      currentMessageId: undefined as string | undefined,
      partialTextMessageIds: new Set<string>(),
      lastTurnInputTokens: undefined as number | undefined,
      thinkingBuffer: '',
    };
    const boundaries = new ClaudeNativeToolBoundaryClassifier();
    let query: ReturnType<ClaudeSdkQueryFn> | undefined;
    let terminal = false;
    let failed = false;
    let lastTransientError: string | undefined;
    let archiveWrites = Promise.resolve();
    const archive = (event: unknown) => {
      if (!options?.invocationId) return;
      const invocationId = options.invocationId;
      archiveWrites = archiveWrites
        .then(() => this.rawArchive.append(invocationId, sanitizeRawEvent(event)))
        .catch((err) => log.warn({ err }, 'SDK raw archive failed'));
    };
    let releaseDispatch: (() => void) | undefined;
    let dispatcherRegistered = false;

    const registerDispatcher = () => {
      if (dispatcherRegistered || !options?.activeRunDispatch || !options.invocationId || !activeSessionId) return;
      dispatcherRegistered = true;
      const invocationId = options.activeRunDispatch.invocationId;
      const handle: AgentClientActiveRunHandle = {
        provider: 'anthropic',
        carrier: 'claude_agent_sdk',
        threadId: activeSessionId,
        turnId: initialMessageId,
      };
      const release = options.activeRunDispatch.register({
        invocationId,
        capabilities: { append: true, steer: true, inputReadReceipt: true },
        handle,
        dispatch: async (dispatchInput, dispatchOptions) => {
          if (dispatchOptions.expectedInvocationId !== invocationId) {
            return { accepted: false, reason: 'active_run_mismatch' };
          }
          if (!turnInputs.isAccepting || !query) return { accepted: false, reason: 'active_run_closed' };
          const text = appendLocalImagePathHints(dispatchInput.text.trim(), dispatchInput.imagePaths ?? []);
          if (!text) return { accepted: false, reason: 'invalid_input' };
          turnInputs.beginDispatch();
          try {
            if (dispatchOptions.force) {
              if (!query.interrupt) return { accepted: false, reason: 'provider_rejected' };
              await withActiveRunControlDeadline(query.interrupt(), this.activeRunControlTimeoutMs);
            }
            const message = createSdkUserMessage(text, activeSessionId);
            if (dispatchInput.onInputRead) inputReadCallbacks.set(message.uuid, dispatchInput.onInputRead);
            if (!turnInputs.push(message)) {
              inputReadCallbacks.delete(message.uuid);
              return { accepted: false, reason: 'active_run_closed' };
            }
            return { accepted: true, handle };
          } catch (err) {
            log.warn({ err, invocationId }, 'Claude SDK active-run dispatch rejected');
            return { accepted: false, reason: 'provider_rejected' };
          } finally {
            turnInputs.finishDispatch();
          }
        },
      });
      if (typeof release === 'function') releaseDispatch = release;
    };

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
        yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }
      metadata.model = prepared.model;
      const sdkOptions = prepared.sdkOptions;
      if (options?.claudeCompactionHooks) sdkOptions.hooks = sdkCompactionHooks(options.claudeCompactionHooks, log);
      sdkOptions.stderr = (data) => {
        stderrBuffer = sanitizeCliStderr(`${stderrBuffer}${data}`).slice(-MAX_SDK_STDERR_CHARS);
      };
      query = this.queryFn({ prompt: turnInputs.input, options: sdkOptions });
      turnInputs.push(createSdkUserMessage(prepared.prompt, activeSessionId, initialMessageId));
      archive({ type: 'sdk_input', kind: 'primary', uuid: initialMessageId });
      freshness.start();
      for await (const event of query) {
        if (abortController.signal.aborted) break;
        if (typeof event !== 'object' || event === null) continue;
        const raw = event as Record<string, unknown>;
        for (const id of consumedClientInputIds(raw)) {
          if (typeof id !== 'string') continue;
          const notify = inputReadCallbacks.get(id);
          if (!notify || inputReadInFlight.has(id)) continue;
          inputReadInFlight.add(id);
          // Optional presentation persistence must never hold output or Stop.
          void notify()
            .then(() => inputReadCallbacks.delete(id))
            .catch((err) => {
              log.warn({ err, invocationId: options?.invocationId }, 'Optional input-read presentation update failed');
            })
            .finally(() => inputReadInFlight.delete(id));
        }
        // The archive is ordered best-effort diagnostics, not the receipt
        // authority. Disk I/O must not delay cancellation or member output.
        archive(event);
        const isResultTerminal = raw.type === 'result';
        if (typeof raw.session_id === 'string' && raw.session_id) {
          activeSessionId = raw.session_id;
          metadata.sessionId = raw.session_id;
          freshness.setSession(raw.session_id);
          registerDispatcher();
        }
        if (isResultTerminal) {
          terminal = true;
          failed ||= raw.subtype !== 'success' || raw.is_error === true;
          const ids = Array.isArray(raw.user_message_uuids) ? raw.user_message_uuids : [];
          const origin = raw.origin as { kind?: string } | undefined;
          if (
            ids.includes(initialMessageId) ||
            raw.user_message_uuid === initialMessageId ||
            (ids.length === 0 && !raw.user_message_uuid && (!origin?.kind || origin.kind === 'human'))
          ) {
            const outcome = await freshness.settle(raw);
            if (outcome === 'missed' || outcome === 'unconfirmed')
              yield {
                type: 'system_info',
                catId: this.catId,
                content: JSON.stringify({
                  type: `claude_sdk_notice_${outcome}`,
                  responsibility: 'freshness_owner',
                  terminalReason: raw.terminal_reason ?? 'unknown',
                }),
                timestamp: Date.now(),
              };
          }
          // The SDK may coalesce several queued sends into one provider turn.
          // Its result echoes every consumed user-message uuid, so settle the
          // accepted messages by identity instead of assuming one result per
          // input. Interrupt receipts are ordered before the interrupted turn's
          // result on the clean path; a crash may reverse those two, and the
          // identity join remains correct in either order. queued_turn_count
          // provides a provider-authored backstop when a result lacks an input
          // identity (including an interrupted-turn compatibility edge). A turn
          // the provider started itself, such as a killed task's notification,
          // settles none of our inputs.
          turnInputs.settleResult(raw);
          metadata.usage = extractClaudeUsage(raw);
          if (streamState.lastTurnInputTokens != null && metadata.usage) {
            metadata.usage.lastTurnInputTokens = streamState.lastTurnInputTokens;
          }
        }
        for (const surface of boundaries.observe(event)) await freshness.poll(surface);
        const transformed = transformClaudeEvent(event, this.catId, streamState);
        if (transformed) {
          for (const message of Array.isArray(transformed) ? transformed : [transformed]) {
            if (message.type === 'error') {
              if (message.errorDisposition === 'transient') {
                lastTransientError = message.error;
                continue;
              }
              failed = true;
              metadata.cliDiagnostics = buildCliDiagnostics({
                rawText: stderrBuffer,
                structuredErrorText: message.error,
                stderrEmpty: !stderrBuffer,
                debugRef: { command: 'claude-agent-sdk', signal: null, invocationId: options?.invocationId },
              });
            }
            yield { ...message, metadata };
          }
        }
        // A streaming-input query may carry multiple accepted turns. Close at
        // the result for the final accepted input, but keep consuming when an
        // Append/Steer already promised another result to the caller. Breaking
        // performs AsyncIteratorClose (Query.return), terminating the SDK query.
        if (isResultTerminal && !turnInputs.isAccepting) break;
      }
      if ((!terminal || turnInputs.isAccepting) && !abortController.signal.aborted)
        throw new Error('claude_sdk_stream_ended_without_result');
    } catch (err) {
      failed = true;
      if (!abortController.signal.aborted) {
        const error = sanitizeCliStderr(
          stderrBuffer.trim() || lastTransientError || (err instanceof Error ? err.message : String(err)),
        );
        metadata.cliDiagnostics = buildCliDiagnostics({
          rawText: stderrBuffer || error,
          stderrEmpty: !stderrBuffer,
          debugRef: { command: 'claude-agent-sdk', signal: null, invocationId: options?.invocationId },
        });
        yield {
          type: 'error',
          catId: this.catId,
          error,
          metadata,
          timestamp: Date.now(),
        };
      }
    } finally {
      inputReadCallbacks.clear();
      inputReadInFlight.clear();
      turnInputs.close();
      try {
        query?.close();
      } catch (err) {
        log.warn({ err }, 'SDK query cleanup failed');
      }
      releaseDispatch?.();
      abortController.abort();
      options?.signal?.removeEventListener('abort', abort);
      await archiveWrites;
      await freshness.close(failed).catch((err) => log.warn({ err }, 'SDK freshness terminal bookkeeping failed'));
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
