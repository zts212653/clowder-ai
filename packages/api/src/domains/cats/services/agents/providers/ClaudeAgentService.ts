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

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatEffort } from '../../../../../config/cat-config-loader.js';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import { CliRawArchive } from '../../session/CliRawArchive.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../types.js';
import type { RawArchiveSink } from '../providers/codex-audit-hooks.js';
import { sanitizeRawEvent } from '../providers/codex-audit-hooks.js';
import { appendLocalImagePathHints, collectImageAccessDirectories } from '../providers/image-cli-bridge.js';
import { extractImagePaths } from '../providers/image-paths.js';
import { findGitBashPath } from './claude-agent-win.js';
import { extractClaudeUsage, isResultErrorEvent, transformClaudeEvent } from './claude-ndjson-parser.js';
import { compileL0ViaSubprocess } from './l0-compiler.js';

const log = createModuleLogger('claude-agent');

const PERMISSION_MODE = 'bypassPermissions';
const RESERVED_SYSTEM_PROMPT_FLAGS = new Set([
  '--system-prompt-file',
  '--system-prompt',
  '--append-system-prompt',
  '--append-system-prompt-file',
]);

// F198: exported so other Claude carriers (e.g. ClaudeBgCarrierService) can
// reuse the single source of truth for profile mode routing.
export const ANTHROPIC_PROFILE_MODE_KEY = 'CAT_CAFE_ANTHROPIC_PROFILE_MODE';
const ANTHROPIC_PROFILE_API_KEY = 'CAT_CAFE_ANTHROPIC_API_KEY';
const ANTHROPIC_PROFILE_BASE_URL = 'CAT_CAFE_ANTHROPIC_BASE_URL';
// F198: exported so ClaudeBgCarrierService and other carriers can reuse the
// same model-override env key (single source of truth).
export const ANTHROPIC_MODEL_OVERRIDE_KEY = 'CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE';

// F198: exported for reuse in resolveClaudeModelSelection consumers.
export function isKnownAnthropicModel(model: string): boolean {
  return model.startsWith('claude-');
}

/**
 * Resolve the effective Claude model + whether the `--model` flag should be
 * OMITTED at spawn time.
 *
 * Selection rules (single source of truth for Claude carriers — F198 codex
 * round-7 B-prime refactor):
 * 1. effectiveModel = callbackEnv[MODEL_OVERRIDE_KEY] || fallbackModel
 *    (per-invocation override beats constructor model)
 * 2. useEnvModelOverride = api_key mode AND model is non-Anthropic
 *    (e.g. glm-5 via api_key) — in this case the CLI's `--model` flag wins
 *    over ANTHROPIC_MODEL env, so we must omit `--model` and let env drive.
 *
 * Carriers should pass `effectiveModel` via `--model` only when
 * `useEnvModelOverride === false`. When `true`, env (ANTHROPIC_MODEL) is the
 * source of truth and the flag must be omitted to avoid silently overriding
 * the proxy-routed model.
 */
export function resolveClaudeModelSelection(
  callbackEnv: Record<string, string> | undefined,
  fallbackModel: string,
): { effectiveModel: string; useEnvModelOverride: boolean } {
  const effectiveModel = callbackEnv?.[ANTHROPIC_MODEL_OVERRIDE_KEY]?.trim() || fallbackModel;
  const isApiKeyMode = callbackEnv?.[ANTHROPIC_PROFILE_MODE_KEY] === 'api_key';
  const useEnvModelOverride = isApiKeyMode && !isKnownAnthropicModel(effectiveModel);
  return { effectiveModel, useEnvModelOverride };
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

function stripReservedSystemPromptArgs(args: string[], catId: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eqIdx = arg.indexOf('=');
    const flag = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
    if (RESERVED_SYSTEM_PROMPT_FLAGS.has(flag)) {
      log.warn({ catId, flag }, 'cliConfigArgs override of reserved Claude system prompt flag dropped');
      if (eqIdx < 0 && i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function removeL0TempDir(l0Path: string | undefined): void {
  if (!l0Path) return;
  const l0Dir = dirname(l0Path);
  try {
    rmSync(l0Dir, { recursive: true, force: true });
  } catch (err) {
    log.warn({ err, l0Dir }, 'Failed to remove Claude L0 temp directory');
  }
}

/**
 * Build env overrides for spawning the `claude` CLI.
 *
 * F198: exported as the single source of truth for Claude carrier env logic.
 * ClaudeBgCarrierService reuses this instead of re-implementing 80% of the
 * rules — eliminates the round-by-round 补锅 pattern where new carriers
 * forget some production-tested invariant.
 *
 * Handles:
 * - CLAUDECODE / CLAUDE_CODE_ENTRYPOINT strip (entrypoint=cli invariant)
 * - Windows git bash path resolution
 * - subscription mode → strip all ANTHROPIC_* (avoid silent api_key billing)
 * - api_key mode → inject ANTHROPIC_API_KEY / BASE_URL / model override
 */
export function buildClaudeEnvOverrides(callbackEnv?: Record<string, string>): Record<string, string | null> {
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
  /** Test seam — replaces the real L0 compiler subprocess. */
  l0CompilerFn?: typeof compileL0ViaSubprocess;
  /** #780: Raw NDJSON archive sink (default: CliRawArchive to disk) */
  rawArchive?: RawArchiveSink;
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
  /** F203: compiles per-cat L0 → file for --system-prompt-file. */
  private readonly l0CompilerFn: typeof compileL0ViaSubprocess;
  /** Windows: cached MCP config file path (created once per instance, reused across invocations) */
  private mcpConfigFilePath: string | undefined;
  /** #780: Raw NDJSON archive for post-mortem diagnostics */
  private readonly rawArchive: RawArchiveSink;

  constructor(options?: ClaudeAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('opus');
    this.spawnFn = options?.spawnFn;
    this.rawArchive = options?.rawArchive ?? new CliRawArchive();
    this.l0CompilerFn = options?.l0CompilerFn ?? compileL0ViaSubprocess;
    // F32-b: model from options > env (getCatModel) > default
    this.model = options?.model ?? getCatModel(this.catId as string);
    const configuredPath = options?.mcpServerPath ?? process.env.CAT_CAFE_MCP_SERVER_PATH;
    if (configuredPath && configuredPath.trim().length > 0) {
      this.mcpServerPath = isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
    } else {
      this.mcpServerPath = resolveDefaultClaudeMcpServerPath();
    }
  }

  injectsL0Natively(): boolean {
    return true;
  }

  private async compileL0ToTempFile(): Promise<string> {
    const l0Dir = mkdtempSync(join(tmpdir(), 'cat-cafe-l0-'));
    const l0Path = join(l0Dir, 'system-prompt-l0.md');
    try {
      await this.l0CompilerFn({ catId: this.catId as string, outPath: l0Path });
    } catch (err) {
      removeL0TempDir(l0Path);
      throw new Error(`L0 compile failed for ${this.catId as string}: ${(err as Error).message}`);
    }
    return l0Path;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    let effectivePrompt = prompt;
    const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
    const imageAccessDirs = collectImageAccessDirectories(imagePaths);
    // Claude CLI print mode has no direct image attach flag; provide path hints and grant dir access.
    effectivePrompt = appendLocalImagePathHints(effectivePrompt, imagePaths);

    // F198 B-prime refactor: model selection delegates to shared helper so
    // ClaudeBgCarrierService reuses the same rules (single source of truth).
    const { effectiveModel, useEnvModelOverride } = resolveClaudeModelSelection(options?.callbackEnv, this.model);
    const isApiKeyMode = options?.callbackEnv?.[ANTHROPIC_PROFILE_MODE_KEY] === 'api_key';
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

    const metadata: MessageMetadata = { provider: 'anthropic', model: effectiveModel };
    const streamState = {
      partialTextMessageIds: new Set<string>(),
      currentMessageId: undefined as string | undefined,
      lastTurnInputTokens: undefined as number | undefined,
      thinkingBuffer: '' as string,
    };

    let l0Path: string | undefined;
    try {
      l0Path = await this.compileL0ToTempFile();
      args.push('--system-prompt-file', l0Path);
      // Route layer passes pack-only systemPrompt for native-L0 providers.
      // Keep it as an append layer, but never use it as the carrier's L0 source.
      if (options?.systemPrompt) args.push('--append-system-prompt', options.systemPrompt);

      // User-defined CLI args from the member editor (#567).
      // User flags win when they overlap with ordinary system-injected flags,
      // but native L0 flags are reserved: user overrides would silently remove
      // the compression-immune identity/governance layer.
      const cliConfigArgs = options?.cliConfigArgs;
      const userParts = stripReservedSystemPromptArgs(
        cliConfigArgs ? cliConfigArgs.flatMap((arg) => arg.trim().split(/\s+/)) : [],
        this.catId as string,
      );
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
        ...(options?.invocationId && this.rawArchive.getPath
          ? { rawArchivePath: this.rawArchive.getPath(options.invocationId) }
          : {}),
      };
      const events = options?.spawnCliOverride
        ? options.spawnCliOverride(cliOpts)
        : spawnCli(cliOpts, this.spawnFn ? { spawnFn: this.spawnFn } : undefined);

      let eventCount = 0;
      let textEventCount = 0;
      // F215: Track assistant event presence and content blocks (reset per assistant event).
      //
      // hasAssistantEvent: model generated a response (needed to distinguish "empty invocation" from "malformed").
      // lastAssistantHasToolUseBlock: LAST assistant content has a valid tool_use block.
      //   Per-turn (not global): an earlier turn's tool_use must not suppress detection on a later malformed turn.
      // lastAssistantHasTextBlock: LAST assistant content has a text block.
      //   Checked from content blocks directly (not from text event counts) so streaming mode is handled
      //   correctly: --include-partial-messages sends text_delta BEFORE the assistant event, and
      //   transformClaudeEvent suppresses the final assistant text to avoid duplicates. The content block
      //   is present in either mode, so this flag is reliable regardless of streaming vs non-streaming.
      let hasAssistantEvent = false;
      let lastAssistantHasToolUseBlock = false;
      let lastAssistantHasTextBlock = false;
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
        log.debug({ catId: this.catId, eventIndex: eventCount, type: evtType }, 'CLI event received');
        // F215: Inspect assistant events for content blocks (before transformClaudeEvent runs).
        // Reset per-turn tracking on each new assistant event so multi-turn tool-using sessions are handled
        // correctly: an earlier turn's blocks must not suppress detection on a later malformed turn.
        if (evtType === 'assistant') {
          hasAssistantEvent = true;
          lastAssistantHasToolUseBlock = false;
          lastAssistantHasTextBlock = false;
          const rawEvtCheck = event as Record<string, unknown>;
          const msgCheck = rawEvtCheck.message as Record<string, unknown> | undefined;
          const contentCheck = msgCheck?.content;
          if (Array.isArray(contentCheck)) {
            lastAssistantHasToolUseBlock = contentCheck.some(
              (b) =>
                b &&
                typeof b === 'object' &&
                (b as Record<string, unknown>).type === 'tool_use' &&
                typeof (b as Record<string, unknown>).name === 'string',
            );
            lastAssistantHasTextBlock = contentCheck.some(
              (b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text',
            );
          }
        }
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
            // F212 Phase A (云端 codex P2): timeout cliDiagnostics 也透传到 metadata.
            metadata: event.cliDiagnostics ? { ...metadata, cliDiagnostics: event.cliDiagnostics } : metadata,
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
          // F212 Phase A: forward cliDiagnostics on metadata for frontend folded panel (Phase B).
          yield {
            type: 'error',
            catId: this.catId,
            error,
            metadata: event.cliDiagnostics ? { ...metadata, cliDiagnostics: event.cliDiagnostics } : metadata,
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
            if (msg.type === 'text') {
              textEventCount++;
            }
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
          if (result.type === 'text') {
            textEventCount++;
          }
          yield { ...result, metadata };
        }
      }

      log.info(
        { catId: this.catId, totalEvents: eventCount, textEvents: textEventCount, sessionId: metadata.sessionId },
        'Claude CLI invocation completed',
      );

      // F215 AC-B1: Detect malformed tool-call (form A: thinking-only).
      // Condition: last assistant event has NEITHER a tool_use block NOR a text block in its content.
      //
      // Why content blocks (not text event counts):
      //   textEventCount (global) is polluted by earlier turns; per-turn counters break under streaming
      //   (--include-partial-messages) because text_delta arrives BEFORE the assistant event, then
      //   transformClaudeEvent suppresses the final assistant text — resetting a per-turn counter at
      //   assistant-event time would erase those already-counted streaming text events (AC-B5 fix).
      //   Content blocks are present in both streaming and non-streaming modes regardless of event order,
      //   so they are the only reliable source for per-turn "did this turn produce text?" detection.
      //
      // Pure tool_use tasks (lastAssistantHasToolUseBlock=true) are not malformed.
      // Invocations with no assistant event at all (empty/aborted) are NOT malformed.
      const isMalformedToolCall =
        hasAssistantEvent && !lastAssistantHasToolUseBlock && !lastAssistantHasTextBlock && !sawResultError;
      if (isMalformedToolCall) {
        log.warn(
          { catId: this.catId, totalEvents: eventCount, sessionId: metadata.sessionId },
          '[F215] Malformed tool-call detected (form A: thinking-only, no text/tool_use output) — triggering recovery',
        );
        // Signal for invoke-single-cat to seal session + trigger fallback chain (AC-C1/C2).
        yield {
          type: 'system_info' as const,
          catId: this.catId,
          content: JSON.stringify({
            type: 'malformed_toolcall_detected',
            form: 'A',
            sessionId: metadata.sessionId,
            totalEvents: eventCount,
          }),
          metadata,
          timestamp: Date.now(),
        };
        // AC-D1: Explicit炸毛 error — not silent empty return.
        yield {
          type: 'error' as const,
          catId: this.catId,
          error: 'malformed_toolcall: Opus 炸毛了——thinking-only 输出，无 tool_use / text block，系统已触发恢复流程',
          metadata,
          timestamp: Date.now(),
        };
      } else if (textEventCount === 0) {
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
    } finally {
      removeL0TempDir(l0Path);
    }
  }
}
