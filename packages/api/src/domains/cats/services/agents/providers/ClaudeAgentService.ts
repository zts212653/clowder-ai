/**
 * Claude Agent Service
 * 使用 Claude CLI 子进程调用布偶猫 (Opus)
 *
 * CLI 调用方式:
 *   claude -p "..." --output-format stream-json --verbose
 *     --permission-mode acceptEdits
 *     --model <model>
 *     [--resume <sessionId>]
 *
 * NDJSON 事件格式:
 *   system/init  → session_init (含 session_id)
 *   assistant    → text / tool_use (content blocks)
 *   result/error → error
 *   result/success → 跳过 (done 在循环后 yield)
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { isCliError, isCliTimeout, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../types.js';
import { appendLocalImagePathHints, collectImageAccessDirectories } from '../providers/image-cli-bridge.js';
import { extractImagePaths } from '../providers/image-paths.js';
import { extractClaudeUsage, isResultErrorEvent, transformClaudeEvent } from './claude-ndjson-parser.js';

const PERMISSION_MODE = 'bypassPermissions';

const ANTHROPIC_PROFILE_MODE_KEY = 'CAT_CAFE_ANTHROPIC_PROFILE_MODE';
const ANTHROPIC_PROFILE_API_KEY = 'CAT_CAFE_ANTHROPIC_API_KEY';
const ANTHROPIC_PROFILE_BASE_URL = 'CAT_CAFE_ANTHROPIC_BASE_URL';
const ANTHROPIC_MODEL_OVERRIDE_KEY = 'CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE';

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

/**
 * Locate git-bash on Windows via `where bash` + known paths.
 * Claude CLI requires git-bash's bash.exe (not WSL bash).
 * Result is cached after first resolution.
 */
let cachedGitBashPath: string | null | undefined;
function findGitBashPath(): string | undefined {
  if (cachedGitBashPath !== undefined) return cachedGitBashPath ?? undefined;
  // Known standard install locations
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedGitBashPath = c;
      return c;
    }
  }
  // Dynamic: use `where bash` to find all bash.exe on PATH, pick the Git one
  try {
    const output = execSync('where bash', { encoding: 'utf8', timeout: 5000 });
    for (const line of output.trim().split(/\r?\n/)) {
      const p = line.trim();
      // Skip WSL bash (System32), only accept Git-installed bash
      if (p && /\\Git\\.*\\bash\.exe$/i.test(p) && existsSync(p)) {
        cachedGitBashPath = p;
        return p;
      }
    }
  } catch {
    // `where` not available or no results
  }
  cachedGitBashPath = null;
  return undefined;
}

function buildClaudeEnvOverrides(callbackEnv?: Record<string, string>): Record<string, string | null> {
  const env: Record<string, string | null> = { ...(callbackEnv ?? {}) };

  // CRITICAL: Always strip nested-session detection env vars.
  // API server runs inside Claude Code, which sets CLAUDECODE=1. If inherited,
  // the child `claude` CLI will refuse to start ("nested session detected").
  env.CLAUDECODE = null;
  env.CLAUDE_CODE_ENTRYPOINT = null;

  // Windows: Ensure child Claude CLI can find git-bash.
  if (process.platform === 'win32' && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    const found = findGitBashPath();
    if (found) env.CLAUDE_CODE_GIT_BASH_PATH = found;
  }

  if (callbackEnv) {
    const mode = callbackEnv[ANTHROPIC_PROFILE_MODE_KEY];
    if (mode === 'api_key') {
      const apiKey = callbackEnv[ANTHROPIC_PROFILE_API_KEY]?.trim();
      const baseUrl = callbackEnv[ANTHROPIC_PROFILE_BASE_URL]?.trim();
      if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
      if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    } else {
      // Subscription mode: explicitly clear inherited key-based env vars.
      env.ANTHROPIC_API_KEY = null;
      env.ANTHROPIC_BASE_URL = null;
    }
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
    const args: string[] = [
      '-p',
      effectivePrompt,
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model',
      effectiveModel,
      '--permission-mode',
      PERMISSION_MODE,
      // Skip global user settings to prevent config pollution across sessions
      '--setting-sources',
      'project,local',
      // Enable Chrome MCP integration (built-in, requires Chrome + extension running)
      '--chrome',
    ];

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
    if (options?.callbackEnv && this.mcpServerPath) {
      args.push(
        '--mcp-config',
        JSON.stringify({
          mcpServers: {
            'cat-cafe': {
              command: 'node',
              args: [this.mcpServerPath],
            },
          },
        }),
      );
    }

    const metadata: MessageMetadata = { provider: 'anthropic', model: effectiveModel };
    const streamState = {
      partialTextMessageIds: new Set<string>(),
      currentMessageId: undefined as string | undefined,
      lastTurnInputTokens: undefined as number | undefined,
      thinkingBuffer: '' as string,
    };

    try {
      let sawResultError = false;
      const envOverrides = buildClaudeEnvOverrides(options?.callbackEnv);
      const cliOpts = {
        command: 'claude' as const,
        args,
        ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
        env: envOverrides,
        ...(options?.signal ? { signal: options.signal } : {}),
      };
      const events = options?.spawnCliOverride
        ? options.spawnCliOverride(cliOpts)
        : spawnCli(cliOpts, this.spawnFn ? { spawnFn: this.spawnFn } : undefined);

      for await (const event of events) {
        if (isCliTimeout(event)) {
          yield {
            type: 'error',
            catId: this.catId,
            error: `布偶猫 CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s)`,
            metadata,
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
        if (result === null) continue;

        if (Array.isArray(result)) {
          for (const msg of result) {
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
      // Guarantee done after error so invoke-single-cat can set isFinal correctly
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    }
  }
}
