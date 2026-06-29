/**
 * Codex Agent Service
 * 使用 Codex CLI 子进程调用缅因猫 (Codex)
 *
 * CLI 调用方式:
 *   codex exec --json --sandbox danger-full-access --add-dir .git --config approval_policy="on-request" "prompt"
 *   codex exec resume SESSION_ID --json --config sandbox_mode="danger-full-access" --config approval_policy="on-request" "prompt"
 *
 * NDJSON 事件格式:
 *   thread.started  → session_init (含 thread_id)
 *   item.started (command_execution) → tool_use
 *   item.completed (agent_message) → text
 *   item.completed (command_execution) → tool_result
 *   item.completed (file_change) → tool_use
 *   turn.started / turn.completed / 其余 item 事件 → 跳过
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { resolveBinaryRoot, resolveServersForCat } from '../../../../../config/capabilities/capability-orchestrator.js';
import {
  CAT_CAFE_SPLIT_ENTRYPOINTS,
  MCP_CALLBACK_ENV_KEYS,
  resolveCatCafeNodeCommand,
} from '../../../../../config/capabilities/mcp-constants.js';
import { getCatContextWindowConfig, getCatEffort } from '../../../../../config/cat-config-loader.js';
import { getCatModel } from '../../../../../config/cat-models.js';
import { getCodexApprovalPolicy, getCodexSandboxMode } from '../../../../../config/codex-cli.js';
import { estimateCostFromTokens } from '../../../../../config/model-pricing.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import { sanitizeCliStderr } from '../../../../../utils/sanitize-cli-stderr.js';
import { AuditEventTypes, getEventAuditLog } from '../../orchestration/EventAuditLog.js';
import { CliRawArchive } from '../../session/CliRawArchive.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata, TokenUsage } from '../../types.js';
import type { AuditLogSink, RawArchiveSink } from '../providers/codex-audit-hooks.js';
import { extractCommandExecutionLifecycle, sanitizeRawEvent } from '../providers/codex-audit-hooks.js';
import { type CodexStreamState, transformCodexEvent } from '../providers/codex-event-transform.js';
import { scanAndPublishCodexImages } from '../providers/codex-image-scanner.js';
import {
  type CodexSessionContextSnapshotResolver,
  createCodexSessionContextSnapshotResolver,
} from '../providers/codex-session-context-snapshot.js';
import { extractImagePaths } from '../providers/image-paths.js';
import { compileL0ViaSubprocess } from './l0-compiler.js';

const log = createModuleLogger('codex-agent');

/** Redact a custom base URL for diagnostic logging — expose protocol+host only. */
function redactUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '[invalid-url]';
  }
}

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
  /** Test seam — replaces the real L0 compiler subprocess (Task 3a). */
  l0CompilerFn?: typeof compileL0ViaSubprocess;
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

  const msg = sanitizeCliStderr(raw.trim()).slice(0, MAX_STREAM_ERROR_LENGTH);
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

function hasNonSuppressibleCodexExitOneDiagnostics(
  event: {
    message?: string;
    cliDiagnostics?: { publicSummary?: string; safeExcerpt?: string };
  },
  recentErrors: string[],
): boolean {
  const diagnosticText = [
    event.message,
    event.cliDiagnostics?.publicSummary,
    event.cliDiagnostics?.safeExcerpt,
    ...recentErrors,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n');

  return /remote compaction failed|compact_error/i.test(diagnosticText);
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
 * F203 Phase C — `--config` keys the system controls. User cliConfigArgs
 * cannot override these. Currently `developer_instructions` carries the
 * compiled L0 (identity / 家规 invariant). Adding here without updating
 * the F203 spec is a P1 — silent system-config drop hides L0 from the cat.
 * (砚砚 review 2026-05-16 BLOCKING finding.)
 */
const RESERVED_SYSTEM_CONFIG_KEYS: ReadonlySet<string> = new Set(['developer_instructions']);

/**
 * Strip `--config <key=value>` / `-c <key=value>` pairs from a pre-split
 * cliConfigArgs array when `key` is reserved. The downstream `dedup()`
 * would otherwise skip the system push for any key already in
 * userConfigKeys — silently dropping the L0 the moment a user adds the
 * same key. `-c` is the documented short alias of `--config` per
 * `codex exec --help` so both forms must be intercepted (云端 Codex
 * P1-cloud-2, 2026-05-16).
 */
function stripReservedSystemConfigs(args: string[], catId: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--config' || a === '-c') && i + 1 < args.length) {
      const key = args[i + 1].split('=')[0];
      if (key && RESERVED_SYSTEM_CONFIG_KEYS.has(key)) {
        log.warn({ catId, key, form: a }, 'cliConfigArgs override of reserved system config key dropped');
        i++; // also skip the value pair
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

/**
 * F041/F043 root fix:
 * Ensure Codex subprocess always receives cat-cafe MCP server config
 * based on the current thread working directory.
 */
function resolveAllowedWorkspaceDirsForMcp(workingDirectory?: string): string {
  const explicitAllowed = process.env.ALLOWED_WORKSPACE_DIRS?.trim();
  if (explicitAllowed) return explicitAllowed;
  const threadWorkspace = workingDirectory?.trim();
  if (threadWorkspace) return resolve(threadWorkspace);
  const explicitWorkspace = process.env.CAT_CAFE_WORKSPACE_ROOT?.trim();
  if (explicitWorkspace) return explicitWorkspace;
  return process.cwd();
}

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/;

function isAbsoluteMcpPath(value: string): boolean {
  return isAbsolute(value) || WINDOWS_ABSOLUTE_PATH_PATTERN.test(value);
}

function resolveCodexMcpWorkingDir(workingDir: string | undefined, projectRoot: string): string | undefined {
  const trimmed = workingDir?.trim();
  if (!trimmed) return undefined;
  if (isAbsolute(trimmed)) return resolve(trimmed);
  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)) return trimmed;
  return resolve(projectRoot, trimmed);
}

function resolveCodexMcpArgs(
  args: readonly string[] | undefined,
  workingDir: string | undefined,
  projectRoot: string,
): string[] {
  return (args ?? []).map((arg) => {
    if (isAbsoluteMcpPath(arg) || arg.startsWith('-')) return arg;
    if (workingDir) {
      const fromWorkDir = resolve(workingDir, arg);
      if (existsSync(fromWorkDir)) return fromWorkDir;
    }
    const fromRoot = resolve(projectRoot, arg);
    if (existsSync(fromRoot)) return fromRoot;
    return arg;
  });
}

function isPathLikeMcpCommand(command: string): boolean {
  return isAbsoluteMcpPath(command) || command.startsWith('.') || command.includes('/') || command.includes('\\');
}

function resolveCodexMcpCommand(command: string, workingDir: string | undefined, projectRoot: string): string {
  if (!isPathLikeMcpCommand(command) || isAbsoluteMcpPath(command)) return command;
  if (workingDir) {
    const fromWorkDir = resolve(workingDir, command);
    if (existsSync(fromWorkDir)) return fromWorkDir;
  }
  const fromRoot = resolve(projectRoot, command);
  if (existsSync(fromRoot)) return fromRoot;
  return command;
}

function writeCodexMcpEnvWrapper(spec: {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}): { command: string; args: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'cat-cafe-codex-mcp-'));
  const wrapperPath = join(dir, 'mcp-env-wrapper.mjs');
  const specPath = join(dir, 'mcp-env-spec.json');
  writeFileSync(
    wrapperPath,
    [
      "import { spawn } from 'node:child_process';",
      "import { readFileSync, rmSync } from 'node:fs';",
      "import { dirname } from 'node:path';",
      'const specPath = process.argv[2];',
      'const wrapperPath = process.argv[1];',
      "const spec = JSON.parse(readFileSync(specPath, 'utf8'));",
      'try { rmSync(specPath, { force: true }); } catch {}',
      'const child = spawn(spec.command, spec.args ?? [], {',
      '  cwd: spec.cwd || process.cwd(),',
      '  env: { ...process.env, ...(spec.env ?? {}) },',
      "  stdio: 'inherit',",
      '});',
      'const cleanup = () => {',
      '  try { rmSync(wrapperPath, { force: true }); } catch {}',
      '  try { rmSync(dirname(wrapperPath), { recursive: true, force: true }); } catch {}',
      '};',
      "child.on('error', (err) => {",
      '  cleanup();',
      '  console.error(err?.stack || String(err));',
      '  process.exit(1);',
      '});',
      "child.on('exit', (code, signal) => {",
      '  cleanup();',
      '  if (signal) process.kill(process.pid, signal);',
      '  process.exit(code ?? 0);',
      '});',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600 },
  );
  writeFileSync(specPath, JSON.stringify(spec), { encoding: 'utf8', mode: 0o600 });
  return { command: resolveCatCafeNodeCommand(), args: [wrapperPath, specPath] };
}

/**
 * #712: Build Codex MCP CLI --config args from capabilities.json at invoke time.
 *
 * Reads capabilities.json to inject ALL enabled MCP servers (builtins + externals)
 * and explicitly disables off-capabilities servers so stale .codex/config.toml
 * entries don't leak through.
 *
 * This function is intentionally SYNC — Codex test harness uses setImmediate
 * for mock process exit, and async operations between collect() and spawnCli
 * would cause the exit event to fire before process listeners attach.
 * Pencil and streamableHttp are skipped (Codex only supports stdio).
 */
function buildCatCafeMcpArgs(callbackEnv?: Record<string, string>, workingDirectory?: string): string[] {
  if (!callbackEnv) return [];

  const runtimeRoot = resolveBinaryRoot();
  const fileDir = dirname(fileURLToPath(import.meta.url));
  // The thread workingDirectory is the user's project/workspace. Clowder AI MCP
  // binaries are runtime-owned, so resolving from workingDirectory can pick a
  // fork checkout with incomplete node_modules and silently drop all MCP tools.
  const candidateRoots = [
    process.env.CAT_CAFE_RUNTIME_ROOT?.trim(),
    process.cwd(),
    // file path: packages/api/src/domains/cats/services/agents/providers/CodexAgentService.ts
    // repo root = dirname(fileURLToPath(import.meta.url)) up to .../cat-cafe
    resolve(fileDir, '../../../../../../../..'),
  ].filter((root): root is string => !!root);

  let mcpDistDir: string | undefined;
  for (const root of candidateRoots) {
    const candidate = resolve(root, 'packages/mcp-server/dist');
    if (existsSync(resolve(candidate, 'index.js'))) {
      mcpDistDir = candidate;
      break;
    }
  }
  if (!mcpDistDir) return [];

  const binaryProjectRoot = resolve(mcpDistDir, '../../..');
  const capabilitiesProjectRoot = binaryProjectRoot;
  const catId = callbackEnv.CAT_CAFE_CAT_ID;
  const args: string[] = [];
  const allowedWorkspaceDirs = resolveAllowedWorkspaceDirsForMcp(workingDirectory);

  // F213: L4 per-invocation dummy disabled override for legacy `cat-cafe` server.
  args.push(
    '--config',
    'mcp_servers.cat-cafe.command="echo"',
    '--config',
    `mcp_servers.cat-cafe.args=[${toTomlString('legacy-shim')}]`,
    '--config',
    'mcp_servers.cat-cafe.enabled=false',
  );

  // #712: Read capabilities.json and inject ALL enabled MCP servers at invoke time.
  let resolved = false;
  const enabledServers: string[] = [];
  const disabledServers: string[] = [];
  try {
    // F249: Project config is the single truth source for MCP resolution.
    // Try project first; fall back to global for uninitialized projects.
    let capConfig = null;
    // #712 P2-2: track which root supplied the config so relative paths
    // in external MCP entries resolve against the correct base directory.
    let configSourceRoot = capabilitiesProjectRoot;
    if (workingDirectory && workingDirectory !== capabilitiesProjectRoot) {
      try {
        const projectRaw = readFileSync(join(workingDirectory, '.cat-cafe', 'capabilities.json'), 'utf-8');
        const parsed = JSON.parse(projectRaw);
        if (parsed?.version === 1 || parsed?.version === 2) {
          capConfig = parsed;
          configSourceRoot = workingDirectory;
        }
      } catch {
        /* No project config — fall back to global */
      }
    }
    if (!capConfig) {
      const raw = readFileSync(join(capabilitiesProjectRoot, '.cat-cafe', 'capabilities.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 || parsed?.version === 2) capConfig = parsed;
      configSourceRoot = capabilitiesProjectRoot;
    }
    if (capConfig && catId) {
      for (const s of resolveServersForCat(capConfig, catId) as Array<{
        name: string;
        enabled: boolean;
        command: string;
        args?: string[];
        env?: Record<string, string>;
        resolver?: string;
        transport?: string;
        source: string;
        workingDir?: string;
      }>) {
        // Skip disabled servers entirely. L5 writeCodexMcpConfig already
        // deletes disabled managed entries from .codex/config.toml, so there's
        // nothing to override at L4. Injecting a bare `enabled=false` (or even
        // a dummy command + enabled=false) adds CLI noise and risks Codex CLI
        // validation errors (≥0.142 requires valid transport on all entries).
        // The legacy `cat-cafe` shim above is the only exception — user-level
        // ~/.codex/config.toml may have old entries that L5 cannot reach.
        if (!s.enabled) {
          disabledServers.push(s.name);
          continue;
        }
        // Codex only supports stdio — skip streamableHttp and pencil (async resolver)
        if (s.transport === 'streamableHttp' || s.resolver === 'pencil') continue;

        let cmd: string | undefined;
        let cmdArgs: string[] | undefined;
        let envEntries: Record<string, string> | undefined;
        const isCatCafe = s.source === 'cat-cafe' && CAT_CAFE_SPLIT_ENTRYPOINTS.has(s.name);
        const workingDir = resolveCodexMcpWorkingDir(s.workingDir, configSourceRoot);

        if (isCatCafe) {
          const ep = CAT_CAFE_SPLIT_ENTRYPOINTS.get(s.name)!;
          const epPath = resolve(mcpDistDir!, ep);
          if (!existsSync(epPath)) continue;
          cmd = resolveCatCafeNodeCommand();
          cmdArgs = [epPath];
        } else if (s.command) {
          cmd = resolveCodexMcpCommand(s.command, workingDir, configSourceRoot);
          cmdArgs = resolveCodexMcpArgs(s.args, workingDir, configSourceRoot);
          if (s.env && Object.keys(s.env).length > 0) envEntries = s.env;
        }
        if (!cmd) continue;
        if (envEntries) {
          const wrapped = writeCodexMcpEnvWrapper({
            command: cmd,
            args: cmdArgs ?? [],
            env: envEntries,
            ...(workingDir ? { cwd: workingDir } : {}),
          });
          cmd = wrapped.command;
          cmdArgs = wrapped.args;
        }
        enabledServers.push(s.name);

        const tomlName = /^[A-Za-z0-9_-]+$/.test(s.name) ? s.name : `"${s.name}"`;
        args.push(
          '--config',
          `mcp_servers.${tomlName}.command=${toTomlString(cmd)}`,
          '--config',
          `mcp_servers.${tomlName}.args=[${(cmdArgs ?? []).map(toTomlString).join(', ')}]`,
          '--config',
          `mcp_servers.${tomlName}.enabled=true`,
        );
        if (isCatCafe) {
          args.push('--config', `mcp_servers.${tomlName}.default_tools_approval_mode="approve"`);
          args.push(
            '--config',
            `mcp_servers.${tomlName}.env.ALLOWED_WORKSPACE_DIRS=${toTomlString(allowedWorkspaceDirs)}`,
          );
          for (const key of MCP_CALLBACK_ENV_KEYS) {
            const value = callbackEnv[key];
            if (value) args.push('--config', `mcp_servers.${tomlName}.env.${key}=${toTomlString(value)}`);
          }
        }
      }
      resolved = true;
    }
  } catch {
    // best-effort fallback below
  }

  if (!resolved) {
    for (const [serverName, entrypoint] of CAT_CAFE_SPLIT_ENTRYPOINTS) {
      const serverPath = resolve(mcpDistDir, entrypoint);
      if (!existsSync(serverPath)) continue;
      args.push(
        '--config',
        `mcp_servers.${serverName}.command=${toTomlString(resolveCatCafeNodeCommand())}`,
        '--config',
        `mcp_servers.${serverName}.args=[${toTomlString(serverPath)}]`,
        '--config',
        `mcp_servers.${serverName}.enabled=true`,
        '--config',
        `mcp_servers.${serverName}.default_tools_approval_mode="approve"`,
      );
      args.push(
        '--config',
        `mcp_servers.${serverName}.env.ALLOWED_WORKSPACE_DIRS=${toTomlString(allowedWorkspaceDirs)}`,
      );
      for (const key of MCP_CALLBACK_ENV_KEYS) {
        const value = callbackEnv[key];
        if (!value) continue;
        args.push('--config', `mcp_servers.${serverName}.env.${key}=${toTomlString(value)}`);
      }
    }
  }
  log.debug(
    {
      provider: 'codex',
      catId,
      resolvedFrom: resolved ? 'capabilities.json' : 'fallback',
      enabledServers,
      disabledServers,
      totalArgs: args.length,
    },
    '#712: MCP invoke-time injection',
  );
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
  /** F203 Phase C: compiles per-cat L0 → OpenAI developer role (-c). */
  private readonly l0CompilerFn: typeof compileL0ViaSubprocess;

  constructor(options?: CodexAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('codex');
    this.spawnFn = options?.spawnFn;
    this.l0CompilerFn = options?.l0CompilerFn ?? compileL0ViaSubprocess;
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.auditLog = options?.auditLog ?? getEventAuditLog();
    this.rawArchive = options?.rawArchive ?? new CliRawArchive();
    this.contextSnapshotResolver = options?.contextSnapshotResolver ?? createCodexSessionContextSnapshotResolver();
    this.cliCommand = options?.cliCommand ?? 'codex';
  }

  /** F203 Phase C — this service injects L0 via `-c developer_instructions=` (Task 4). */
  injectsL0Natively(): boolean {
    return true;
  }

  /**
   * F177 Phase H (KD-13) — codex-family runs via `codex exec --json`, which does
   * NOT dispatch ~/.codex/hooks.json Stop hooks (H0 spike 2026-06-11), so the
   * Claude Code F177-G routing guard never fires for codex/gpt52. The serial
   * route layer applies a server-side remedial guard instead. Covers all
   * CodexAgentService instances (codex GPT-5.5 + gpt52 GPT-5.4).
   *
   * NOTE: do NOT derive this from injectsL0Natively() — codex injects L0
   * natively yet still needs the guard, so the two capabilities are orthogonal.
   */
  needsServerRoutingGuard(): boolean {
    return true;
  }

  /**
   * F203 Phase C: compile per-cat L0 → `-c developer_instructions=` argv
   * (S4-verified, 砚砚 62b9255e2 — enters the OpenAI `developer` role,
   * additive, NOT replacing Codex's base instructions; per-invocation argv,
   * NOT ~/.codex/config.toml which would race @codex/@gpt52/@spark).
   * fail-closed: on compile failure return an error descriptor (caller yields
   * error + done + return, mirroring the CLI-not-found path) — a missing L0
   * = a cat with no identity/家规, strictly worse than a failed invocation.
   */
  private async compileDeveloperInstructionsArgs(
    cliModel: string,
  ): Promise<{ args: string[] } | { error: string; metadata: MessageMetadata }> {
    try {
      const compiledL0 = await this.l0CompilerFn({ catId: this.catId as string });
      return { args: ['--config', `developer_instructions=${toTomlString(compiledL0)}`] };
    } catch (err) {
      return {
        error: `L0 compile failed for ${this.catId as string}: ${(err as Error).message}`,
        metadata: { provider: 'openai', model: cliModel },
      };
    }
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
    const sandboxConfigArgs = ['--config', `sandbox_mode=${toTomlString(sandboxMode)}`];
    const approvalArgs = ['--config', `approval_policy="${approvalPolicy}"`];
    const ctxConfig = getCatContextWindowConfig(this.catId as string);
    const contextWindowArgs: string[] = ctxConfig
      ? [
          '--config',
          `model_context_window=${ctxConfig.contextWindow}`,
          '--config',
          `model_auto_compact_token_limit=${ctxConfig.autoCompactTokenLimit}`,
        ]
      : [];
    // #712: Inject ALL enabled MCP servers from capabilities.json at invoke time.
    const catCafeMcpArgs = buildCatCafeMcpArgs(options?.callbackEnv, options?.workingDirectory);
    const gitRepoArgs = buildGitRepoArgs(options?.workingDirectory);
    // User-defined CLI args from the member editor (#567) — passed as-is, no implicit wrapping.
    // Each entry is split by whitespace (e.g. "--config model_reasoning_effort=\"low\"").
    // F203 Phase C / 砚砚 P1: strip reserved system config keys (developer_instructions,
    // carries L0) before dedup — otherwise dedup() would skip the system push and the
    // L0 would be silently overridden by any cliConfigArgs entry with the same key.
    const userConfigArgs = stripReservedSystemConfigs(
      (options?.cliConfigArgs ?? []).flatMap((arg) => arg.trim().split(/\s+/)),
      this.catId as string,
    );
    // Collect user --config / -c keys so system-injected duplicates can be
    // skipped. `-c` is the documented short alias of `--config` per
    // `codex exec --help`; both forms must be recognized here (云端 Codex
    // P1-cloud-2, 2026-05-16).
    const userConfigKeys = new Set<string>();
    const userFlagSet = new Set<string>();
    for (let i = 0; i < userConfigArgs.length; i++) {
      const a = userConfigArgs[i];
      if ((a === '--config' || a === '-c') && i + 1 < userConfigArgs.length) {
        const key = userConfigArgs[i + 1].split('=')[0];
        if (key) userConfigKeys.add(key);
      } else if (a.startsWith('-')) {
        userFlagSet.add(a);
      }
    }

    // Codex CLI deprecated OPENAI_BASE_URL env var.
    // Configure a custom model provider via --config model_providers.*
    // Source: https://github.com/openai/codex codex-rs/core/src/model_provider_info.rs
    //   - env_key: env var name for the API key
    //   - base_url: API endpoint
    //   - wire_api: "responses" (HTTP, the only supported value)
    // Check both callbackEnv and accountEnv — after F171 env separation,
    // user-configured OPENAI_BASE_URL lives in accountEnv, not callbackEnv.
    const customBaseUrl =
      options?.callbackEnv?.OPENAI_BASE_URL ??
      options?.callbackEnv?.OPENAI_API_BASE ??
      options?.accountEnv?.OPENAI_BASE_URL ??
      options?.accountEnv?.OPENAI_API_BASE;
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
    const modelArgs: string[] = !cliModel
      ? []
      : customBaseUrl
        ? ['--config', `model=${toTomlString(cliModel)}`]
        : ['--model', cliModel];

    // F203 Phase C: compile per-cat L0 → OpenAI `developer` role args.
    // fail-closed (generator contract, mirrors the CLI-not-found path below).
    const l0Result = await this.compileDeveloperInstructionsArgs(cliModel);
    if ('error' in l0Result) {
      yield {
        type: 'error' as const,
        catId: this.catId,
        error: l0Result.error,
        metadata: l0Result.metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done' as const, catId: this.catId, metadata: l0Result.metadata, timestamp: Date.now() };
      return;
    }
    const developerInstructionsArgs = l0Result.args;

    // resume 子命令不接受 --sandbox / --add-dir, but it does accept
    // sandbox_mode through --config. Replay the configured sandbox there so
    // resumed Codex turns cannot drift back to a CLI default sandbox on Windows.
    // --add-dir .git: 允许写入 .git/ 目录（index.lock、objects、refs），解锁 git commit
    // 注意：旧 session resume 时仍不会带 --add-dir。这是预期行为——新建会话
    // 才能获得额外目录授权。
    // Incident 2026-05-29 (cross-thread-context-contamination): prompt 正文经 stdin
    // 传入（见下方 cliOpts.stdinInput），绝不进 argv —— 否则 `ps -o command=` /
    // /proc/<pid>/cmdline 会把完整对话历史（含跨 thread/猫/用户内容）暴露给任何
    // 并发进程。'--' 结束选项解析，'-' 让 codex 从 stdin 读取 PROMPT。
    const promptArgs = ['--', '-'];

    // Dedup: skip system --config/--flag pairs that the user explicitly overrides (#567).
    const dedup = (src: string[]): string[] => {
      const out: string[] = [];
      for (let i = 0; i < src.length; i++) {
        if (src[i] === '--config' && i + 1 < src.length) {
          const key = src[i + 1].split('=')[0];
          if (userConfigKeys.has(key)) {
            i++;
            continue;
          }
        } else if (src[i].startsWith('-') && userFlagSet.has(src[i])) {
          if (i + 1 < src.length && !src[i + 1].startsWith('-')) i++;
          continue;
        }
        out.push(src[i]);
      }
      return out;
    };

    const args: string[] = options?.sessionId
      ? [
          'exec',
          'resume',
          options.sessionId,
          '--json',
          ...dedup(modelArgs),
          ...dedup(reasoningArgs),
          ...dedup(contextWindowArgs),
          ...dedup(sandboxConfigArgs),
          ...dedup(approvalArgs),
          ...dedup(developerInstructionsArgs),
          ...dedup(customProviderArgs),
          ...userConfigArgs,
          ...gitRepoArgs,
          ...catCafeMcpArgs,
          ...imageArgs,
          ...promptArgs,
        ]
      : [
          'exec',
          '--json',
          ...dedup(modelArgs),
          ...dedup(reasoningArgs),
          ...dedup(contextWindowArgs),
          '--sandbox',
          sandboxMode,
          '--add-dir',
          '.git',
          ...dedup(approvalArgs),
          ...dedup(developerInstructionsArgs),
          ...dedup(customProviderArgs),
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
      const homeIsolated = authMode === 'api_key' && !!customBaseUrl;
      const codexEnv = applyAuthMode(rawEnv, authMode);

      // Diagnostic logging: critical env state for debugging CLI startup failures
      log.info(
        {
          catId: this.catId,
          authMode,
          homeIsolated,
          isolatedHome: homeIsolated ? rawEnv.HOME : undefined,
          customBaseUrl: customBaseUrl ? redactUrlForLog(customBaseUrl) : null,
          sandboxMode,
          hasOpenaiKey: !!codexEnv.OPENAI_API_KEY,
          hasOpenaiKeyAfterAuth: codexEnv.OPENAI_API_KEY !== null && codexEnv.OPENAI_API_KEY !== undefined,
          envKeysCallbackEnv: Object.keys(options?.callbackEnv ?? {}),
          envKeysAccountEnv: Object.keys(options?.accountEnv ?? {}),
          cwd: options?.workingDirectory ?? null,
          platform: process.platform,
        },
        '[codex-diag] Auth + env setup',
      );

      // F171: Account env vars applied LAST — user overrides provider-injected values.
      // Strip OPENAI_BASE_URL/OPENAI_API_BASE if already consumed via --config model_providers
      // to prevent the deprecated env var from conflicting with the CLI config.
      if (options?.accountEnv) {
        for (const [k, v] of Object.entries(options.accountEnv)) {
          if (customBaseUrl && (k === 'OPENAI_BASE_URL' || k === 'OPENAI_API_BASE')) continue;
          codexEnv[k] = v;
        }
      }

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

      // Diagnostic: log full invocation params at info level for troubleshooting
      log.info(
        {
          catId: this.catId,
          command: codexCommand,
          model: cliModel,
          originalModel: effectiveModel,
          customBaseUrl: customBaseUrl ? redactUrlForLog(customBaseUrl) : null,
          sessionId: options?.sessionId ?? null,
          invocationId: options?.invocationId ?? null,
          cwd: options?.workingDirectory ?? null,
          authMode,
          argCount: args.length,
          // Log flag names + --config keys (no values) for debugging
          cliFlags: args.filter((a) => a.startsWith('-')),
          cliConfigKeys: args.map((a, i) => (args[i - 1] === '--config' ? a.split('=')[0] : null)).filter(Boolean),
        },
        '[codex-diag] Invoking Codex CLI',
      );

      const cliOpts = {
        command: codexCommand,
        args,
        // Incident 2026-05-29 (cross-thread-context-contamination): prompt 正文经 stdin
        // 传入，不进 argv —— 防 `ps -o command=` / /proc/<pid>/cmdline 跨进程泄露。
        stdinInput: effectivePrompt,
        ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
        env: codexEnv,
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options?.invocationId && this.rawArchive.getPath
          ? { rawArchivePath: this.rawArchive.getPath(options.invocationId) }
          : {}),
        ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
        ...(options?.parentSpan ? { parentSpan: options.parentSpan } : {}),
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
          if (
            event.exitCode === 1 &&
            event.signal === null &&
            sawSubstantiveOutput &&
            !hasNonSuppressibleCodexExitOneDiagnostics(event, recentStreamErrors)
          ) {
            log.warn(
              {},
              `[codex] Codex CLI exited with code 1 after substantive output (suppressing as Codex 0.98+ quirk)`,
            );
            continue;
          }
          // Diagnostic: log full error details at info level for troubleshooting
          log.info(
            {
              catId: this.catId,
              exitCode: event.exitCode,
              signal: event.signal,
              message: event.message,
              reasonCode: event.reasonCode,
              publicSummary: event.cliDiagnostics?.publicSummary,
              safeExcerpt: event.cliDiagnostics?.safeExcerpt,
              debugRef: event.cliDiagnostics?.debugRef,
              sawSubstantiveOutput,
              recentStreamErrors,
            },
            '[codex-diag] CLI error exit — full diagnostics',
          );
          const base = formatCliExitError('Codex CLI', event);
          // F212 Phase A: forward cliDiagnostics on metadata for frontend folded panel (Phase B).
          yield {
            type: 'error',
            catId: this.catId,
            error: withRecentDiagnostics(base, recentStreamErrors),
            metadata: event.cliDiagnostics ? { ...metadata, cliDiagnostics: event.cliDiagnostics } : metadata,
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

      // Estimate cost from pricing table when CLI doesn't provide costUsd.
      // MUST run BEFORE contextSnapshotResolver — the resolver overwrites
      // metadata.usage.inputTokens/outputTokens with context-fill values for
      // display, but cost estimation needs the original turn.completed totals
      // which reflect cumulative billing (cloud P2 fix).
      // Use metadata.model (= effectiveModel = actual model that ran) rather than
      // getCatModel() which misses per-invocation overrides (review P1-2).
      if (metadata.usage && metadata.usage.costUsd == null && metadata.model) {
        const inputTokens = metadata.usage.inputTokens ?? metadata.usage.lastTurnInputTokens ?? 0;
        const outputTokens = metadata.usage.outputTokens ?? 0;
        if (inputTokens > 0 || outputTokens > 0) {
          const estimated = estimateCostFromTokens(
            metadata.model,
            inputTokens,
            outputTokens,
            metadata.usage.cacheReadTokens,
          );
          if (estimated != null) {
            metadata.usage.costUsd = estimated;
            metadata.usage.costEstimated = true;
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
            // Codex turn.completed usage can be CLI-session cumulative. When
            // token_count is available, prefer last_token_usage for this turn.
            // For Codex, each Clowder AI invocation is one CLI turn, so
            // last_token_usage is the invocation input, not a session total.
            usage.inputTokens = snapshot.contextUsedTokens;

            if (snapshot.contextResetsAtMs != null) {
              usage.contextResetsAtMs = snapshot.contextResetsAtMs;
            }
            if (snapshot.lastCachedInputTokens != null) {
              usage.cacheReadTokens = snapshot.lastCachedInputTokens;
            } else {
              delete usage.cacheReadTokens;
            }
            if (snapshot.lastOutputTokens != null) {
              usage.outputTokens = snapshot.lastOutputTokens;
            } else {
              delete usage.outputTokens;
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

      // F172 Phase B: Scan for generated images and publish to /uploads/
      if (metadata.sessionId) {
        try {
          const published = await scanAndPublishCodexImages({
            codexSessionId: metadata.sessionId,
            uploadDir: options?.uploadDir,
            codexHome: rawEnv.HOME ? join(rawEnv.HOME, '.codex') : undefined,
          });
          for (const img of published) {
            yield {
              type: 'system_info' as const,
              catId: this.catId,
              content: JSON.stringify({ type: 'rich_block', block: img.richBlock, provenance: img.provenance }),
              metadata,
              timestamp: Date.now(),
            };
          }
        } catch (err) {
          log.warn({ sessionId: metadata.sessionId, err }, '[F172] codex image scan failed');
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
