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
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../types.js';
import { transformOpenCodeEvent } from './opencode-event-transform.js';

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
}

const OPENCODE_API_KEY_ENV = 'OPENCODE_API_KEY';
const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';
const ANTHROPIC_BASE_URL_ENV = 'ANTHROPIC_BASE_URL';

export class OpenCodeAgentService implements AgentService {
  readonly catId: CatId;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly spawnFn: SpawnFn | undefined;

  constructor(options?: OpenCodeAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('opencode');
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.apiKey = options?.apiKey;
    this.baseUrl = options?.baseUrl;
    this.spawnFn = options?.spawnFn;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    // P1-2: runtime model override takes precedence over constructor model
    const effectiveModel = options?.callbackEnv?.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE ?? this.model;
    const args = this.buildArgs(prompt, options?.sessionId, effectiveModel, options?.cliConfigArgs);
    const cwd = options?.workingDirectory;
    const childEnv = this.buildEnv(options?.callbackEnv);
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

      const cliOpts = {
        command: opencodeCommand,
        args,
        ...(cwd ? { cwd } : {}),
        env: childEnv,
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
      };
      const events = options?.spawnCliOverride
        ? options.spawnCliOverride(cliOpts)
        : spawnCli(cliOpts, this.spawnFn ? { spawnFn: this.spawnFn } : undefined);

      for await (const event of events) {
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
            error: `opencode CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s)`,
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        // F118 Phase C: Forward liveness warnings to frontend with catId
        if (isLivenessWarning(event)) {
          yield {
            type: 'system_info' as const,
            catId: this.catId,
            content: JSON.stringify({ type: 'liveness_warning', ...event }),
            timestamp: Date.now(),
          };
          continue;
        }
        if (isCliError(event)) {
          yield {
            type: 'error',
            catId: this.catId,
            error: formatCliExitError('opencode CLI', event),
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }

        const result = transformOpenCodeEvent(event, this.catId);
        if (result !== null) {
          // P2-1: Only emit the first session_init; subsequent step_start events
          // in multi-step runs are silently dropped to avoid duplicate session metrics.
          if (result.type === 'session_init') {
            if (sessionInitEmitted) continue;
            sessionInitEmitted = true;
            if (result.sessionId) metadata.sessionId = result.sessionId;
          }
          yield { ...result, metadata };
        }
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

  private buildArgs(prompt: string, sessionId?: string, model?: string, cliConfigArgs?: readonly string[]): string[] {
    const args = ['run'];

    // Session resume
    if (sessionId) {
      args.push('--session', sessionId);
    }

    // Model is passed through as-is.
    // Do not silently prepend provider prefixes (e.g. anthropic/, openrouter/).
    // The user-configured model string is the source of truth.
    const effectiveModel = model ?? this.model;
    args.push('-m', effectiveModel);

    // JSON event stream output
    args.push('--format', 'json');

    // User-defined CLI args from the member editor.
    // Each entry is passed as-is (e.g. "--variant low" → args.push('--variant', 'low')).
    // No implicit mapping — the user writes the exact flags the CLI expects.
    for (const arg of cliConfigArgs ?? []) {
      const parts = arg.trim().split(/\s+/);
      args.push(...parts);
    }

    // Prompt as positional arg
    args.push(prompt);

    return args;
  }

  private buildEnv(callbackEnv?: Record<string, string>): Record<string, string | null> {
    const env: Record<string, string | null> = { ...callbackEnv };

    // F189: When OPENCODE_CONFIG is set (custom provider via runtime config file),
    // credentials are injected via {env:CAT_CAFE_OC_*} substitution in the config.
    // Clear anthropic env vars to prevent opencode from using the builtin anthropic provider.
    if (callbackEnv?.OPENCODE_CONFIG) {
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
