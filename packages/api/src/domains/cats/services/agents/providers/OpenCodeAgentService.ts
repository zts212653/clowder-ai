/**
 * opencode Agent Service
 * 通过 opencode CLI 子进程调用 opencode agent（headless JSON 模式）
 *
 * CLI 调用方式:
 *   opencode run "prompt" --format json -m providerId/MODEL
 *   (API key passed via child process env, not CLI args)
 *
 * NDJSON 事件格式 (opencode run --format json):
 *   step_start  → session_init
 *   text        → text (part.text)
 *   tool_use    → tool_use (part.tool, part.state.input)
 *   step_finish → null (cost/tokens metadata)
 *   error       → error
 */

import { randomUUID } from 'node:crypto';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { buildCliDiagnostics, buildSilentCompletionDiagnostic } from '../../../../../utils/cli-diagnostics.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import { CliRawArchive } from '../../session/CliRawArchive.js';
import type {
  AgentMessage,
  AgentServiceOptions,
  L0InjectableAgentService,
  MessageMetadata,
  ToolExecutionPolicy,
} from '../../types.js';
import { resolveCurrentContextUsage } from '../../types.js';
import type { RawArchiveSink } from '../providers/codex-audit-hooks.js';
import { sanitizeRawEvent } from '../providers/codex-audit-hooks.js';
import {
  cacheOpenCodeAutoApproveProbe,
  getCliFlagName,
  OPENCODE_AUTO_APPROVE_FLAG,
  type OpenCodeAutoApproveProbeFn,
  type OpenCodeAutoApproveProbeResult,
  parseOpenCodeCliConfigArgs,
  probeOpenCodeAutoApproveSupport,
  userControlsOpenCodeAutoApprove,
} from './opencode-auto-approval.js';
import { transformOpenCodeEvent } from './opencode-event-transform.js';
import {
  buildOpenCodeNoToolFinalizerConfig,
  buildOpenCodePostToolFallbackText,
  buildOpenCodePostToolFinalizerPrompt,
  extractOpenCodeMessageRef,
  extractOpenCodeToolTrace,
  hasOpenCodeManagedConfig,
  identifierPrefix,
  OPENCODE_CONFIG_CONTENT_ENV,
  OPENCODE_NO_TOOL_FINALIZER_AGENT,
  OPENCODE_NO_TOOL_PERMISSION,
  OPENCODE_PERMISSION_ENV,
  type OpenCodeToolTrace,
  recoverOpenCodeSilentCompletion,
  SessionSingleFlight,
} from './opencode-recovery.js';

const log = createModuleLogger('opencode-agent');

interface OpenCodeAgentServiceOptions {
  catId?: CatId;
  /** Model name (e.g. 'claude-sonnet-4-6' or 'openrouter/google/gemini-3-flash-preview') */
  model?: string;
  /** API key for Anthropic provider */
  apiKey?: string;
  /** Base URL for Anthropic provider (e.g. proxy endpoint) */
  baseUrl?: string;
  /** Inject a custom spawn function (for testing) */
  spawnFn?: SpawnFn;
  /** #780: Raw NDJSON archive sink (default: CliRawArchive to disk) */
  rawArchive?: RawArchiveSink;
  /** F203 Phase I: test seam — replaces the real L0 compiler subprocess (like Claude/Codex services). */
  l0CompilerFn?: (options: { catId: string; userId?: string; dataDir?: string; outPath?: string }) => Promise<string>;
  /** Test seam for the `opencode run --help` auto-approval capability probe. */
  autoApproveProbeFn?: OpenCodeAutoApproveProbeFn;
  /** Test seam for OpenCode's local SQLite state used to recover silent completions. */
  opencodeDbPath?: string;
  /** Test seam for managed OpenCode config precedence detection. */
  opencodeManagedConfigPaths?: readonly string[];
}

const OPENCODE_API_KEY_ENV = 'OPENCODE_API_KEY';
const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';
const ANTHROPIC_BASE_URL_ENV = 'ANTHROPIC_BASE_URL';
const OPENCODE_READ_ONLY_AGENT = 'cat-cafe-read-only';
const OPENCODE_READ_ONLY_PERMISSION = {
  '*': 'deny',
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  lsp: 'allow',
  skill: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
  edit: 'deny',
  bash: 'deny',
  task: 'deny',
  question: 'deny',
} as const;
// Process-wide cache: --auto support is a property of the installed opencode binary.
// Restart the API process after upgrading opencode so this capability is re-probed.
let sharedOpenCodeAutoApproveProbe: Promise<OpenCodeAutoApproveProbeResult> | undefined;

export interface OpenCodeEnvDebugSummary {
  mode: 'runtime-config' | 'subscription' | 'direct-env' | 'empty';
  opencodeConfig: string;
  profileMode: string;
  modelOverride: string;
  anthropicApiKey: string;
  anthropicBaseUrl: string;
  catCafeOcApiKey: string;
  catCafeOcBaseUrl: string;
}

interface OpenCodePostToolFinalizerParams {
  command: string;
  cwd?: string;
  childEnv: Record<string, string | null>;
  effectiveModel: string;
  metadata: MessageMetadata;
  sessionId?: string;
  trace: OpenCodeToolTrace | null;
  textMode: 'append' | 'replace';
  options?: AgentServiceOptions;
}

function getOpenCodeStepFinishReason(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const raw = event as Record<string, unknown>;
  if (raw.type !== 'step_finish') return undefined;
  const part = raw.part;
  if (typeof part !== 'object' || part === null) return undefined;
  const reason = (part as Record<string, unknown>).reason;
  return typeof reason === 'string' ? reason : undefined;
}

function isPermanentOpenCodeProviderFailure(event: unknown, reasonCode: string | undefined): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const rawError = (event as Record<string, unknown>).error;
  if (typeof rawError !== 'object' || rawError === null) return false;
  const data = (rawError as Record<string, unknown>).data;
  const statusCode =
    typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).statusCode === 'number'
      ? ((data as Record<string, unknown>).statusCode as number)
      : undefined;

  // These outcomes cannot recover by retrying the same configured invocation.
  // Deliberately exclude 408/429/5xx: those are transient and OpenCode may
  // legitimately recover without Clowder AI terminating the process.
  return (
    reasonCode === 'model_not_found' ||
    reasonCode === 'auth_failed' ||
    reasonCode === 'invalid_config' ||
    statusCode === 401 ||
    statusCode === 402 ||
    statusCode === 403 ||
    statusCode === 404
  );
}

function summarizeDebugValue(value: string | null | undefined): string {
  if (value === null) return '(cleared)';
  if (!value) return '(unset)';
  return value;
}

function summarizeDebugSecret(value: string | null | undefined): string {
  if (value === null) return '(cleared)';
  if (!value) return '(unset)';
  return `${value.slice(0, 6)}***`;
}

export function summarizeOpenCodeEnvForDebug(env: Record<string, string | null> | undefined): OpenCodeEnvDebugSummary {
  const profileMode = env?.CAT_CAFE_ANTHROPIC_PROFILE_MODE ?? '(unset)';
  const hasRuntimeConfig = Boolean(env?.OPENCODE_CONFIG);
  const hasDirectAnthropicEnv = Boolean(env?.[ANTHROPIC_API_KEY_ENV] || env?.[ANTHROPIC_BASE_URL_ENV]);

  return {
    mode: hasRuntimeConfig
      ? 'runtime-config'
      : profileMode === 'subscription'
        ? 'subscription'
        : hasDirectAnthropicEnv
          ? 'direct-env'
          : 'empty',
    opencodeConfig: summarizeDebugValue(env?.OPENCODE_CONFIG),
    profileMode,
    modelOverride: env?.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE ?? '(unset)',
    anthropicApiKey: summarizeDebugSecret(env?.[ANTHROPIC_API_KEY_ENV]),
    anthropicBaseUrl: summarizeDebugValue(env?.[ANTHROPIC_BASE_URL_ENV]),
    catCafeOcApiKey: summarizeDebugSecret(env?.CAT_CAFE_OC_API_KEY),
    catCafeOcBaseUrl: summarizeDebugValue(env?.CAT_CAFE_OC_BASE_URL),
  };
}

/** F203 Phase I: env var signaling that OPENCODE_CONFIG is instructions-only (no custom provider). */
export const OC_INSTRUCTIONS_ONLY_ENV = 'CAT_CAFE_OC_INSTRUCTIONS_ONLY';

export class OpenCodeAgentService implements L0InjectableAgentService {
  readonly catId: CatId;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly spawnFn: SpawnFn | undefined;
  /** #780: Raw NDJSON archive for post-mortem diagnostics */
  private readonly rawArchive: RawArchiveSink;
  /** F203 Phase I: injectable L0 compiler (test seam, like Claude/Codex services). */
  readonly l0CompilerFn: import('../../types.js').L0CompilerFn | undefined;
  private readonly autoApproveProbeFn: OpenCodeAutoApproveProbeFn | undefined;
  private readonly opencodeDbPath: string | undefined;
  private readonly opencodeManagedConfigPaths: readonly string[] | undefined;
  private readonly sessionSingleFlight = new SessionSingleFlight();
  private autoApproveProbe: Promise<OpenCodeAutoApproveProbeResult> | undefined;

  constructor(options?: OpenCodeAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('opencode');
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.apiKey = options?.apiKey;
    this.baseUrl = options?.baseUrl;
    this.spawnFn = options?.spawnFn;
    this.rawArchive = options?.rawArchive ?? new CliRawArchive();
    this.l0CompilerFn = options?.l0CompilerFn;
    this.autoApproveProbeFn = options?.autoApproveProbeFn;
    this.opencodeDbPath = options?.opencodeDbPath;
    this.opencodeManagedConfigPaths = options?.opencodeManagedConfigPaths;
  }

  /**
   * F203 Phase I — OpenCode injects L0 via runtime config `instructions` array.
   * OpenCode loads instructions files every turn into `role: "system"` messages,
   * making them compression-immune (S8 spike: sst/opencode@v1.15.13).
   *
   * IMPORTANT: When this returns true, the route layer switches to pack-only
   * static identity (no full prepend). The caller (invoke-single-cat) MUST ensure
   * every OpenCode invocation path generates a runtime config with `instructions`
   * containing the compiled L0 file. See AC-I3/I4 guards.
   */
  injectsL0Natively(): boolean {
    return true;
  }

  supportsToolExecutionPolicy(policy: ToolExecutionPolicy): boolean {
    return policy.mode === 'read_only';
  }

  contextCapability(): import('../../types.js').AgentContextCapability {
    return {
      provider: 'opencode',
      carrier: 'run_json',
      reportsRuntimeWindow: false,
      authoritativeUsage: true,
      usageTelemetry: 'available',
      nativeWindowControl: true,
      nativeCompressionControl: true,
      observesCompression: false,
      reason: 'OpenCode reports current turn input; runtime config controls the bound model window',
    };
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    yield* this.sessionSingleFlight.run(options?.sessionId, () => this.invokeUnlocked(prompt, options));
  }

  private async *invokeUnlocked(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const readOnly = options?.toolExecutionPolicy?.mode === 'read_only';
    // P1-2: runtime model override takes precedence over constructor model
    const effectiveModel = options?.callbackEnv?.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE ?? this.model;
    const cwd = options?.workingDirectory;
    const childEnv = this.buildEnv(options?.callbackEnv);
    // F171: Account env vars applied LAST — user overrides provider-injected values
    if (options?.accountEnv) {
      for (const [k, v] of Object.entries(options.accountEnv)) childEnv[k] = v;
    }
    if (readOnly) {
      childEnv.CAT_CAFE_READONLY = 'true';
      childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        permission: OPENCODE_READ_ONLY_PERMISSION,
        agent: {
          [OPENCODE_READ_ONLY_AGENT]: {
            mode: 'primary',
            permission: OPENCODE_READ_ONLY_PERMISSION,
          },
        },
      });
    }
    // The Clowder AI MCP workspace is authoritative in OPENCODE_CONFIG
    // mcp.cat-cafe.environment. Do not leak stale account-level workspace env into
    // the parent OpenCode process and let it race the invocation-scoped config.
    childEnv.ALLOWED_WORKSPACE_DIRS = null;
    const envSummary = summarizeOpenCodeEnvForDebug(childEnv);
    const metadata: MessageMetadata = { provider: 'opencode', model: effectiveModel };
    let sessionInitEmitted = false;

    try {
      const opencodeCommand = resolveCliCommand('opencode');
      if (!opencodeCommand) {
        yield {
          type: 'error' as const,
          catId: this.catId,
          error: formatCliNotFoundError('opencode'),
          metadata,
          timestamp: Date.now(),
        };
        yield { type: 'done' as const, catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }

      const defaultAutoApproveFlag = readOnly
        ? undefined
        : await this.resolveDefaultAutoApproveFlag(opencodeCommand, cwd, childEnv, options?.cliConfigArgs);
      const args = this.buildArgs(
        prompt,
        options?.sessionId,
        effectiveModel,
        readOnly ? undefined : options?.cliConfigArgs,
        defaultAutoApproveFlag,
        readOnly,
      );

      log.debug(
        {
          catId: this.catId,
          command: opencodeCommand,
          model: effectiveModel,
          sessionId: options?.sessionId,
          invocationId: options?.invocationId,
          cwd,
          envSummary,
          argCount: args.length,
        },
        'Invoking OpenCode CLI',
      );

      const successfulExitStderr: { stderrPresent: boolean; stderrExcerpt?: string } = { stderrPresent: false };
      const onSuccessfulExitStderr = (summary: { stderrPresent: boolean; stderrExcerpt?: string }): void => {
        successfulExitStderr.stderrPresent = summary.stderrPresent;
        if (summary.stderrExcerpt) successfulExitStderr.stderrExcerpt = summary.stderrExcerpt;
      };

      const cliOpts = {
        command: opencodeCommand,
        args,
        ...(cwd ? { cwd } : {}),
        env: childEnv,
        onSuccessfulExitStderr,
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
        ...(options?.parentSpan ? { parentSpan: options.parentSpan } : {}),
        ...(options?.invocationId && this.rawArchive.getPath
          ? { rawArchivePath: this.rawArchive.getPath(options.invocationId) }
          : {}),
      };
      const events = options?.spawnCliOverride
        ? options.spawnCliOverride(cliOpts)
        : spawnCli(cliOpts, this.spawnFn ? { spawnFn: this.spawnFn } : undefined);

      let eventCount = 0;
      let textEventCount = 0;
      let lastTextEventIndex = 0;
      let lastToolEventIndex = 0;
      let lastToolTrace: OpenCodeToolTrace | null = null;
      let lastStepFinishReason: string | undefined;
      let stepStartCount = 0;
      let delegateTaskEmitted = false;
      let lastAssistantMessageId: string | undefined;
      // F212 Phase G (AC-G3, clowder-ai#875): track unique event types so the
      // silent_completion diagnostic can surface them when textEventCount===0.
      const uniqueEventTypes = new Set<string>();
      // F212 Phase G: skip silent_completion if ANY error event already yielded.
      // Real errors (cli error, stream error, timeout, model_not_found, auth_failed,
      // etc.) carry the actual reason; silent_completion would be a noisy duplicate.
      // Track any error path, not just ones with cliDiagnostics.
      let errorAlreadyYielded = false;
      // F212 Phase G R1 P1 (cloud codex on 1d519e7f2): tool-only turns are valid task
      // completions per F215 AC-B3. When the assistant emitted a tool_use event the work
      // happened via tools — silent_completion would mislabel a legitimate path.
      let toolUseEmitted = false;
      // Issue #1208: CodeAgent 3.0 → OpenCode facade may drop token usage in the
      // translate script. Track whether any event carried usage so we can surface a
      // persistent visible alert when auto-handoff cannot be guaranteed.
      let usageTelemetryReceived = false;

      for await (const event of events) {
        eventCount++;
        // #780: Archive raw event for post-mortem diagnostics (fire-and-forget)
        if (options?.invocationId) {
          this.rawArchive.append(options.invocationId, sanitizeRawEvent(event)).catch((err) => {
            log.warn({ catId: this.catId, invocationId: options.invocationId, err }, 'Raw archive write failed');
          });
        }
        const evtType =
          typeof event === 'object' && event !== null && 'type' in event
            ? String((event as Record<string, unknown>).type)
            : '__unknown';
        uniqueEventTypes.add(evtType);
        if (evtType === 'step_start') stepStartCount++;
        const messageRef = extractOpenCodeMessageRef(event);
        if (messageRef?.sessionId) metadata.sessionId = messageRef.sessionId;
        if (messageRef?.messageId) lastAssistantMessageId = messageRef.messageId;
        log.debug({ catId: this.catId, eventIndex: eventCount, type: evtType }, 'CLI event received');
        if (isCliTimeout(event)) {
          yield {
            type: 'system_info' as const,
            catId: this.catId,
            content: JSON.stringify({
              type: 'timeout_diagnostics',
              silenceDurationMs: event.silenceDurationMs,
              processAlive: event.processAlive,
              lastEventType: event.lastEventType,
              firstEventAt: event.firstEventAt,
              lastEventAt: event.lastEventAt,
              cliSessionId: event.cliSessionId,
              invocationId: event.invocationId,
              rawArchivePath: event.rawArchivePath,
              terminalContext: event.terminalContext,
            }),
            timestamp: Date.now(),
          };
          yield {
            type: 'error',
            catId: this.catId,
            error: `opencode CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s${event.firstEventAt == null ? ', 未收到首帧' : ''})`,
            // F212 Phase A (云端 codex P2): timeout cliDiagnostics 也透传到 metadata.
            metadata: event.cliDiagnostics ? { ...metadata, cliDiagnostics: event.cliDiagnostics } : metadata,
            timestamp: Date.now(),
          };
          errorAlreadyYielded = true;
          continue;
        }
        // F118 Phase C: Forward liveness warnings to frontend with catId
        if (isLivenessWarning(event)) {
          const warningEvent = event as { level?: string; silenceDurationMs?: number };
          log.warn(
            {
              catId: this.catId,
              invocationId: options?.invocationId,
              level: warningEvent.level,
              silenceMs: warningEvent.silenceDurationMs,
            },
            '[OpenCodeAgent] liveness warning — CLI may be stuck',
          );
          yield {
            type: 'system_info' as const,
            catId: this.catId,
            content: JSON.stringify({ type: 'liveness_warning', ...event }),
            timestamp: Date.now(),
          };
          continue;
        }
        if (isCliError(event)) {
          // F212 Phase A (砚砚 review BLOCKED P1-2): forward cliDiagnostics on metadata so
          // frontend folded panel (Phase B) can render reasonCode / safeExcerpt / publicHint.
          yield {
            type: 'error',
            catId: this.catId,
            error: formatCliExitError('opencode CLI', event),
            metadata: event.cliDiagnostics ? { ...metadata, cliDiagnostics: event.cliDiagnostics } : metadata,
            timestamp: Date.now(),
          };
          errorAlreadyYielded = true;
          continue;
        }

        const result = transformOpenCodeEvent(event, this.catId);
        if (result !== null) {
          let terminateAfterYield = false;
          if (result.type === 'text') {
            textEventCount++;
            lastTextEventIndex = eventCount;
          }
          if (result.type === 'tool_use') {
            toolUseEmitted = true;
            lastToolEventIndex = eventCount;
            const toolTrace = extractOpenCodeToolTrace(event);
            if (toolTrace !== null) {
              lastToolTrace = toolTrace;
              if (toolTrace.toolName === 'delegate-task') delegateTaskEmitted = true;
            }
          }
          // F212 Phase A AC-A8: enrich stream `error` event yield with cliDiagnostics so
          // frontend folded panel (Phase B) sees reasonCode / safeExcerpt / publicHint
          // even when CLI never exits non-zero (some providers emit error events then exit 0).
          let yieldMetadata: MessageMetadata = metadata;
          if (result.type === 'error') {
            const rawError = (event as Record<string, unknown>).error as
              | { name?: string; data?: { message?: string; statusCode?: number } }
              | undefined;
            log.warn(
              {
                catId: this.catId,
                invocationId: options?.invocationId,
                errorName: rawError?.name,
                errorMessage: rawError?.data?.message,
                statusCode: rawError?.data?.statusCode,
              },
              'OpenCode CLI returned error event',
            );
            const diagnosticText = [
              rawError?.data?.message ?? rawError?.name,
              rawError?.data?.statusCode ? `HTTP ${rawError.data.statusCode}` : undefined,
            ]
              .filter((value): value is string => Boolean(value))
              .join('\n');
            if (diagnosticText) {
              const cliDiagnostics = buildCliDiagnostics({
                rawText: diagnosticText,
                debugRef: {
                  command: 'opencode',
                  exitCode: null,
                  signal: null,
                  ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
                },
              });
              yieldMetadata = { ...metadata, cliDiagnostics };
            }
            terminateAfterYield = isPermanentOpenCodeProviderFailure(event, yieldMetadata.cliDiagnostics?.reasonCode);
            errorAlreadyYielded = true;
          }
          // P2-1: Only emit the first session_init; subsequent step_start events
          // in multi-step runs are silently dropped to avoid duplicate session metrics.
          if (result.type === 'session_init') {
            if (sessionInitEmitted) continue;
            sessionInitEmitted = true;
            if (result.sessionId) metadata.sessionId = result.sessionId;
          }
          // clowder#915 R1 P1 (砚砚): transformer may carry `metadata.usage`
          // (from step_finish). The naive `metadata: yieldMetadata` below would
          // strip it because spread can't see nested keys. Merge `usage` onto
          // the service-level metadata (which has correct provider + model) so
          // invoke-single-cat's F8 token block + F24 contextHealth path can fire.
          const mergedMetadata: MessageMetadata =
            result.metadata?.usage != null ? { ...yieldMetadata, usage: result.metadata.usage } : yieldMetadata;
          if (result.metadata?.usage != null && resolveCurrentContextUsage(result.metadata.usage) != null) {
            usageTelemetryReceived = true;
          }
          yield { ...result, metadata: mergedMetadata };
          if (terminateAfterYield) {
            log.warn(
              {
                catId: this.catId,
                invocationId: options?.invocationId,
                reasonCode: yieldMetadata.cliDiagnostics?.reasonCode,
              },
              'Permanent OpenCode provider failure — terminating retrying CLI',
            );
            break;
          }
        }
        const stepFinishReason = getOpenCodeStepFinishReason(event);
        if (stepFinishReason) {
          lastStepFinishReason = stepFinishReason;
        }
      }

      log.info(
        {
          catId: this.catId,
          totalEvents: eventCount,
          textEvents: textEventCount,
          sessionIdPrefix: identifierPrefix(metadata.sessionId),
        },
        'OpenCode CLI invocation completed',
      );
      if (eventCount > 0 && textEventCount === 0 && !errorAlreadyYielded && !toolUseEmitted) {
        const recoveredText = this.recoverSilentCompletionText(metadata.sessionId, lastAssistantMessageId);
        if (recoveredText) {
          log.info(
            {
              catId: this.catId,
              sessionIdPrefix: identifierPrefix(metadata.sessionId),
              messageIdPrefix: identifierPrefix(lastAssistantMessageId),
              textLength: recoveredText.length,
            },
            'Recovered OpenCode silent completion text from local SQLite state',
          );
          textEventCount++;
          yield {
            type: 'text' as const,
            catId: this.catId,
            content: recoveredText,
            metadata,
            timestamp: Date.now(),
          };
        }
      }
      if (
        textEventCount > 0 &&
        lastToolEventIndex > lastTextEventIndex &&
        !(lastStepFinishReason === 'stop' && (stepStartCount > 1 || delegateTaskEmitted)) &&
        !errorAlreadyYielded
      ) {
        log.warn(
          {
            catId: this.catId,
            totalEvents: eventCount,
            textEvents: textEventCount,
            eventTypes: Array.from(uniqueEventTypes),
            lastTextEventIndex,
            lastToolEventIndex,
            latestTool: lastToolTrace?.toolName,
            lastStepFinishReason,
            stepStartCount,
            delegateTaskEmitted,
            textMode: 'replace',
          },
          'OpenCode CLI stopped after tool_use without final text - running no-tool finalizer',
        );
        for await (const finalizerMsg of this.runPostToolFinalizer({
          command: opencodeCommand,
          ...(cwd ? { cwd } : {}),
          childEnv,
          effectiveModel,
          metadata,
          ...((metadata.sessionId ?? options?.sessionId)
            ? { sessionId: metadata.sessionId ?? options?.sessionId }
            : {}),
          trace: lastToolTrace,
          textMode: 'replace',
          options,
        })) {
          if (finalizerMsg.type === 'text') textEventCount++;
          if (finalizerMsg.metadata?.usage != null && resolveCurrentContextUsage(finalizerMsg.metadata.usage) != null) {
            usageTelemetryReceived = true;
          }
          yield finalizerMsg;
        }
      }

      // F212 Phase G (AC-G3, clowder-ai#875): surface silent_completion via cliDiagnostics.
      // Only when eventCount > 0 (CLI actually produced events) AND no other diagnostic
      // already surfaced (don't double-yield on cli error / stream error / timeout — they
      // carry the REAL reasonCode like model_not_found or auth_failed, silent_completion
      // would be a noisy duplicate). Yields BEFORE 'done' so caller sees structured evidence.
      if (eventCount > 0 && textEventCount === 0 && !errorAlreadyYielded && !toolUseEmitted) {
        log.warn(
          { catId: this.catId, totalEvents: eventCount, eventTypes: Array.from(uniqueEventTypes) },
          'OpenCode CLI produced 0 text events — surfacing silent_completion diagnostic',
        );
        const silentDiag = buildSilentCompletionDiagnostic({
          command: 'opencode',
          ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
          eventCount,
          eventTypes: Array.from(uniqueEventTypes),
          ...(effectiveModel ? { model: effectiveModel } : {}),
          ...(metadata.sessionId ? { sessionId: metadata.sessionId } : {}),
          stderrPresent: successfulExitStderr.stderrPresent,
          ...(successfulExitStderr.stderrExcerpt ? { stderrExcerpt: successfulExitStderr.stderrExcerpt } : {}),
        });
        yield {
          type: 'system_info',
          catId: this.catId,
          content: JSON.stringify({
            type: 'silent_completion',
            detail: 'OpenCode CLI 完成但无文字输出（见 cliDiagnostics 详情）',
          }),
          metadata: { ...metadata, cliDiagnostics: silentDiag },
          timestamp: Date.now(),
        };
      }

      // Issue #1208: CodeAgent 3.0 → OpenCode facade translate script may drop
      // token usage. Without usage, invoke-single-cat's F24 context_health path
      // cannot compute fillRatio and auto-handoff silently fails. Surface a
      // persistent visible alert so the user knows automatic handoff is unavailable.
      // Use type='warning' because it is already in system-info-visible.ts and
      // route-helpers.ts USER_FACING_SYSTEM_INFO_TYPES, so it formats and persists.
      if (!usageTelemetryReceived && !errorAlreadyYielded) {
        log.warn(
          { catId: this.catId, totalEvents: eventCount, eventTypes: Array.from(uniqueEventTypes) },
          'OpenCode CLI completed without token usage telemetry — auto-handoff cannot be guaranteed',
        );
        yield {
          type: 'system_info' as const,
          catId: this.catId,
          content: JSON.stringify({
            type: 'warning',
            message: '当前 opencode/CodeAgent 适配器未返回 token 用量，自动 handoff 无法按上下文比例触发。',
          }),
          metadata,
          timestamp: Date.now(),
        };
      }

      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    } catch (err) {
      yield {
        type: 'error',
        catId: this.catId,
        error: err instanceof Error ? err.message : String(err),
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    }
  }

  private async *runPostToolFinalizer(params: OpenCodePostToolFinalizerParams): AsyncIterable<AgentMessage> {
    const boundaryFailure = this.getNoToolFinalizerBoundaryFailure();
    if (boundaryFailure) {
      log.warn(
        { catId: this.catId, invocationId: params.options?.invocationId, reason: boundaryFailure },
        'OpenCode no-tool finalizer blocked before spawn',
      );
      yield {
        type: 'text',
        catId: this.catId,
        content: buildOpenCodePostToolFallbackText(params.trace, boundaryFailure),
        textMode: params.textMode,
        metadata: params.metadata,
        timestamp: Date.now(),
      };
      return;
    }

    const finalizerPrompt = buildOpenCodePostToolFinalizerPrompt(params.trace);
    const finalizerAgent = `${OPENCODE_NO_TOOL_FINALIZER_AGENT}-${randomUUID()}`;
    const finalizerArgs = this.buildNoToolFinalizerArgs(
      finalizerPrompt,
      params.sessionId,
      params.effectiveModel,
      finalizerAgent,
    );
    const finalizerEnv = this.buildNoToolFinalizerEnv(params.childEnv, finalizerAgent);
    const cliOpts = {
      command: params.command,
      args: finalizerArgs,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      env: finalizerEnv,
      ...(params.options?.signal ? { signal: params.options.signal } : {}),
      ...(params.options?.invocationId ? { invocationId: params.options.invocationId } : {}),
      ...(params.options?.cliSessionId ? { cliSessionId: params.options.cliSessionId } : {}),
      ...(params.options?.livenessProbe ? { livenessProbe: params.options.livenessProbe } : {}),
      ...(params.options?.parentSpan ? { parentSpan: params.options.parentSpan } : {}),
      ...(params.options?.invocationId && this.rawArchive.getPath
        ? { rawArchivePath: this.rawArchive.getPath(params.options.invocationId) }
        : {}),
    };

    const events = params.options?.spawnCliOverride
      ? params.options.spawnCliOverride(cliOpts)
      : spawnCli(cliOpts, this.spawnFn ? { spawnFn: this.spawnFn } : undefined);

    const finalizerTextBuffer: AgentMessage[] = [];
    let finalizerPoisoned = false;
    let finalizerErrorReason: string | undefined;
    const finalizerEventTypes = new Set<string>();

    for await (const event of events) {
      if (params.options?.invocationId) {
        this.rawArchive.append(params.options.invocationId, sanitizeRawEvent(event)).catch((err) => {
          log.warn(
            { catId: this.catId, invocationId: params.options?.invocationId, err },
            'Post-tool finalizer raw archive write failed',
          );
        });
      }
      const evtType =
        typeof event === 'object' && event !== null && 'type' in event
          ? String((event as Record<string, unknown>).type)
          : '__unknown';
      finalizerEventTypes.add(evtType);

      if (isCliTimeout(event)) {
        finalizerPoisoned = true;
        finalizerErrorReason = 'timeout';
        log.warn(
          { catId: this.catId, invocationId: params.options?.invocationId, timeoutMs: event.timeoutMs },
          'OpenCode no-tool finalizer timed out',
        );
        continue;
      }
      if (isLivenessWarning(event)) {
        continue;
      }
      if (isCliError(event)) {
        finalizerPoisoned = true;
        finalizerErrorReason = event.reasonCode ?? 'cli_error';
        log.warn(
          { catId: this.catId, invocationId: params.options?.invocationId, reasonCode: event.reasonCode },
          'OpenCode no-tool finalizer exited with an error',
        );
        continue;
      }

      const result = transformOpenCodeEvent(event, this.catId);
      if (result === null) continue;
      if (result.type === 'session_init') {
        if (result.sessionId) params.metadata.sessionId = result.sessionId;
        continue;
      }
      if (result.type === 'tool_use') {
        finalizerPoisoned = true;
        finalizerErrorReason = 'tool_use_blocked';
        log.warn(
          {
            catId: this.catId,
            invocationId: params.options?.invocationId,
            toolName: result.toolName,
          },
          'OpenCode no-tool finalizer attempted to use a tool',
        );
        continue;
      }
      if (result.type === 'error') {
        finalizerPoisoned = true;
        finalizerErrorReason = 'provider_error';
        log.warn(
          { catId: this.catId, invocationId: params.options?.invocationId, error: result.error },
          'OpenCode no-tool finalizer returned an error event',
        );
        continue;
      }
      if (result.type === 'text') {
        if (finalizerPoisoned) continue;
        finalizerTextBuffer.push({
          ...result,
          metadata: params.metadata,
          textMode: finalizerTextBuffer.length === 0 ? params.textMode : result.textMode,
        });
        continue;
      }
      if (result.type === 'agent_loop') {
        yield {
          ...result,
          metadata:
            result.metadata?.usage != null ? { ...params.metadata, usage: result.metadata.usage } : params.metadata,
        };
      }
    }

    if (!finalizerPoisoned && finalizerTextBuffer.length > 0) {
      for (const finalizerText of finalizerTextBuffer) {
        yield finalizerText;
      }
      return;
    }

    if (finalizerTextBuffer.length === 0 || finalizerPoisoned) {
      log.warn(
        {
          catId: this.catId,
          invocationId: params.options?.invocationId,
          eventTypes: Array.from(finalizerEventTypes),
          reason: finalizerErrorReason ?? 'no_text',
          finalizerPoisoned,
        },
        'OpenCode no-tool finalizer produced no usable text - yielding deterministic recovery text',
      );
      yield {
        type: 'text',
        catId: this.catId,
        content: buildOpenCodePostToolFallbackText(params.trace, finalizerErrorReason ?? 'no_text'),
        textMode: params.textMode,
        metadata: params.metadata,
        timestamp: Date.now(),
      };
    }
  }

  private recoverSilentCompletionText(sessionId: string | undefined, messageId: string | undefined): string | null {
    const recovered = recoverOpenCodeSilentCompletion({
      sessionId,
      messageId,
      ...(this.opencodeDbPath ? { overridePath: this.opencodeDbPath } : {}),
    });
    if (recovered.reason && recovered.reason !== 'missing_db' && recovered.reason !== 'no_text') {
      log.warn(
        {
          catId: this.catId,
          sessionIdPrefix: identifierPrefix(sessionId),
          messageIdPrefix: identifierPrefix(messageId),
          dbPathSource: recovered.source,
          reason: recovered.reason,
        },
        'Failed to recover OpenCode silent completion text from local SQLite state',
      );
    }
    return recovered.text;
  }

  private buildNoToolFinalizerArgs(
    prompt: string,
    sessionId: string | undefined,
    model: string,
    finalizerAgent = OPENCODE_NO_TOOL_FINALIZER_AGENT,
  ): string[] {
    const args = ['run', '--pure', '--agent', finalizerAgent];
    if (sessionId) args.push('--session', sessionId);
    if (model) args.push('-m', model);
    args.push('--format', 'json', '--', prompt);
    return args;
  }

  private buildNoToolFinalizerEnv(
    childEnv: Record<string, string | null>,
    finalizerAgent = OPENCODE_NO_TOOL_FINALIZER_AGENT,
  ): Record<string, string | null> {
    return {
      ...childEnv,
      [OPENCODE_CONFIG_CONTENT_ENV]: JSON.stringify(buildOpenCodeNoToolFinalizerConfig(finalizerAgent)),
      [OPENCODE_PERMISSION_ENV]: JSON.stringify(OPENCODE_NO_TOOL_PERMISSION),
    };
  }

  private getNoToolFinalizerBoundaryFailure(): string | null {
    if (hasOpenCodeManagedConfig({ managedConfigPaths: this.opencodeManagedConfigPaths })) {
      return 'managed_config_present';
    }
    return null;
  }

  private buildArgs(
    prompt: string,
    sessionId?: string,
    model?: string,
    cliConfigArgs?: readonly string[],
    defaultAutoApproveFlag?: string,
    readOnly = false,
  ): string[] {
    const args = ['run'];

    if (readOnly) args.push('--pure', '--agent', OPENCODE_READ_ONLY_AGENT);

    // Session resume
    if (sessionId) {
      args.push('--session', sessionId);
    }

    // Model is passed through as-is.
    // Do not silently prepend provider prefixes (e.g. anthropic/, openrouter/).
    // The user-configured model string is the source of truth.
    const effectiveModel = model ?? this.model;
    if (effectiveModel) args.push('-m', effectiveModel);

    // JSON event stream output
    args.push('--format', 'json');
    // Headless OpenCode has no human approval bridge. Use the best approval
    // flag advertised by this installed CLI; older compatible builds may have
    // no supported flag, in which case we preserve the pre-#1065 behavior.
    if (defaultAutoApproveFlag) args.push(defaultAutoApproveFlag);

    // User-defined CLI args from the member editor (#567).
    // User args win when they overlap with system-injected flags.
    const userParts = parseOpenCodeCliConfigArgs(cliConfigArgs);
    const userFlags = new Set(userParts.map(getCliFlagName).filter((flag): flag is string => flag !== null));
    const userControlsAutoApprove = userControlsOpenCodeAutoApprove(userFlags);
    const deduped: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const flagName = getCliFlagName(args[i]);
      if (
        flagName !== null &&
        (userFlags.has(flagName) || (flagName === OPENCODE_AUTO_APPROVE_FLAG && userControlsAutoApprove))
      ) {
        if (i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
        continue;
      }
      deduped.push(args[i]);
    }
    // Keep user-defined flags parseable, then terminate option parsing before
    // the prompt positional. Without `--`, a dash-prefixed prompt is treated as
    // an unknown OpenCode flag and the CLI exits after printing help.
    deduped.push(...userParts, '--', prompt);

    return deduped;
  }

  private async resolveDefaultAutoApproveFlag(
    command: string,
    cwd?: string,
    env?: Record<string, string | null>,
    cliConfigArgs?: readonly string[],
  ): Promise<string | undefined> {
    const userParts = parseOpenCodeCliConfigArgs(cliConfigArgs);
    const userFlags = new Set(userParts.map(getCliFlagName).filter((flag): flag is string => flag !== null));
    if (userControlsOpenCodeAutoApprove(userFlags)) return undefined;

    const result = await this.getAutoApproveProbe(command, cwd, env);
    if (result.warning) {
      log.warn(
        { catId: this.catId, command, warning: result.warning },
        'OpenCode auto-approval flag unavailable; continuing without default flag',
      );
    }
    return result.approvalFlag;
  }

  private getAutoApproveProbe(
    command: string,
    cwd?: string,
    env?: Record<string, string | null>,
  ): Promise<OpenCodeAutoApproveProbeResult> {
    if (this.autoApproveProbeFn) {
      this.autoApproveProbe ??= cacheOpenCodeAutoApproveProbe(
        this.autoApproveProbeFn({ command, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) }),
        (promise) => {
          if (this.autoApproveProbe === promise) this.autoApproveProbe = undefined;
        },
      );
      return this.autoApproveProbe;
    }
    // Unit tests inject spawnFn to own the primary CLI process lifecycle. Do not
    // consume that mock for the preflight probe unless the test provides an
    // explicit autoApproveProbeFn.
    if (this.spawnFn) return Promise.resolve({ approvalFlag: OPENCODE_AUTO_APPROVE_FLAG });

    sharedOpenCodeAutoApproveProbe ??= cacheOpenCodeAutoApproveProbe(
      probeOpenCodeAutoApproveSupport(command, cwd, env),
      (promise) => {
        if (sharedOpenCodeAutoApproveProbe === promise) sharedOpenCodeAutoApproveProbe = undefined;
      },
    );
    return sharedOpenCodeAutoApproveProbe;
  }

  private buildEnv(callbackEnv?: Record<string, string>): Record<string, string | null> {
    const env: Record<string, string | null> = { ...callbackEnv };

    // clowder-ai#223: When OPENCODE_CONFIG is set (custom provider via runtime config file),
    // credentials are injected via {env:CAT_CAFE_OC_*} substitution in the config.
    // Clear anthropic env vars to prevent opencode from using the builtin anthropic provider.
    //
    // F203 Phase I exception: instructions-only configs (no custom provider block) must NOT
    // clear auth — the cat still needs native Anthropic or subscription credentials.
    // The `OC_INSTRUCTIONS_ONLY_ENV` signal distinguishes L0-only from full custom-provider.
    if (callbackEnv?.OPENCODE_CONFIG && !callbackEnv?.[OC_INSTRUCTIONS_ONLY_ENV]) {
      env[ANTHROPIC_API_KEY_ENV] = null;
      env[ANTHROPIC_BASE_URL_ENV] = null;
      env[OPENCODE_API_KEY_ENV] = null;
      env.OPENCODE_BASE_URL = null;
      return env;
    }

    const profileMode = callbackEnv?.CAT_CAFE_ANTHROPIC_PROFILE_MODE;

    // Subscription mode must not inherit API-key credentials from parent env.
    if (profileMode === 'subscription') {
      env[ANTHROPIC_API_KEY_ENV] = null;
      env[ANTHROPIC_BASE_URL_ENV] = null;
      env[OPENCODE_API_KEY_ENV] = null;
      env.OPENCODE_BASE_URL = null;
      return env;
    }

    // API key: callbackEnv > constructor > process.env
    const apiKey = callbackEnv?.CAT_CAFE_ANTHROPIC_API_KEY ?? callbackEnv?.[OPENCODE_API_KEY_ENV] ?? this.apiKey;
    if (apiKey) {
      env[ANTHROPIC_API_KEY_ENV] = apiKey;
    }

    // Base URL: callbackEnv > constructor > process.env
    // Pass through as-is — user configures the exact URL expected by their endpoint.
    // opencode CLI calls {ANTHROPIC_BASE_URL}/messages directly.
    const rawBaseUrl = callbackEnv?.CAT_CAFE_ANTHROPIC_BASE_URL ?? this.baseUrl;
    if (rawBaseUrl) {
      env[ANTHROPIC_BASE_URL_ENV] = rawBaseUrl;
    }

    // Clean up intermediate env vars (don't leak to child)
    env[OPENCODE_API_KEY_ENV] = null;
    env.OPENCODE_BASE_URL = null;

    return env;
  }
}
