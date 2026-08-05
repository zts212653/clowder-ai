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
 *   turn.started / 其余 item 事件 → 跳过
 *   successful stream end after turn.completed → exactly one runtime-canonical final signature
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CatId, catRegistry, createCatId, resolveCliEffortOverride } from '@cat-cafe/shared';
import { parse as parseToml } from 'smol-toml';
import {
  resolveBinaryRoot,
  resolvePencilCommand,
  resolveServersForCat,
} from '../../../../../config/capabilities/capability-orchestrator.js';
import {
  CAT_CAFE_SPLIT_ENTRYPOINTS,
  MCP_CALLBACK_ENV_KEYS,
  MCP_SESSION_ENV_KEYS,
  resolveCatCafeNodeCommand,
} from '../../../../../config/capabilities/mcp-constants.js';
import { getCatContextWindowConfig, getCatEffort } from '../../../../../config/cat-config-loader.js';
import { getCatModel } from '../../../../../config/cat-models.js';
import {
  type CodexCarrierMode,
  getCodexApprovalPolicy,
  getCodexCarrierMode,
  getCodexOAuthTransport,
  getCodexSandboxMode,
} from '../../../../../config/codex-cli.js';
import { estimateCostFromTokens } from '../../../../../config/model-pricing.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { buildCliDiagnostics } from '../../../../../utils/cli-diagnostics.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import {
  isCliError,
  isCliTimeout,
  isLivenessWarning,
  KILL_GRACE_MS,
  spawnCli,
} from '../../../../../utils/cli-spawn.js';
import { parseCliTimeoutMs, resolveCliTimeoutMs } from '../../../../../utils/cli-timeout.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';
import { sanitizeCliStderr } from '../../../../../utils/sanitize-cli-stderr.js';
import { AuditEventTypes, getEventAuditLog } from '../../orchestration/EventAuditLog.js';
import { CliRawArchive } from '../../session/CliRawArchive.js';
import type {
  AgentCarrierSession,
  AgentCarrierSessionOptions,
  AgentFreshnessCarrierCapability,
  AgentMessage,
  AgentService,
  AgentServiceOptions,
  MessageMetadata,
  TokenUsage,
  ToolExecutionPolicy,
} from '../../types.js';
import type { AuditLogSink, RawArchiveSink } from '../providers/codex-audit-hooks.js';
import { extractCommandExecutionLifecycle, sanitizeRawEvent } from '../providers/codex-audit-hooks.js';
import { type CodexStreamState, finalizeCodexStream, transformCodexEvent } from '../providers/codex-event-transform.js';
import { scanAndPublishCodexImages } from '../providers/codex-image-scanner.js';
import {
  type CodexSessionContextSnapshotResolver,
  createCodexSessionContextSnapshotResolver,
} from '../providers/codex-session-context-snapshot.js';
import { extractImagePaths } from '../providers/image-paths.js';
import type { CodexAppServerLifecycleEvent, CodexAppServerLifecycleSnapshot } from './CodexAppServerClient.js';
import type { CodexAppServerHostPool } from './CodexAppServerHostPool.js';
import { recordCodexAppServerLifecycle } from './CodexAppServerLifecycleRegistry.js';
import {
  type CodexAppServerRecoveryBlockedEvent,
  type CodexAppServerRecoveryEvent,
  runCodexAppServerWithRecovery,
} from './CodexAppServerRunner.js';
import {
  appendCatCafeGithubWriteRouting,
  CODEX_APPS_WRITE_APPROVAL_ARGS,
  type CodexApprovalSurface,
} from './codex-app-approval-routing.js';
import { classifyCodexExecToolSurface } from './codex-app-server-boundary.js';
import { buildCodexCapacityRecoveryCardMessage } from './codex-capacity-recovery-card.js';
import { createDirectAgentCarrierSession } from './DirectAgentCarrierSession.js';
import { compileL0ViaSubprocess } from './l0-compiler.js';
import {
  bindSessionCredentialFile,
  type PreparedCredentialEnv,
  resolveSessionCredentialFile,
  writeSessionCredentialFile,
} from './session-credential-file.js';

const log = createModuleLogger('codex-agent');

function isCodexAppServerLifecycleEvent(value: unknown): value is CodexAppServerLifecycleEvent {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { type?: unknown }).type === 'app_server.lifecycle';
}

function isCodexAppServerRecoveryEvent(value: unknown): value is CodexAppServerRecoveryEvent {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { type?: unknown }).type === 'app_server.recovery';
}

function isCodexAppServerRecoveryBlockedEvent(value: unknown): value is CodexAppServerRecoveryBlockedEvent {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { type?: unknown }).type === 'app_server.recovery_blocked';
}

function isCodexThreadStartedEvent(value: unknown): value is { type: 'thread.started'; thread_id: string } {
  if (!value || typeof value !== 'object') return false;
  const event = value as { type?: unknown; thread_id?: unknown };
  return event.type === 'thread.started' && typeof event.thread_id === 'string';
}

function withoutFrozenInvocationCredentials(
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const safe = { ...env };
  delete safe.CAT_CAFE_INVOCATION_ID;
  delete safe.CAT_CAFE_CALLBACK_TOKEN;
  return safe;
}

function withoutSessionScopedHostEnv(env: Record<string, string | null>): Record<string, string | null> {
  const safe = { ...env };
  for (const key of [...MCP_CALLBACK_ENV_KEYS, ...MCP_SESSION_ENV_KEYS]) delete safe[key];
  return safe;
}

function removeCredentialFileFromMcpConfig(config: Record<string, unknown>): void {
  visitMcpConfigEnvironments(config, (env) => delete env.CAT_CAFE_CREDENTIAL_FILE);
}

function replaceCredentialFileInMcpConfig(config: Record<string, unknown>, path: string): void {
  visitMcpConfigEnvironments(config, (env) => {
    if (typeof env.CAT_CAFE_CREDENTIAL_FILE === 'string') env.CAT_CAFE_CREDENTIAL_FILE = path;
  });
}

function visitMcpConfigEnvironments(
  config: Record<string, unknown>,
  visit: (env: Record<string, unknown>) => void,
): void {
  const servers = config.mcp_servers;
  if (!isCodexConfigObject(servers)) return;
  for (const server of Object.values(servers)) {
    if (!isCodexConfigObject(server)) continue;
    if (isCodexConfigObject(server.env)) visit(server.env);
  }
}

function resolvePooledCredentialForLease(args: {
  current: PreparedCredentialEnv | null;
  sessionId?: string;
  reusedSessionHost?: boolean;
  namespace: string;
  callbackEnv?: Record<string, string>;
  config: Record<string, unknown>;
}): PreparedCredentialEnv | null {
  if (!args.current || !args.sessionId || args.reusedSessionHost !== false) return args.current;
  const replacement = resolveSessionCredentialFile(args.namespace, args.callbackEnv);
  if (replacement) replaceCredentialFileInMcpConfig(args.config, replacement.path);
  return replacement;
}

const APP_SERVER_LIFECYCLE_STATUS = {
  child_spawned: 'thinking',
  initialized: 'thinking',
  thread_ready: 'thinking',
  turn_accepted: 'streaming',
  active: 'streaming',
  completed: 'done',
  interrupted: 'done',
  failed: 'done',
  closing: 'done',
  closed: 'done',
} as const satisfies Record<CodexAppServerLifecycleSnapshot['stage'], 'thinking' | 'streaming' | 'done'>;

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
  /** F254 D2 test/config seam. Default remains exec_json. */
  carrierMode?: CodexCarrierMode;
  /** Whether this host can synchronously present Codex App confirmations. */
  approvalSurface?: CodexApprovalSurface;
  /** Warm app-server host pool. Omitted keeps the per-invocation carrier. */
  appServerHostPool?: CodexAppServerHostPool;
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

// F212 Phase H (Sol runtime forensics 2026-07-09 → Sol Final确权 2026-07-10):
// a provider-side exit-1 suppress helper + item-tracking boolean + suppress branch
// used to live here. Sol's R3 push back forced deletion — cli-spawn / tmux-agent-
// spawner now decide via a unified `finalSemanticDone` predicate:
//   finalSemanticDone := localFinalTerminal === 'completed'
//                     || (localFinalTerminal === null && semanticDone)
// This closes the 2×2 truth table: turn.completed only → SUPPRESS; multi-turn
// completed→failed → SURFACE; signal-only-abort (no terminal event) → SUPPRESS
// (Group A contract); nothing → SURFACE. `turn.completed` alone does NOT prove
// the invocation succeeded — the chronologically-LAST terminal event decides.
// Archive witnesses: 97449e4b (cyber-safety), 7c3fd591 / 2ffa505f / 261c3754 /
// 39f2bc4d (5 substantive completions each with turn.failed, misclassified as
// silent success under the deleted branch).
//
// The deleted identifiers are enumerated in `scripts/check-no-codex-provider-exit-suppression.mjs`
// FORBIDDEN_PATTERNS — that guard runs in `pnpm check` and MUST fail if anyone
// re-introduces them in this provider file. Do not name the deleted symbols here;
// point curious readers at the guard instead so the allowlist can stay tight.

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

const CODEX_SIGNATURE_BOUNDARY_INSTRUCTION =
  'Codex output boundary: do not append the cat signature to commentary/progress messages; append it exactly once, only at the end of the final response.';

/** Build the structured Codex reasoning-effort config argument. */
export function buildCodexReasoningArgs(effortLevel: string): string[] {
  return ['--config', `model_reasoning_effort=${toTomlString(effortLevel)}`];
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
 * Pencil resolver entries are resolved at invoke time via resolvePencilCommand
 * (same pattern as ClaudeAgentService). streamableHttp is supported via
 * --config mcp_servers.X.url=... injection.
 */
async function buildCatCafeMcpArgs(
  callbackEnv?: Record<string, string>,
  workingDirectory?: string,
): Promise<{ args: string[]; bearerEnv: Record<string, string> }> {
  if (!callbackEnv) return { args: [], bearerEnv: {} };

  /** Bearer tokens extracted from headers — keyed by env var name, valued by token. */
  const bearerEnv: Record<string, string> = {};

  const runtimeRoot = resolveBinaryRoot();
  const fileDir = dirname(fileURLToPath(import.meta.url));
  const moduleRepoRoot = findMonorepoRoot(fileDir);
  // The thread workingDirectory is the user's project/workspace. Clowder AI MCP
  // binaries are runtime-owned, so resolving from workingDirectory can pick a
  // fork checkout with incomplete node_modules and silently drop all MCP tools.
  const candidateRoots = [
    runtimeRoot,
    process.cwd(),
    moduleRepoRoot,
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
  if (!mcpDistDir) return { args: [], bearerEnv: {} };

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
    let accessScope: 'global' | 'project' = 'global';
    if (workingDirectory && workingDirectory !== capabilitiesProjectRoot) {
      try {
        const projectRaw = readFileSync(join(workingDirectory, '.cat-cafe', 'capabilities.json'), 'utf-8');
        const parsed = JSON.parse(projectRaw);
        if (parsed?.version === 1 || parsed?.version === 2) {
          capConfig = parsed;
          configSourceRoot = workingDirectory;
          accessScope = 'project';
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
      for (const s of resolveServersForCat(capConfig, catId, { accessScope }) as Array<{
        name: string;
        enabled: boolean;
        command: string;
        args?: string[];
        env?: Record<string, string>;
        resolver?: string;
        transport?: string;
        url?: string;
        headers?: Record<string, string>;
        source: string;
        workingDir?: string;
      }>) {
        // Suppress disabled servers with a complete dummy shape so any stale
        // .codex/config.toml entries cannot revive. Bare `enabled=false` fails
        // Codex ≥0.142 schema validation (requires transport fields); including
        // command+args satisfies the schema — same principle as the legacy
        // `cat-cafe` shim above (L371-379).
        if (!s.enabled) {
          disabledServers.push(s.name);
          const dummyToml = /^[A-Za-z0-9_-]+$/.test(s.name) ? s.name : `"${s.name}"`;
          if (s.transport === 'streamableHttp' && s.url) {
            // URL-based disabled: emit url + enabled=false to avoid transport
            // conflict with stale config.toml URL entries — overlaying stdio
            // fields (command/args) on an existing URL TOML table causes Codex
            // CLI error "url is not supported for stdio".
            args.push(
              '--config',
              `mcp_servers.${dummyToml}.url=${toTomlString(s.url)}`,
              '--config',
              `mcp_servers.${dummyToml}.enabled=false`,
            );
          } else {
            args.push(
              '--config',
              `mcp_servers.${dummyToml}.command="echo"`,
              '--config',
              `mcp_servers.${dummyToml}.args=[${toTomlString('disabled-shim')}]`,
              '--config',
              `mcp_servers.${dummyToml}.enabled=false`,
            );
          }
          continue;
        }
        // Pencil: resolver-backed entry — resolve the binary at invoke time
        // (same pattern as ClaudeAgentService). The resolver scans the local
        // machine for the latest Pencil MCP binary and returns {command, args}.
        if (s.resolver === 'pencil') {
          const tomlName = /^[A-Za-z0-9_-]+$/.test(s.name) ? s.name : `"${s.name}"`;
          const pencil = await resolvePencilCommand({ projectRoot: configSourceRoot });
          if (pencil) {
            enabledServers.push(s.name);
            const argsToml = pencil.args.map(toTomlString).join(', ');
            args.push(
              '--config',
              `mcp_servers.${tomlName}.command=${toTomlString(pencil.command)}`,
              '--config',
              `mcp_servers.${tomlName}.args=[${argsToml}]`,
              '--config',
              `mcp_servers.${tomlName}.enabled=true`,
            );
          } else {
            // No pencil installation found — emit disabled dummy to prevent
            // stale .codex/config.toml entries from reviving an old binary.
            disabledServers.push(s.name);
            args.push(
              '--config',
              `mcp_servers.${tomlName}.command="echo"`,
              '--config',
              `mcp_servers.${tomlName}.args=[${toTomlString('disabled-shim')}]`,
              '--config',
              `mcp_servers.${tomlName}.enabled=false`,
            );
          }
          continue;
        }

        // streamableHttp: inject URL directly (Codex CLI supports `--url` / `mcp_servers.X.url`).
        // Auth: Codex uses `bearer_token_env_var` (not arbitrary headers). If the
        // descriptor has an `Authorization: Bearer <token>` header, we extract
        // the token into an env var and point `bearer_token_env_var` at it.
        if (s.transport === 'streamableHttp' && s.url) {
          enabledServers.push(s.name);
          const tomlName = /^[A-Za-z0-9_-]+$/.test(s.name) ? s.name : `"${s.name}"`;
          args.push(
            '--config',
            `mcp_servers.${tomlName}.url=${toTomlString(s.url)}`,
            '--config',
            `mcp_servers.${tomlName}.enabled=true`,
          );
          // Map Authorization: Bearer <token> → bearer_token_env_var (#1074)
          // Header lookup is case-insensitive (HTTP headers are case-insensitive per RFC 7230).
          const rawAuthHeader = s.headers
            ? Object.entries(s.headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1]
            : undefined;
          if (rawAuthHeader) {
            // Resolve ${ENV_VAR} placeholders before extraction — same semantics as
            // mcp-probe.ts resolveEnvVarsInRecord (supports `Bearer ${TOKEN}` patterns).
            const authHeader = rawAuthHeader.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '');
            const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
            if (bearerMatch) {
              // Env var name must be collision-proof: distinct MCP names that differ
              // only by punctuation (e.g. `foo-bar` vs `foo_bar`) would otherwise
              // map to the same env var, routing one server's token to another.
              // Append a short stable hash of the raw name for uniqueness.
              const sanitized = s.name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
              const hash = createHash('sha256').update(s.name).digest('hex').slice(0, 8);
              const envVarName = `CAT_CAFE_MCP_BEARER_${sanitized}_${hash}`;
              bearerEnv[envVarName] = bearerMatch[1];
              args.push('--config', `mcp_servers.${tomlName}.bearer_token_env_var=${toTomlString(envVarName)}`);
            }
          }
          continue;
        }

        let cmd: string | undefined;
        let cmdArgs: string[] | undefined;
        let envEntries: Record<string, string> | undefined;
        // Managed split: source='cat-cafe' + name in entrypoint map.
        // Same-repo external migration shapes (F193): source='external' but
        // binary suffix matches our own split entrypoint — these arise from
        // ensureCatCafeMainServer when hasAnyId prevents managed entry creation.
        // Both MUST resolve binary from current mcpDistDir (not the entry's
        // args[0], which may hold a stale worktree absolute path) and receive
        // managed env injection (callback env, workspace dirs, approval mode).
        const isManagedCatCafe = s.source === 'cat-cafe' && CAT_CAFE_SPLIT_ENTRYPOINTS.has(s.name);
        const isSameRepoSplit =
          !isManagedCatCafe &&
          s.source === 'external' &&
          CAT_CAFE_SPLIT_ENTRYPOINTS.has(s.name) &&
          typeof s.args?.[0] === 'string' &&
          s.args[0].replace(/\\/g, '/').endsWith(`packages/mcp-server/dist/${CAT_CAFE_SPLIT_ENTRYPOINTS.get(s.name)}`);
        const isCatCafe = isManagedCatCafe || isSameRepoSplit;
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
          for (const key of [...MCP_CALLBACK_ENV_KEYS, ...MCP_SESSION_ENV_KEYS]) {
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
      for (const key of [...MCP_CALLBACK_ENV_KEYS, ...MCP_SESSION_ENV_KEYS]) {
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
  return { args, bearerEnv };
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

/** Keep only app-server/global config flags; exec-only prompt/image flags use protocol params. */
export function buildCodexAppServerArgs(args: readonly string[]): string[] {
  const out = ['app-server', '--stdio'];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--config' || flag === '-c' || flag === '--enable' || flag === '--disable') {
      const value = args[index + 1];
      if (value !== undefined) {
        out.push(flag, value);
        index++;
      }
    }
  }
  return out;
}

/** Convert Codex CLI `--config key=<toml>` pairs into app-server thread config. */
export function codexConfigObjectFromArgs(args: readonly string[]): Record<string, unknown> {
  let config: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag !== '--config' && flag !== '-c') continue;
    const assignment = args[index + 1];
    if (assignment !== undefined) {
      const overlay = parseToml(assignment) as Record<string, unknown>;
      config = mergeCodexConfig(config, overlay);
      index++;
    }
  }
  return config;
}

function mergeCodexConfig(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const previous = merged[key];
    merged[key] =
      isCodexConfigObject(previous) && isCodexConfigObject(value) ? mergeCodexConfig(previous, value) : value;
  }
  return merged;
}

function isCodexConfigObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  private readonly carrierMode: CodexCarrierMode;
  private readonly approvalSurface: CodexApprovalSurface;
  private readonly appServerHostPool: CodexAppServerHostPool | undefined;
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
    this.carrierMode = options?.carrierMode ?? getCodexCarrierMode();
    // Clowder AI currently has no synchronous approval request/response surface.
    // Keep this explicit so a future interactive bridge changes provenance rather
    // than relying on transport names or timing heuristics.
    this.approvalSurface = options?.approvalSurface ?? 'unavailable';
    this.appServerHostPool = options?.appServerHostPool;
  }

  /** F203 Phase C — this service injects L0 via `-c developer_instructions=` (Task 4). */
  injectsL0Natively(): boolean {
    return true;
  }

  supportsToolExecutionPolicy(policy: ToolExecutionPolicy): boolean {
    // exec_json has the proven --ignore-user-config + empty MCP hard fence.
    // app-server 0.144.4 exposes no equivalent ignore-user-config flag, so a
    // read-only supplement must fail before model launch instead of trusting
    // sandbox alone while user-configured MCP tools may still load.
    return policy.mode === 'read_only' && this.carrierMode === 'exec_json';
  }

  freshnessCarrierCapability(): AgentFreshnessCarrierCapability {
    return this.carrierMode === 'app_server'
      ? { provider: 'openai_codex', carrier: 'codex_app_server', deliverySemantics: 'exact_active_turn' }
      : { provider: 'openai_codex', carrier: 'codex_exec_json', deliverySemantics: 'unsupported' };
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
  private async compileDeveloperInstructions(
    cliModel: string,
    userId?: string,
  ): Promise<{ value: string } | { error: string; metadata: MessageMetadata }> {
    try {
      const compiledL0 = await this.l0CompilerFn({ catId: this.catId as string, userId });
      const separator = compiledL0.endsWith('\n') ? '\n' : '\n\n';
      const providerInstructions = `${compiledL0}${separator}${CODEX_SIGNATURE_BOUNDARY_INSTRUCTION}`;
      return { value: providerInstructions };
    } catch (err) {
      return {
        error: `L0 compile failed for ${this.catId as string}: ${(err as Error).message}`,
        metadata: { provider: 'openai', model: cliModel },
      };
    }
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const readOnly = options?.toolExecutionPolicy?.mode === 'read_only';
    // Codex CLI has no system prompt flag; prepend identity to prompt text
    const effectivePrompt = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;
    const effectiveModel = options?.callbackEnv?.CAT_CAFE_OPENAI_MODEL_OVERRIDE ?? this.model;
    const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
    const imageArgs = imagePaths.flatMap((path) => ['--image', path]);

    const sandboxMode = readOnly ? 'read-only' : getCodexSandboxMode();
    const approvalPolicy = readOnly ? 'never' : getCodexApprovalPolicy();
    const inheritedEffort = getCatEffort(this.catId as string, undefined, 'openai', effectiveModel);
    const effortLevel = resolveCliEffortOverride(
      'openai',
      effectiveModel,
      inheritedEffort,
      options?.reasoningEffortOverride,
    ).effective;
    const reasoningArgs = buildCodexReasoningArgs(effortLevel);
    const sandboxConfigArgs = ['--config', `sandbox_mode=${toTomlString(sandboxMode)}`];
    const approvalArgs = ['--config', `approval_policy="${approvalPolicy}"`];
    const ctxConfig = getCatContextWindowConfig(this.catId as string, effectiveModel);
    const contextWindowArgs: string[] = ctxConfig
      ? [
          '--config',
          `model_context_window=${ctxConfig.contextWindow}`,
          '--config',
          `model_auto_compact_token_limit=${ctxConfig.autoCompactTokenLimit}`,
        ]
      : [];
    // #712: Inject ALL enabled MCP servers from capabilities.json at invoke time.
    const appServerHostPool = this.appServerHostPool;
    const wantsPooledAppServer =
      this.carrierMode === 'app_server' &&
      process.platform !== 'win32' &&
      !readOnly &&
      !options?.agentCarrierSessionFactory &&
      !!appServerHostPool;
    const callbackHasInvocationCredentials =
      !!options?.callbackEnv?.CAT_CAFE_INVOCATION_ID && !!options?.callbackEnv?.CAT_CAFE_CALLBACK_TOKEN;
    const credentialNamespace = `codex:${this.catId}`;
    let pooledCredentialEnv: PreparedCredentialEnv | null = null;
    if (wantsPooledAppServer && callbackHasInvocationCredentials) {
      pooledCredentialEnv = resolveSessionCredentialFile(credentialNamespace, options?.callbackEnv, options?.sessionId);
    }
    // If credentials were expected but the owner-only refresh file could not be
    // prepared, retain the existing per-invocation carrier instead of launching
    // a pooled session whose MCP callbacks would be stale or unconfigured.
    const usePooledAppServer =
      wantsPooledAppServer && (!callbackHasInvocationCredentials || pooledCredentialEnv !== null);
    const mcpCallbackEnv = usePooledAppServer
      ? withoutFrozenInvocationCredentials(pooledCredentialEnv?.env ?? options?.callbackEnv)
      : options?.callbackEnv;
    const { args: catCafeMcpArgs, bearerEnv: mcpBearerEnv } = readOnly
      ? { args: [], bearerEnv: {} }
      : await buildCatCafeMcpArgs(mcpCallbackEnv, options?.workingDirectory);
    const gitRepoArgs = readOnly ? [] : buildGitRepoArgs(options?.workingDirectory);
    // User-defined CLI args from the member editor (#567) — passed as-is, no implicit wrapping.
    // Each entry is split by whitespace (e.g. "--config model_reasoning_effort=\"low\"").
    // F203 Phase C / 砚砚 P1: strip reserved system config keys (developer_instructions,
    // carries L0) before dedup — otherwise dedup() would skip the system push and the
    // L0 would be silently overridden by any cliConfigArgs entry with the same key.
    const userConfigArgs = stripReservedSystemConfigs(
      (readOnly ? [] : (options?.cliConfigArgs ?? [])).flatMap((arg) => arg.trim().split(/\s+/)),
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
    const authMode = getCodexAuthMode(options?.callbackEnv);

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
    // Default OAuth sessions to Codex's built-in OpenAI provider so upstream
    // transport selection and recovery behavior stay intact. Incident
    // 2026-07-01 required an HTTPS-only workaround for repeated websocket TLS
    // EOFs; retain that path behind CAT_CAFE_CODEX_OAUTH_TRANSPORT=https as a
    // hot-editable operational rollback. Keep name="OpenAI" because upstream
    // Codex gates remote compaction on provider identity. Never apply this to
    // custom/API-key providers.
    const oauthTransport = getCodexOAuthTransport();
    const builtinOpenaiProviderArgs: string[] =
      !customBaseUrl && authMode === 'oauth' && oauthTransport === 'builtin'
        ? ['--config', 'model_provider="openai"']
        : [];
    const openaiHttpsProviderArgs: string[] =
      !customBaseUrl && authMode === 'oauth' && oauthTransport === 'https'
        ? [
            '--config',
            'model_provider="openai_https"',
            '--config',
            'model_providers.openai_https.name="OpenAI"',
            '--config',
            'model_providers.openai_https.wire_api="responses"',
            '--config',
            'model_providers.openai_https.requires_openai_auth=true',
            '--config',
            'model_providers.openai_https.supports_websockets=false',
          ]
        : [];
    const providerArgs = customBaseUrl
      ? customProviderArgs
      : [...builtinOpenaiProviderArgs, ...openaiHttpsProviderArgs];

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
    const l0Result = await this.compileDeveloperInstructions(cliModel, options?.callbackEnv?.CAT_CAFE_USER_ID);
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
    const developerInstructions = appendCatCafeGithubWriteRouting(l0Result.value, this.approvalSurface);
    const developerInstructionsArgs = ['--config', `developer_instructions=${toTomlString(developerInstructions)}`];
    const appsWriteApprovalArgs = readOnly ? [] : [...CODEX_APPS_WRITE_APPROVAL_ARGS];

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
    const readOnlyArgs = readOnly
      ? ['--ignore-user-config', '--config', 'mcp_servers={}', '--config', 'apps._default.enabled=false']
      : [];

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
          ...readOnlyArgs,
          ...dedup(modelArgs),
          ...dedup(reasoningArgs),
          ...dedup(contextWindowArgs),
          ...dedup(sandboxConfigArgs),
          ...dedup(approvalArgs),
          ...dedup(appsWriteApprovalArgs),
          ...dedup(developerInstructionsArgs),
          ...dedup(providerArgs),
          ...userConfigArgs,
          ...gitRepoArgs,
          ...catCafeMcpArgs,
          ...imageArgs,
          ...promptArgs,
        ]
      : [
          'exec',
          '--json',
          ...readOnlyArgs,
          ...dedup(modelArgs),
          ...dedup(reasoningArgs),
          ...dedup(contextWindowArgs),
          '--sandbox',
          sandboxMode,
          ...(readOnly ? [] : ['--add-dir', '.git']),
          ...dedup(approvalArgs),
          ...dedup(appsWriteApprovalArgs),
          ...dedup(developerInstructionsArgs),
          ...dedup(providerArgs),
          ...userConfigArgs,
          ...gitRepoArgs,
          ...catCafeMcpArgs,
          ...imageArgs,
          ...promptArgs,
        ];
    const appServerArgs = buildCodexAppServerArgs([
      ...readOnlyArgs,
      ...dedup(modelArgs),
      ...dedup(reasoningArgs),
      ...dedup(contextWindowArgs),
      ...dedup(appsWriteApprovalArgs),
      ...dedup(providerArgs),
      ...userConfigArgs,
      ...(usePooledAppServer ? [] : catCafeMcpArgs),
    ]);
    const appServerThreadConfig = usePooledAppServer ? codexConfigObjectFromArgs(catCafeMcpArgs) : undefined;

    const metadata: MessageMetadata = { provider: 'openai', model: cliModel };
    const auditContext = options?.auditContext;
    const recentStreamErrors: string[] = [];
    let capacityRecoveryBlocked: CodexAppServerRecoveryBlockedEvent | null = null;

    try {
      // HOME isolation: only for API Key mode.
      // OAuth mode needs real HOME (~/.codex/auth.json for token refresh).
      // API Key mode must AVOID real HOME — stale OAuth token refresh will fail
      // and abort the CLI before it reaches the custom provider config.
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

      // #1074: Inject bearer token env vars extracted from streamableHttp headers.
      // Codex CLI reads bearer_token_env_var from process env at connect time.
      for (const [k, v] of Object.entries(mcpBearerEnv)) {
        codexEnv[k] = v;
      }
      if (readOnly) codexEnv.CAT_CAFE_READONLY = 'true';

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
        ...(options?.livenessProbe
          ? {
              livenessProbe: {
                ...options.livenessProbe,
                // Codex's launcher and CLI both treat SIGINT as cooperative cancellation.
                // Keep this provider-scoped: other CLIs retain terminate-first semantics.
                stallTerminationMode: 'interrupt-first' as const,
              },
            }
          : {}),
        ...(options?.parentSpan ? { parentSpan: options.parentSpan } : {}),
        semanticCompletionSignal: semanticCompletionController.signal,
      };
      const useAppServer = this.carrierMode === 'app_server';
      const appServerEnv = usePooledAppServer ? withoutSessionScopedHostEnv(codexEnv) : codexEnv;
      let pooledSessionInUse = false;
      let forceDirectAppServer = false;
      const createPooledSession = async (sessionOptions: AgentCarrierSessionOptions): Promise<AgentCarrierSession> => {
        if (forceDirectAppServer) {
          return createDirectAgentCarrierSession({ ...sessionOptions, env: codexEnv });
        }
        if (!appServerHostPool) {
          return createDirectAgentCarrierSession({ ...sessionOptions, env: codexEnv });
        }
        const wire = await appServerHostPool.createSession({
          ...sessionOptions,
          // The protocol client owns cooperative cancellation. The pool only
          // observes the signal to reap a lease if that cleanup path is abandoned.
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        pooledCredentialEnv = resolvePooledCredentialForLease({
          current: pooledCredentialEnv,
          sessionId: sessionOptions.sessionId,
          reusedSessionHost: wire.reusedSessionHost,
          namespace: credentialNamespace,
          callbackEnv: options?.callbackEnv,
          config: appServerThreadConfig ?? {},
        });
        if (callbackHasInvocationCredentials && !pooledCredentialEnv) {
          await wire.close().catch(() => {});
          forceDirectAppServer = true;
          removeCredentialFileFromMcpConfig(appServerThreadConfig ?? {});
          return createDirectAgentCarrierSession({ ...sessionOptions, env: codexEnv });
        }
        if (pooledCredentialEnv && !writeSessionCredentialFile(options?.callbackEnv, pooledCredentialEnv.path)) {
          await wire.close().catch(() => {});
          forceDirectAppServer = true;
          removeCredentialFileFromMcpConfig(appServerThreadConfig ?? {});
          return createDirectAgentCarrierSession({ ...sessionOptions, env: codexEnv });
        }
        pooledSessionInUse = true;
        return wire;
      };
      const events = useAppServer
        ? runCodexAppServerWithRecovery({
            sessionFactory:
              options?.agentCarrierSessionFactory ??
              (usePooledAppServer && appServerHostPool ? createPooledSession : createDirectAgentCarrierSession),
            sessionOptions: {
              command: codexCommand,
              args: appServerArgs,
              ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
              env: appServerEnv,
              ...(options?.signal ? { signal: options.signal } : {}),
              invocationId: options?.invocationId ?? `codex-app-server-${Date.now()}`,
              ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
            },
            runInput: {
              prompt: effectivePrompt,
              thread: options?.sessionId
                ? { kind: 'resume' as const, threadId: options.sessionId }
                : { kind: 'start' as const },
              model: cliModel,
              ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
              sandbox: sandboxMode,
              approvalPolicy,
              developerInstructions,
              ...(appServerThreadConfig ? { config: appServerThreadConfig } : {}),
              imagePaths,
              ...(options?.signal ? { signal: options.signal } : {}),
              timeoutMs: resolveCliTimeoutMs(parseCliTimeoutMs(codexEnv.CLI_TIMEOUT_MS ?? undefined)),
              interruptGraceMs: KILL_GRACE_MS,
            },
            retryBudget: 1,
            ...(options?.recoveryAnchor ? { recoveryAnchor: options.recoveryAnchor } : {}),
            clientDeps: {
              ...(options?.activeInvocationFreshness ? { freshnessController: options.activeInvocationFreshness } : {}),
              ...(auditContext
                ? {
                    onLifecycle: (lifecycle: CodexAppServerLifecycleSnapshot) => {
                      recordCodexAppServerLifecycle({
                        threadId: auditContext.threadId,
                        catId: auditContext.catId,
                        invocationId: auditContext.executionId ?? auditContext.invocationId,
                        lifecycle,
                      });
                    },
                    onEnvelope: async (direction: 'inbound' | 'outbound', envelope: Record<string, unknown>) => {
                      try {
                        await this.rawArchive.append(auditContext.invocationId, {
                          transport: 'codex_app_server',
                          direction,
                          envelope: sanitizeRawEvent(envelope),
                        });
                      } catch (err) {
                        log.warn(
                          { err, invocationId: auditContext.invocationId },
                          '[audit] Codex app-server envelope archive write failed',
                        );
                      }
                    },
                  }
                : {}),
            },
          })
        : options?.spawnCliOverride
          ? options.spawnCliOverride(cliOpts)
          : spawnCli(cliOpts, this.spawnFn ? { spawnFn: this.spawnFn } : undefined);

      // F212 Phase H: item-tracking boolean deleted (see delete-block comment above).
      // cli-spawn / tmux-agent-spawner decide via `finalSemanticDone` (see delete-block
      // definition) — chronological last terminal decides, not just "any completion
      // ever fired". Provider-side "did any substantive event pass through"
      // bookkeeping is duplicate + drift-prone. Codex 0.98+ recovery quirks
      // (compaction retry, turn.failed then new turn.started + turn.completed)
      // are handled canonically at spawn layer via localFinalTerminal tracking.
      const catConfig = catRegistry.tryGet(this.catId as string)?.config;
      const signatureIdentity = catConfig?.nickname?.trim() || catConfig?.displayName?.trim();
      const codexStreamState: CodexStreamState = {
        hadPriorTextTurn: false,
        ...(signatureIdentity
          ? {
              signatureIdentity,
              canonicalSignature: `[${signatureIdentity}/${effectiveModel}🐾]`,
            }
          : {}),
      };

      for await (const event of events) {
        if (pooledSessionInUse && pooledCredentialEnv && isCodexThreadStartedEvent(event)) {
          bindSessionCredentialFile(credentialNamespace, event.thread_id, pooledCredentialEnv.path);
        }
        if (isCodexAppServerLifecycleEvent(event)) {
          yield {
            // Internal carrier state must stay on the status channel. system_info
            // is fail-open/user-visible in older browser bundles, so a runtime
            // restart could otherwise render raw lifecycle JSON in every live thread.
            type: 'status' as const,
            catId: this.catId,
            content: APP_SERVER_LIFECYCLE_STATUS[event.lifecycle.stage],
            metadata: {
              ...metadata,
              diagnostics: {
                appServerLifecycle: event.lifecycle,
              },
            },
            timestamp: event.lifecycle.lastActivityAt,
          };
          continue;
        }
        if (isCodexAppServerRecoveryEvent(event)) {
          yield {
            type: 'status' as const,
            catId: this.catId,
            content: 'thinking',
            metadata: {
              ...metadata,
              diagnostics: {
                appServerRecovery: event,
              },
            },
            timestamp: Date.now(),
          };
          continue;
        }
        if (isCodexAppServerRecoveryBlockedEvent(event)) {
          capacityRecoveryBlocked = event;
          yield buildCodexCapacityRecoveryCardMessage({
            catId: this.catId,
            metadata,
            event,
          });
          continue;
        }
        collectCodexStreamError(event, recentStreamErrors);

        if (!useAppServer && options?.activeInvocationFreshness) {
          const toolSurface = classifyCodexExecToolSurface(event);
          if (toolSurface) {
            try {
              const notice = await options.activeInvocationFreshness.prepare({
                threadId: auditContext?.threadId ?? 'unknown',
                turnId: options.invocationId ?? 'codex-exec-json',
                toolSurface,
              });
              if (notice) await options.activeInvocationFreshness.markMissed(notice, 'unsupported_carrier');
            } catch (err) {
              log.warn({ err, invocationId: options.invocationId }, '[F254-D2] exec freshness telemetry failed');
            }
          }
        }

        if (auditContext && !useAppServer) {
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
              terminalContext: event.terminalContext,
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
          // F212 Phase H (Sol runtime forensics 2026-07-09 → Final确权 2026-07-10):
          // suppress branch DELETED. Provider layer previously masked exit=1-with-
          // substantive-output as a Codex 0.98+ false-positive; empirically that
          // masked 5 real terminal failures in 4 threads (archive pool 97449e4b /
          // 7c3fd591 / 2ffa505f / 261c3754 / 39f2bc4d), all with real turn.failed
          // upstream. Canonical truth source: cli-spawn synthesizes __cliError only
          // when !finalSemanticDone (spawnCli.ts + tmux-agent-spawner.ts), where
          //   finalSemanticDone := localFinalTerminal === 'completed'
          //                     || (localFinalTerminal === null && semanticDone)
          // — chronological `turn.failed` outranks a prior sticky abort (cloud R5
          // multi-turn fix), and the `sig aborted with no terminal event` contract
          // (Group A in cli-spawn.test.js) is preserved via the fallback. Any
          // isCliError reaching here is authentic — pass through.
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

        // F212 Phase H: item.completed tracking removed (was used only for the deleted
        // suppress branch above). turn.completed / turn.failed handling below fires
        // semanticCompletionController.abort() → cli-spawn's `finalSemanticDone` fallback
        // (cell 3: signal aborted with no terminal event ever seen → still suppress).

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
            if (!useAppServer && options?.activeInvocationFreshness) {
              try {
                await options.activeInvocationFreshness.markTurnCompleted(options.invocationId ?? 'codex-exec-json');
              } catch (err) {
                log.warn({ err, invocationId: options.invocationId }, '[F254-D2] exec terminal freshness audit failed');
              }
            }
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

        const result = transformCodexEvent(event, this.catId, codexStreamState, {
          approvalSurface: this.approvalSurface,
        });
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

      const finalSignature = finalizeCodexStream(codexStreamState, this.catId);
      if (finalSignature) {
        yield { ...finalSignature, metadata };
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
      const rawError = err instanceof Error ? err.message : String(err);
      const visibleError = capacityRecoveryBlocked
        ? `自动续跑已安全停止（${capacityRecoveryBlocked.reason}）；系统已保留并显示本轮断点，没有猜测或切换任务。`
        : rawError;
      const errorMetadata =
        this.carrierMode === 'app_server'
          ? {
              ...metadata,
              ...(capacityRecoveryBlocked
                ? {
                    upstreamError: {
                      kind: 'capacity' as const,
                      transient: true,
                      rawReason: rawError,
                    },
                  }
                : {}),
              cliDiagnostics: buildCliDiagnostics({
                rawText: rawError,
                // `structuredErrorText` is reserved for Claude result events. Raw Codex
                // transport failures must stay on provider-neutral classifier/unknown paths.
                debugRef: {
                  command: 'codex app-server',
                  exitCode: null,
                  signal: null,
                  ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
                },
              }),
            }
          : metadata;
      yield {
        type: 'error',
        catId: this.catId,
        error: visibleError,
        metadata: errorMetadata,
        timestamp: Date.now(),
      };
      // Guarantee done after error so invoke-single-cat can set isFinal correctly
      yield { type: 'done', catId: this.catId, metadata: errorMetadata, timestamp: Date.now() };
    }
  }
}
