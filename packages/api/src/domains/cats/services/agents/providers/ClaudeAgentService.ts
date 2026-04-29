/**
 * Claude Agent Service
 * 使用 Claude CLI 子进程调用布偶猫 (Opus)
 *
 * CLI 调用方式:
 *   claude -p "..." --output-format stream-json --verbose
 *     --permission-mode acceptEdits
 *     [--model <model>]
 *     [--resume <sessionId>]
 *
 * NDJSON 事件格式:
 *   system/init  → session_init (含 session_id)
 *   assistant    → text / tool_use (content blocks)
 *   result/error → error
 *   result/success → 跳过 (done 在循环后 yield)
 */

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatEffort } from '../../../../../config/cat-config-loader.js';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../types.js';
import { appendLocalImagePathHints, collectImageAccessDirectories } from '../providers/image-cli-bridge.js';
import { extractImagePaths } from '../providers/image-paths.js';
import { findGitBashPath } from './claude-agent-win.js';
import { extractClaudeUsage, isResultErrorEvent, transformClaudeEvent } from './claude-ndjson-parser.js';

const log = createModuleLogger('claude-agent');

const PERMISSION_MODE = 'bypassPermissions';

const ANTHROPIC_PROFILE_MODE_KEY = 'CAT_CAFE_ANTHROPIC_PROFILE_MODE';
const ANTHROPIC_PROFILE_API_KEY = 'CAT_CAFE_ANTHROPIC_API_KEY';
const ANTHROPIC_PROFILE_BASE_URL = 'CAT_CAFE_ANTHROPIC_BASE_URL';
const ANTHROPIC_MODEL_OVERRIDE_KEY = 'CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE';

function isKnownAnthropicModel(model: string): boolean {
  return model.startsWith('claude-');
}

function isInvalidThinkingSignatureMessage(message: string | undefined): boolean {
  if (!message) return false;
  return /Invalid [`'"]?signature[`'"]? in [`'"]?thinking[`'"]? block/i.test(message);
}

function formatThinkingSignatureRescueError(sessionId: string | undefined): string {
  const command = sessionId
    ? `pnpm rescue:claude:thinking -- --session ${sessionId}`
    : 'pnpm rescue:claude:thinking -- --all-broken';
  return [
    'Claude CLI: 检测到损坏的 thinking signature，当前会话无法 --resume。',
    `请先在仓库根目录运行 ${command}，再重试。`,
  ].join(' ');
}

const IS_WINDOWS = process.platform === 'win32';

export { pickGitBashPathFromWhere } from './claude-agent-win.js';

function buildClaudeEnvOverrides(callbackEnv?: Record<string, string>): Record<string, string | null> {
  const env: Record<string, string | null> = { ...(callbackEnv ?? {}) };

  env.CLAUDECODE = null;
  env.CLAUDE_CODE_ENTRYPOINT = null;

  if (IS_WINDOWS) {
    const gitBash = findGitBashPath();
    if (gitBash) {
      env.CLAUDE_CODE_GIT_BASH_PATH = gitBash;
    }
  }

  const mode = callbackEnv?.[ANTHROPIC_PROFILE_MODE_KEY];
  if (mode === 'api_key') {
    const apiKey = callbackEnv?.[ANTHROPIC_PROFILE_API_KEY]?.trim();
    const baseUrl = callbackEnv?.[ANTHROPIC_PROFILE_BASE_URL]?.trim();
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
    if (baseUrl) {
      // Claude CLI internally appends /v1 to the base URL.
      // If the user configured it with /v1 already, strip it to prevent
      // double /v1/v1 and to avoid the CLI's model validation against
      // the /v1/models endpoint (which many proxies don't support).
      const cleanUrl = baseUrl.replace(/\/v1\/?$/, '');
      env.ANTHROPIC_BASE_URL = cleanUrl;
    }

    // Third-party Anthropic-compatible APIs (e.g. BigModel, MaaS) may expose
    // non-Anthropic model names such as glm-5. Claude CLI accepts those via
    // ANTHROPIC_MODEL, but ONLY when --model is omitted. Passing --model wins
    // over env-based aliases/defaults, so the provider layer must suppress the
    // flag for custom provider models.
    const modelOverride = callbackEnv?.[ANTHROPIC_MODEL_OVERRIDE_KEY]?.trim();
    const effectiveModel = modelOverride || undefined;
    if (effectiveModel && !isKnownAnthropicModel(effectiveModel)) {
      env.ANTHROPIC_MODEL = effectiveModel;
    }
  } else if (mode === 'subscription') {
    // Subscription mode must not inherit shell-level Anthropic credentials.
    // Claude CLI should read auth from ~/.claude/settings.json instead.
    env.ANTHROPIC_API_KEY = null;
    env.ANTHROPIC_BASE_URL = null;
    env.ANTHROPIC_MODEL = null;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = null;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = null;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = null;
  }
  return env;
}

/**
 * Options for constructing ClaudeAgentService (dependency injection)
 * F32-b: catId is now a constructor parameter (defaults to 'opus' for backward compat)
 */
interface ClaudeAgentServiceOptions {
  /** F32-b: catId for this instance (default: 'opus') */
  catId?: CatId;
  /** Inject a custom spawn function (for testing) */
  spawnFn?: SpawnFn;
  /** Model override (default: resolved via getCatModel) */
  model?: string;
  /** Absolute path to MCP server entry (dist/index.js) for --mcp-config */
  mcpServerPath?: string;
}

/**
 * Resolve default MCP server path for monorepo layouts.
 * Supports API started from:
 * - repo root (cwd=.../cat-cafe)
 * - packages/api (cwd=.../cat-cafe/packages/api)
 * - API dist/src subdirs in some tooling (best-effort fallback)
 */
export function resolveDefaultClaudeMcpServerPath(cwd = process.cwd()): string | undefined {
  const candidates = [
    resolve(cwd, '../mcp-server/dist/index.js'),
    resolve(cwd, 'packages/mcp-server/dist/index.js'),
    resolve(cwd, '../../packages/mcp-server/dist/index.js'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Service for invoking Claude via CLI subprocess.
 * Uses Max plan subscription instead of API key.
 */
export class ClaudeAgentService implements AgentService {
  readonly catId: CatId;
  private readonly spawnFn: SpawnFn | undefined;
  private readonly model: string;
  private readonly mcpServerPath: string | undefined;
  /** Windows: cached MCP config file path (created once per instance, reused across invocations) */
  private mcpConfigFilePath: string | undefined;

  constructor(options?: ClaudeAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('opus');
    this.spawnFn = options?.spawnFn;
    // F32-b: model from options > env (getCatModel) > default
    this.model = options?.model ?? getCatModel(this.catId as string);
    const configuredPath = options?.mcpServerPath ?? process.env.CAT_CAFE_MCP_SERVER_PATH;
    if (configuredPath && configuredPath.trim().length > 0) {
      this.mcpServerPath = isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
    } else {
      this.mcpServerPath = resolveDefaultClaudeMcpServerPath();
    }
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    let effectivePrompt = prompt;
    const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
    const imageAccessDirs = collectImageAccessDirectories(imagePaths);
    // Claude CLI print mode has no direct image attach flag; provide path hints and grant dir access.
    effectivePrompt = appendLocalImagePathHints(effectivePrompt, imagePaths);

    // Profile-level model override (e.g. "opus[1m]") takes precedence over constructor model
    const effectiveModel = options?.callbackEnv?.[ANTHROPIC_MODEL_OVERRIDE_KEY]?.trim() || this.model;
    const isApiKeyMode = options?.callbackEnv?.[ANTHROPIC_PROFILE_MODE_KEY] === 'api_key';
    const useEnvModelOverride = isApiKeyMode && !isKnownAnthropicModel(effectiveModel);
    const args: string[] = [
      '-p',
      effectivePrompt,
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--effort',
      getCatEffort(this.catId as string, undefined, 'anthropic'),
      '--permission-mode',
      PERMISSION_MODE,
      // api_key mode: skip user-level ~/.claude/settings.json to prevent config pollution.
      // subscription mode: include user-level so CLI reads auth from ~/.claude/settings.json.
      '--setting-sources',
      isApiKeyMode ? 'project,local' : 'project,local,user',
      // Enable Chrome MCP integration (built-in, requires Chrome + extension running)
      '--chrome',
    ];

    // Only pass --model for known Anthropic models. For third-party models
    // (e.g. glm-5 via BigModel/DashScope), ANTHROPIC_MODEL env var is set in
    // buildClaudeEnvOverrides() and --model must be omitted so the CLI honours it.
    // Empty model (OAuth without explicit model) → let CLI use its default.
    if (!useEnvModelOverride && effectiveModel) {
      args.splice(6, 0, '--model', effectiveModel);
    }

    // Inject static identity via --append-system-prompt (separate from -p content)
    if (options?.systemPrompt) {
      args.push('--append-system-prompt', options.systemPrompt);
    }

    if (options?.sessionId) {
      args.push('--resume', options.sessionId);
    }
    for (const dir of imageAccessDirs) {
      args.push('--add-dir', dir);
    }

    // Add MCP server config when callback env is present
    // On Windows, Claude CLI treats inline JSON as a file path — write to temp file instead.
    // The file is cached per-instance so concurrent invocations share one file (no temp spam).
    if (options?.callbackEnv && this.mcpServerPath) {
      if (IS_WINDOWS) {
        if (!this.mcpConfigFilePath || !existsSync(this.mcpConfigFilePath)) {
          const dir = mkdtempSync(join(tmpdir(), 'cat-cafe-mcp-'));
          this.mcpConfigFilePath = join(dir, 'mcp-config.json');
          writeFileSync(
            this.mcpConfigFilePath,
            JSON.stringify({
              mcpServers: {
                'cat-cafe': { command: 'node', args: [this.mcpServerPath] },
              },
            }),
            'utf-8',
          );
        }
        args.push('--mcp-config', this.mcpConfigFilePath);
      } else {
        args.push(
          '--mcp-config',
          JSON.stringify({
            mcpServers: {
              'cat-cafe': { command: 'node', args: [this.mcpServerPath] },
            },
          }),
        );
      }
    }

    // User-defined CLI args from the member editor (#567).
    // User flags win when they overlap with system-injected flags.
    const userParts: string[] = [];
    for (const arg of options?.cliConfigArgs ?? []) {
      userParts.push(...arg.trim().split(/\s+/));
    }
    if (userParts.length > 0) {
      const accumulativeFlags = new Set(['--add-dir']);
      const userFlags = new Set(userParts.filter((p) => p.startsWith('-')));
      const deduped: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('-') && userFlags.has(args[i]) && !accumulativeFlags.has(args[i])) {
          if (i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
          continue;
        }
        deduped.push(args[i]);
      }
      args.length = 0;
      args.push(...deduped, ...userParts);
    }

    const metadata: MessageMetadata = { provider: 'anthropic', model: effectiveModel };
    const streamState = {
      partialTextMessageIds: new Set<string>(),
      currentMessageId: undefined as string | undefined,
      lastTurnInputTokens: undefined as number | undefined,
      thinkingBuffer: '' as string,
    };

    try {
      const claudeCommand = resolveCliCommand('claude');
      log.info({ catId: this.catId, resolved: claudeCommand ?? null }, 'Resolving claude CLI command');
      if (!claudeCommand) {
        log.warn({ catId: this.catId }, 'Claude CLI not found');
        yield {
          type: 'error' as const,
          catId: this.catId,
          error: formatCliNotFoundError('claude'),
          metadata,
          timestamp: Date.now(),
        };
        yield { type: 'done' as const, catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }

      let sawResultError = false;
      const envOverrides = buildClaudeEnvOverrides(options?.callbackEnv);
      // F171: Account env vars applied LAST — user overrides provider-injected values
      if (options?.accountEnv) {
        for (const [k, v] of Object.entries(options.accountEnv)) envOverrides[k] = v;
      }

      // Debug: log full invocation details (env values redacted by pino redact paths)
      const safeEnvSummary: Record<string, string> = {};
      for (const [k, v] of Object.entries(envOverrides)) {
        if (v === null) {
          safeEnvSummary[k] = '(cleared)';
        } else if (/key|secret|token|password|cookie|auth|session|bearer|credential/i.test(k)) {
          safeEnvSummary[k] = v.slice(0, 6) + '***';
        } else {
          safeEnvSummary[k] = v;
        }
      }
      log.debug(
        {
          catId: this.catId,
          command: claudeCommand,
          model: effectiveModel,
          sessionId: options?.sessionId,
          invocationId: options?.invocationId,
          cwd: options?.workingDirectory,
          envOverrides: safeEnvSummary,
          argCount: args.length,
        },
        'Invoking Claude CLI',
      );

      const cliOpts = {
        command: claudeCommand,
        args,
        ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
        env: envOverrides,
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
        ...(options?.parentSpan ? { parentSpan: options.parentSpan } : {}),
      };
      const events = options?.spawnCliOverride
        ? options.spawnCliOverride(cliOpts)
        : spawnCli(cliOpts, this.spawnFn ? { spawnFn: this.spawnFn } : undefined);

      let eventCount = 0;
      let textEventCount = 0;
      for await (const event of events) {
        eventCount++;
        const evtType =
          typeof event === 'object' && event !== null && 'type' in event
            ? String((event as Record<string, unknown>).type)
            : '__unknown';
        log.debug({ catId: this.catId, eventIndex: eventCount, type: evtType }, 'CLI event received');
        if (isCliTimeout(event)) {
          // F118 AC-C3: Forward timeout diagnostics before error
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
            error: `布偶猫 CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s${event.firstEventAt == null ? ', 未收到首帧' : ''})`,
            metadata,
            timestamp: Date.now(),
          };
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
            '[ClaudeAgent] liveness warning — CLI may be stuck',
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
          if (sawResultError) continue;
          const error =
            event.reasonCode === 'invalid_thinking_signature'
              ? formatThinkingSignatureRescueError(options?.sessionId)
              : formatCliExitError('Claude CLI', event);
          yield {
            type: 'error',
            catId: this.catId,
            error,
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }

        // F8: Capture usage from result/success events before transform drops them
        const rawEvt = event as Record<string, unknown>;
        if (rawEvt.type === 'result' && rawEvt.subtype === 'success') {
          metadata.usage = extractClaudeUsage(rawEvt);
          // F24-fix: Attach per-turn input from last message_start for context health
          if (streamState.lastTurnInputTokens != null && metadata.usage) {
            metadata.usage.lastTurnInputTokens = streamState.lastTurnInputTokens;
          }
        }

        const fromResultError = isResultErrorEvent(event);
        let result = transformClaudeEvent(event, this.catId, streamState);
        if (result === null) {
          log.debug({ catId: this.catId, eventIndex: eventCount, rawType: evtType }, 'Event dropped by transform');
          continue;
        }

        if (Array.isArray(result)) {
          for (const msg of result) {
            if (msg.type === 'text') textEventCount++;
            // Capture sessionId into metadata
            if (msg.type === 'session_init' && msg.sessionId) {
              metadata.sessionId = msg.sessionId;
            }
            yield { ...msg, metadata };
          }
        } else {
          if (result.type === 'session_init' && result.sessionId) {
            metadata.sessionId = result.sessionId;
          }
          if (fromResultError && result.type === 'error') {
            if (isInvalidThinkingSignatureMessage(result.error)) {
              result = {
                ...result,
                error: formatThinkingSignatureRescueError(options?.sessionId),
              };
            }
            sawResultError = true;
          }
          if (result.type === 'text') textEventCount++;
          yield { ...result, metadata };
        }
      }

      log.info(
        { catId: this.catId, totalEvents: eventCount, textEvents: textEventCount, sessionId: metadata.sessionId },
        'Claude CLI invocation completed',
      );
      if (textEventCount === 0) {
        log.warn(
          { catId: this.catId, totalEvents: eventCount },
          'Claude CLI produced 0 text events — will show as silent_completion',
        );
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
      // Guarantee done after error so invoke-single-cat can set isFinal correctly
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    }
  }
}
