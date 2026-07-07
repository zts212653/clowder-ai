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

import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { buildCliDiagnostics, buildSilentCompletionDiagnostic } from '../../../../../utils/cli-diagnostics.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import { CliRawArchive } from '../../session/CliRawArchive.js';
import type { AgentMessage, AgentServiceOptions, L0InjectableAgentService, MessageMetadata } from '../../types.js';
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
  l0CompilerFn?: (options: { catId: string; outPath?: string }) => Promise<string>;
  /** Test seam for the `opencode run --help` auto-approval capability probe. */
  autoApproveProbeFn?: OpenCodeAutoApproveProbeFn;
}

const OPENCODE_API_KEY_ENV = 'OPENCODE_API_KEY';
const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';
const ANTHROPIC_BASE_URL_ENV = 'ANTHROPIC_BASE_URL';
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

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    // P1-2: runtime model override takes precedence over constructor model
    const effectiveModel = options?.callbackEnv?.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE ?? this.model;
    const cwd = options?.workingDirectory;
    const childEnv = this.buildEnv(options?.callbackEnv);
    // F171: Account env vars applied LAST — user overrides provider-injected values
    if (options?.accountEnv) {
      for (const [k, v] of Object.entries(options.accountEnv)) childEnv[k] = v;
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

      const defaultAutoApproveFlag = await this.resolveDefaultAutoApproveFlag(
        opencodeCommand,
        cwd,
        childEnv,
        options?.cliConfigArgs,
      );
      const args = this.buildArgs(
        prompt,
        options?.sessionId,
        effectiveModel,
        options?.cliConfigArgs,
        defaultAutoApproveFlag,
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
          if (result.type === 'text') textEventCount++;
          if (result.type === 'tool_use') toolUseEmitted = true;
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
            if (rawError?.data?.message) {
              const cliDiagnostics = buildCliDiagnostics({
                rawText: rawError.data.message,
                debugRef: {
                  command: 'opencode',
                  exitCode: null,
                  signal: null,
                  ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
                },
              });
              yieldMetadata = { ...metadata, cliDiagnostics };
            }
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
          yield { ...result, metadata: mergedMetadata };
        }
      }

      log.info(
        { catId: this.catId, totalEvents: eventCount, textEvents: textEventCount, sessionId: metadata.sessionId },
        'OpenCode CLI invocation completed',
      );
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

  private buildArgs(
    prompt: string,
    sessionId?: string,
    model?: string,
    cliConfigArgs?: readonly string[],
    defaultAutoApproveFlag?: string,
  ): string[] {
    const args = ['run'];

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
    deduped.push(...userParts, prompt);

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
