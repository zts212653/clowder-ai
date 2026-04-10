/**
 * Codex Agent Service
 * 使用 Codex CLI 子进程调用缅因猫 (Codex)
 *
 * CLI 调用方式:
 *   codex exec --json --sandbox danger-full-access --add-dir .git --config approval_policy="on-request" "prompt"
 *   codex exec resume SESSION_ID --json --config approval_policy="on-request" "prompt"
 *
 * NDJSON 事件格式:
 *   thread.started  → session_init (含 thread_id)
 *   item.started (command_execution) → tool_use
 *   item.completed (agent_message) → text
 *   item.completed (command_execution) → tool_result
 *   item.completed (file_change) → tool_use
 *   turn.started / turn.completed / 其余 item 事件 → 跳过
 */

import { existsSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatEffort } from '../../../../../config/cat-config-loader.js';
import { getCatModel } from '../../../../../config/cat-models.js';
import { getCodexApprovalPolicy, getCodexSandboxMode } from '../../../../../config/codex-cli.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import { AuditEventTypes, getEventAuditLog } from '../../orchestration/EventAuditLog.js';
import { CliRawArchive } from '../../session/CliRawArchive.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata, TokenUsage } from '../../types.js';
import type { AuditLogSink, RawArchiveSink } from '../providers/codex-audit-hooks.js';
import { extractCommandExecutionLifecycle, sanitizeRawEvent } from '../providers/codex-audit-hooks.js';
import { type CodexStreamState, transformCodexEvent } from '../providers/codex-event-transform.js';
import {
  type CodexSessionContextSnapshotResolver,
  createCodexSessionContextSnapshotResolver,
} from '../providers/codex-session-context-snapshot.js';
import { extractImagePaths } from '../providers/image-paths.js';

const log = createModuleLogger('codex-agent');

/**
 * Options for constructing CodexAgentService (dependency injection)
 * F32-b: catId and model are constructor parameters
 */
interface CodexAgentServiceOptions {
  /** F32-b: catId for this instance (default: 'codex') */
  catId?: CatId;
  /** F32-b: model override (default: resolved via getCatModel) */
  model?: string;
  /** Inject a custom spawn function (for testing) */
  spawnFn?: SpawnFn;
  /** Inject audit log sink (for testing) */
  auditLog?: AuditLogSink;
  /** Inject raw archive sink (for testing) */
  rawArchive?: RawArchiveSink;
  /** Inject session context resolver (for testing) */
  contextSnapshotResolver?: CodexSessionContextSnapshotResolver;
  /** Override executable name/path for Codex-family CLIs. */
  cliCommand?: string;
}

type CodexAuthMode = 'oauth' | 'api_key' | 'auto';

function getCodexAuthMode(callbackEnv?: Record<string, string>): CodexAuthMode {
  const raw = callbackEnv?.CODEX_AUTH_MODE?.trim().toLowerCase();
  if (raw === 'api_key' || raw === 'auto' || raw === 'oauth') return raw;
  return 'oauth';
}

function applyAuthMode(env: Record<string, string>, authMode: CodexAuthMode): Record<string, string | null> {
  if (authMode !== 'oauth') return env;

  // OAuth-first default: explicitly delete key-based credentials from child env.
  // spawnCli interprets `null` as "remove this key from inherited process.env".
  return {
    ...env,
    OPENAI_API_KEY: null,
    OPENAI_BASE_URL: null,
    OPENAI_API_BASE: null,
    OPENAI_ORG_ID: null,
    OPENAI_ORGANIZATION: null,
  };
}

const MAX_RECENT_STREAM_ERRORS = 5;
const MAX_STREAM_ERROR_LENGTH = 240;

function collectCodexStreamError(event: unknown, recentErrors: string[]): void {
  if (typeof event !== 'object' || event === null) return;
  const record = event as Record<string, unknown>;
  if (record.type !== 'error') return;
  const raw = record.message;
  if (typeof raw !== 'string') return;

  const msg = raw.trim().slice(0, MAX_STREAM_ERROR_LENGTH);
  if (!msg) return;

  const last = recentErrors[recentErrors.length - 1];
  if (last === msg) return;

  recentErrors.push(msg);
  if (recentErrors.length > MAX_RECENT_STREAM_ERRORS) {
    recentErrors.shift();
  }
}

function withRecentDiagnostics(base: string, recentErrors: string[]): string {
  if (recentErrors.length === 0) return base;
  const lines = recentErrors.map((line) => `- ${line}`);
  return `${base}\n最近流错误:\n${lines.join('\n')}`;
}

function toTomlString(value: string): string {
  const escaped = value.replace(/[\u0000-\u001f\u007f"\\]/g, (char) => {
    switch (char) {
      case '\\':
        return '\\\\';
      case '"':
        return '\\"';
      case '\b':
        return '\\b';
      case '\t':
        return '\\t';
      case '\n':
        return '\\n';
      case '\f':
        return '\\f';
      case '\r':
        return '\\r';
      default:
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
  });
  return `"${escaped}"`;
}

/**
 * F041/F043 root fix:
 * Ensure Codex subprocess always receives cat-cafe MCP server config
 * based on the current thread working directory.
 */
function buildCatCafeMcpConfigArgs(workingDirectory?: string, callbackEnv?: Record<string, string>): string[] {
  const candidateRoots: string[] = [];
  if (workingDirectory) candidateRoots.push(workingDirectory);
  candidateRoots.push(process.cwd());

  // file path: packages/api/src/domains/cats/services/agents/providers/CodexAgentService.ts
  // repo root = dirname(fileURLToPath(import.meta.url)) up to .../cat-cafe
  const fileDir = dirname(fileURLToPath(import.meta.url));
  candidateRoots.push(resolve(fileDir, '../../../../../../../..'));

  let serverPath: string | undefined;
  for (const root of candidateRoots) {
    const candidate = resolve(root, 'packages/mcp-server/dist/index.js');
    if (existsSync(candidate)) {
      serverPath = candidate;
      break;
    }
  }
  if (!serverPath) return [];

  const args = [
    '--config',
    'mcp_servers.cat-cafe.command="node"',
    '--config',
    `mcp_servers.cat-cafe.args=[${toTomlString(serverPath)}]`,
    '--config',
    'mcp_servers.cat-cafe.enabled=true',
  ];

  const callbackKeys = [
    'CAT_CAFE_API_URL',
    'CAT_CAFE_INVOCATION_ID',
    'CAT_CAFE_CALLBACK_TOKEN',
    'CAT_CAFE_USER_ID',
    'CAT_CAFE_CAT_ID',
    'CAT_CAFE_SIGNAL_USER',
  ] as const;
  for (const key of callbackKeys) {
    const value = callbackEnv?.[key];
    if (!value) continue;
    args.push('--config', `mcp_servers.cat-cafe.env.${key}=${toTomlString(value)}`);
  }

  return args;
}

export function isGitRepositoryPath(workingDirectory: string): boolean {
  let current = resolve(workingDirectory);
  while (true) {
    if (existsSync(join(current, '.git'))) {
      return true;
    }

    const root = parse(current).root;
    if (current === root) {
      return false;
    }

    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

function buildGitRepoArgs(workingDirectory?: string): string[] {
  const repoCheckDir = workingDirectory ?? process.cwd();
  return isGitRepositoryPath(repoCheckDir) ? [] : ['--skip-git-repo-check'];
}

/**
 * Service for invoking Codex via CLI subprocess.
 * Uses ChatGPT Plus/Pro subscription instead of API key.
 */
export class CodexAgentService implements AgentService {
  readonly catId: CatId;
  private readonly spawnFn: SpawnFn | undefined;
  private readonly model: string;
  private readonly auditLog: AuditLogSink;
  private readonly rawArchive: RawArchiveSink;
  private readonly contextSnapshotResolver: CodexSessionContextSnapshotResolver;
  private readonly cliCommand: string;

  constructor(options?: CodexAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('codex');
    this.spawnFn = options?.spawnFn;
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.auditLog = options?.auditLog ?? getEventAuditLog();
    this.rawArchive = options?.rawArchive ?? new CliRawArchive();
    this.contextSnapshotResolver = options?.contextSnapshotResolver ?? createCodexSessionContextSnapshotResolver();
    this.cliCommand = options?.cliCommand ?? 'codex';
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    // Codex CLI has no system prompt flag; prepend identity to prompt text
    const effectivePrompt = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;
    const effectiveModel = options?.callbackEnv?.CAT_CAFE_OPENAI_MODEL_OVERRIDE ?? this.model;
    const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
    const imageArgs = imagePaths.flatMap((path) => ['--image', path]);

    const sandboxMode = getCodexSandboxMode();
    const approvalPolicy = getCodexApprovalPolicy();
    const effortLevel = getCatEffort(this.catId as string, undefined, 'openai');
    const reasoningArgs = ['--config', `model_reasoning_effort="${effortLevel}"`];
    const approvalArgs = ['--config', `approval_policy="${approvalPolicy}"`];
    const catCafeMcpArgs = buildCatCafeMcpConfigArgs(options?.workingDirectory, options?.callbackEnv);
    const gitRepoArgs = buildGitRepoArgs(options?.workingDirectory);
    // User-defined CLI args from the member editor — passed as-is, no implicit wrapping.
    // Each entry is split by whitespace (e.g. "--config model_reasoning_effort=\"low\"").
    const userConfigArgs = (options?.cliConfigArgs ?? []).flatMap((arg) => arg.trim().split(/\s+/));

    // Codex CLI deprecated OPENAI_BASE_URL env var.
    // Configure a custom model provider via --config model_providers.*
    // Source: https://github.com/openai/codex codex-rs/core/src/model_provider_info.rs
    //   - env_key: env var name for the API key
    //   - base_url: API endpoint
    //   - wire_api: "responses" (HTTP, the only supported value)
    const customBaseUrl = options?.callbackEnv?.OPENAI_BASE_URL ?? options?.callbackEnv?.OPENAI_API_BASE;
    const customProviderArgs: string[] = customBaseUrl
      ? [
          '--config',
          'model_provider="custom"',
          '--config',
          `model_providers.custom.base_url=${toTomlString(customBaseUrl)}`,
          '--config',
          'model_providers.custom.name="Custom API Key"',
          '--config',
          'model_providers.custom.wire_api="responses"',
          '--config',
          'model_providers.custom.env_key="OPENAI_API_KEY"',
        ]
      : [];

    // Codex CLI sends the model name verbatim to the API (model_info.slug).
    // model_provider="custom" only controls which provider entry (base_url, env_key) to use.
    // The model name is user-configured (no system-added prefix to strip).
    // Use --config model=... instead of --model to bypass the CLI's built-in metadata lookup
    // for custom providers (non-builtin models trigger a cosmetic warning via --model).
    const cliModel = effectiveModel;
    const modelArgs: string[] = customBaseUrl ? ['--config', `model=${toTomlString(cliModel)}`] : ['--model', cliModel];

    // resume 子命令不接受 --sandbox（sandbox 在创建时已锁定）
    // --add-dir .git: 允许写入 .git/ 目录（index.lock、objects、refs），解锁 git commit
    // 注意：旧 session resume 时沿用创建时的沙箱参数，不会带 --add-dir。
    // 这是预期行为——新建会话即可获得 .git 写入权限。
    const promptArgs = ['--', effectivePrompt];

    const args: string[] = options?.sessionId
      ? [
          'exec',
          'resume',
          options.sessionId,
          '--json',
          ...modelArgs,
          ...reasoningArgs,
          ...approvalArgs,
          ...customProviderArgs,
          ...userConfigArgs,
          ...gitRepoArgs,
          ...catCafeMcpArgs,
          ...imageArgs,
          ...promptArgs,
        ]
      : [
          'exec',
          '--json',
          ...modelArgs,
          ...reasoningArgs,
          '--sandbox',
          sandboxMode,
          '--add-dir',
          '.git',
          ...approvalArgs,
          ...customProviderArgs,
          ...userConfigArgs,
          ...gitRepoArgs,
          ...catCafeMcpArgs,
          ...imageArgs,
          ...promptArgs,
        ];

    const metadata: MessageMetadata = { provider: 'openai', model: cliModel };
    const auditContext = options?.auditContext;
    const recentStreamErrors: string[] = [];

    try {
      // HOME isolation: only for API Key mode.
      // OAuth mode needs real HOME (~/.codex/auth.json for token refresh).
      // API Key mode must AVOID real HOME — stale OAuth token refresh will fail
      // and abort the CLI before it reaches the custom provider config.
      const authMode = getCodexAuthMode(options?.callbackEnv);
      const rawEnv = { ...(options?.callbackEnv ?? {}) };
      // Strip deprecated OPENAI_BASE_URL — now handled via --config model_providers
      if (customBaseUrl) {
        delete rawEnv.OPENAI_BASE_URL;
        delete rawEnv.OPENAI_API_BASE;
      }
      // For API Key mode: use temp HOME to prevent OAuth token refresh interference.
      // On Windows, Rust/codex uses USERPROFILE (not HOME) for config directory.
      if (authMode === 'api_key' && customBaseUrl) {
        const { mkdtempSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const isolatedHome = mkdtempSync(`${tmpdir()}/codex-apikey-`);
        rawEnv.HOME = isolatedHome;
        if (process.platform === 'win32') {
          rawEnv.USERPROFILE = isolatedHome;
        }
      }
      const codexEnv = applyAuthMode(rawEnv, authMode);

      const semanticCompletionController = new AbortController();

      const codexCommand = resolveCliCommand(this.cliCommand);
      if (!codexCommand) {
        yield {
          type: 'error' as const,
          catId: this.catId,
          error: formatCliNotFoundError(this.cliCommand),
          metadata,
          timestamp: Date.now(),
        };
        yield { type: 'done' as const, catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }

      log.debug(
        {
          catId: this.catId,
          command: codexCommand,
          model: cliModel,
          originalModel: effectiveModel,
          customBaseUrl: customBaseUrl ?? null,
          sessionId: options?.sessionId ?? null,
          invocationId: options?.invocationId ?? null,
          cwd: options?.workingDirectory ?? null,
          authMode,
          argCount: args.length,
        },
        'Invoking Codex CLI',
      );

      const cliOpts = {
        command: codexCommand,
        args,
        ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
        env: codexEnv,
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options?.invocationId && this.rawArchive.getPath
          ? { rawArchivePath: this.rawArchive.getPath(options.invocationId) }
          : {}),
        ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
        semanticCompletionSignal: semanticCompletionController.signal,
      };
      const events = options?.spawnCliOverride
        ? options.spawnCliOverride(cliOpts)
        : spawnCli(cliOpts, this.spawnFn ? { spawnFn: this.spawnFn } : undefined);

      // Track substantive output (item.completed with text/tool results).
      // Used to suppress Codex CLI 0.98+ false exit-code-1 errors:
      // thread.started alone is NOT substantive (just session init).
      let sawSubstantiveOutput = false;
      const codexStreamState: CodexStreamState = { hadPriorTextTurn: false };

      for await (const event of events) {
        collectCodexStreamError(event, recentStreamErrors);

        if (auditContext) {
          this.rawArchive.append(auditContext.invocationId, sanitizeRawEvent(event)).catch((err) => {
            log.warn(
              {
                threadId: auditContext.threadId,
                invocationId: auditContext.invocationId,
                err,
              },
              '[audit] Codex raw event archive write failed',
            );
          });
        }

        if (isCliTimeout(event)) {
          // F118 AC-C3: Forward timeout diagnostics as system_info before error
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
            error: `缅因猫 CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s${event.firstEventAt == null ? ', 未收到首帧' : ''})`,
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
            '[CodexAgent] liveness warning — CLI may be stuck',
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
          // Codex CLI 0.98+ returns exit code 1 after successful completion.
          // Suppress the error ONLY if we saw substantive output (item.completed).
          // thread.started alone is NOT enough — that just means session init.
          if (event.exitCode === 1 && event.signal === null && sawSubstantiveOutput) {
            log.warn(
              {},
              `[codex] Codex CLI exited with code 1 after substantive output (suppressing as Codex 0.98+ quirk)`,
            );
            continue;
          }
          const base = formatCliExitError('Codex CLI', event);
          yield {
            type: 'error',
            catId: this.catId,
            error: withRecentDiagnostics(base, recentStreamErrors),
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }

        // Track substantive events: item.completed produces text/tool_result/tool_use
        if (typeof event === 'object' && event !== null) {
          const e = event as Record<string, unknown>;
          if (e.type === 'item.completed') {
            sawSubstantiveOutput = true;
          }
        }

        if (auditContext) {
          const lifecycle = extractCommandExecutionLifecycle(event);
          if (lifecycle) {
            const type =
              lifecycle.phase === 'started' ? AuditEventTypes.CLI_TOOL_STARTED : AuditEventTypes.CLI_TOOL_COMPLETED;

            this.auditLog
              .append({
                type,
                threadId: auditContext.threadId,
                data: {
                  invocationId: auditContext.invocationId,
                  userId: auditContext.userId,
                  catId: auditContext.catId,
                  tool: 'command_execution',
                  command: lifecycle.command,
                  ...(lifecycle.status ? { status: lifecycle.status } : {}),
                  ...(lifecycle.exitCode !== undefined ? { exitCode: lifecycle.exitCode } : {}),
                },
              })
              .catch((err) => {
                log.warn(
                  {
                    threadId: auditContext.threadId,
                    invocationId: auditContext.invocationId,
                    err,
                  },
                  '[audit] Codex CLI tool lifecycle write failed',
                );
              });
          }
        }

        // F8: Capture usage from turn.completed events (not passed through transform)
        if (typeof event === 'object' && event !== null) {
          const raw = event as Record<string, unknown>;
          if (raw.type === 'turn.completed') {
            semanticCompletionController.abort();
            const u = raw.usage as Record<string, unknown> | undefined;
            if (u) {
              const usage: TokenUsage = {};
              if (typeof u.input_tokens === 'number') usage.inputTokens = u.input_tokens;
              if (typeof u.output_tokens === 'number') usage.outputTokens = u.output_tokens;
              if (typeof u.cached_input_tokens === 'number') usage.cacheReadTokens = u.cached_input_tokens;
              // F24-fallback: turn.completed is always available from codex exec --json.
              // Note: Codex session token_count is a more accurate source for context fill;
              // this value may be overwritten by contextSnapshotResolver when available.
              if (typeof u.input_tokens === 'number') usage.lastTurnInputTokens = u.input_tokens;
              metadata.usage = usage;
            }
          }
        }

        const result = transformCodexEvent(event, this.catId, codexStreamState);
        if (result !== null) {
          if (Array.isArray(result)) {
            for (const msg of result) {
              if (msg.type === 'session_init' && msg.sessionId) {
                metadata.sessionId = msg.sessionId;
              }
              yield { ...msg, metadata };
            }
          } else {
            if (result.type === 'session_init' && result.sessionId) {
              metadata.sessionId = result.sessionId;
            }
            yield { ...result, metadata };
          }
        }
      }

      if (metadata.sessionId) {
        try {
          const snapshot = await this.contextSnapshotResolver(metadata.sessionId);
          if (snapshot) {
            const usage: TokenUsage = metadata.usage ? { ...metadata.usage } : {};
            usage.contextUsedTokens = snapshot.contextUsedTokens;
            usage.contextWindowSize = snapshot.contextWindowTokens;
            usage.lastTurnInputTokens = snapshot.contextUsedTokens;

            if (snapshot.contextResetsAtMs != null) {
              usage.contextResetsAtMs = snapshot.contextResetsAtMs;
            }
            if (usage.inputTokens == null && snapshot.totalInputTokens != null) {
              usage.inputTokens = snapshot.totalInputTokens;
            }
            if (usage.cacheReadTokens == null && snapshot.totalCachedInputTokens != null) {
              usage.cacheReadTokens = snapshot.totalCachedInputTokens;
            }
            if (usage.outputTokens == null && snapshot.totalOutputTokens != null) {
              usage.outputTokens = snapshot.totalOutputTokens;
            }

            metadata.usage = usage;
          }
        } catch (err) {
          log.warn(
            {
              sessionId: metadata.sessionId,
              err,
            },
            '[codex] failed to resolve session context snapshot',
          );
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
