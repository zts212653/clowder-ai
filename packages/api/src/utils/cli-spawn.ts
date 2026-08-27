/**
 * CLI Process Spawner
 * 通用 CLI 子进程管理器，处理生命周期、超时和清理
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Span } from '@opentelemetry/api';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { createModuleLogger } from '../infrastructure/logger.js';
import { registerLivenessProbe, unregisterLivenessProbe } from '../infrastructure/telemetry/instruments.js';
import { emitOtelLog } from '../infrastructure/telemetry/otel-logger.js';
import {
  CliTerminationController,
  type CliTerminationGraces,
  type CliTerminationMode,
} from './CliTerminationController.js';
import {
  buildCliDiagnostics,
  buildCliExitDiagnostic,
  type CliDiagnostics,
  type CliErrorReasonCode,
  type CliTimeoutTerminalContext,
  formatCliStderrForLog,
} from './cli-diagnostics.js';
import { CLI_EXECUTION_ID_ENV, CLI_EXECUTION_OWNER_BINDING_ENV } from './cli-process-ownership.js';
import { invalidateCliCommand } from './cli-resolve.js';
import { resolveWindowsSpawnPlan } from './cli-spawn-win.js';
import { buildUnixSupervisedSpawnPlan } from './cli-supervised-process.js';
import { resolveCliTimeoutMs } from './cli-timeout.js';

export { resolveCliSupervisorNodeArgs } from './cli-supervised-process.js';

import type { ChildProcessLike, CliSpawnOptions, SpawnFn } from './cli-types.js';
import { isParseError, parseNDJSON } from './ndjson-parser.js';
import { ProcessLivenessProbe } from './ProcessLivenessProbe.js';
import { sanitizeCliStderr } from './sanitize-cli-stderr.js';

const log = createModuleLogger('cli-spawn');

const IS_WINDOWS = process.platform === 'win32';
const CAT_CAFE_RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const GUARDED_GH_BIN = resolve(CAT_CAFE_RUNTIME_ROOT, 'scripts', 'guarded-bin');
const GUARDED_ZSH_DIR = resolve(CAT_CAFE_RUNTIME_ROOT, 'scripts', 'guarded-zsh');
type GuardedChildEnv = Record<string, string | null | undefined>;
type SourceEnvOverrides = Readonly<Record<string, string | null>> | undefined;

function hasSourceOverride(sourceOverrides: SourceEnvOverrides, key: string): boolean {
  return sourceOverrides !== undefined && Object.hasOwn(sourceOverrides, key);
}

function shouldRefreshOriginalZdotdir(
  env: GuardedChildEnv,
  sourceOverrides: SourceEnvOverrides,
  currentZdotdir: string,
): boolean {
  if (hasSourceOverride(sourceOverrides, 'CAT_CAFE_ORIGINAL_ZDOTDIR')) return false;
  if (resolve(currentZdotdir) === GUARDED_ZSH_DIR) return false;
  return hasSourceOverride(sourceOverrides, 'ZDOTDIR') || !env.CAT_CAFE_ORIGINAL_ZDOTDIR;
}

function shouldRefreshHistfile(env: GuardedChildEnv, sourceOverrides: SourceEnvOverrides): boolean {
  if (hasSourceOverride(sourceOverrides, 'HISTFILE')) return false;
  return hasSourceOverride(sourceOverrides, 'ZDOTDIR') || !env.HISTFILE;
}

function configureGuardedZshEnv(env: GuardedChildEnv, sourceOverrides: SourceEnvOverrides): void {
  const currentZdotdir = env.ZDOTDIR ?? env.HOME ?? process.env.HOME;
  // An explicit ZDOTDIR selects a new startup context. Refresh inherited companion values unless
  // the caller supplied those companions explicitly; otherwise parent-shell state leaks across contexts.
  if (currentZdotdir && shouldRefreshOriginalZdotdir(env, sourceOverrides, currentZdotdir)) {
    env.CAT_CAFE_ORIGINAL_ZDOTDIR = currentZdotdir;
  }
  if (currentZdotdir && shouldRefreshHistfile(env, sourceOverrides)) {
    env.HISTFILE = resolve(currentZdotdir, '.zsh_history');
  }
  env.SHELL_SESSIONS_DISABLE ||= '1';
  env.ZDOTDIR = GUARDED_ZSH_DIR;
}

export function withVerdictGhGuardEnv<T extends Record<string, string | null | undefined>>(
  env: T,
  sourceOverrides?: Readonly<Record<string, string | null>>,
): T {
  if (IS_WINDOWS || !existsSync(resolve(GUARDED_GH_BIN, 'gh'))) return env;
  const mutable = env as Record<string, string | null | undefined>;
  const currentPath = typeof mutable.PATH === 'string' ? mutable.PATH : (process.env.PATH ?? '');
  const pathEntries = currentPath.split(':').filter(Boolean);
  if (!pathEntries.includes(GUARDED_GH_BIN)) {
    mutable.PATH = currentPath ? `${GUARDED_GH_BIN}:${currentPath}` : GUARDED_GH_BIN;
  }
  mutable.CAT_CAFE_VERDICT_GH_GUARD_ROOT = CAT_CAFE_RUNTIME_ROOT;
  mutable.CAT_CAFE_VERDICT_GH_GUARD_BIN = GUARDED_GH_BIN;
  if (existsSync(resolve(GUARDED_ZSH_DIR, '.zprofile'))) {
    configureGuardedZshEnv(mutable, sourceOverrides);
  }
  if (!mutable.CAT_CAFE_VERDICT_REPO_FULL_NAME) {
    mutable.CAT_CAFE_VERDICT_REPO_FULL_NAME =
      process.env.CAT_CAFE_VERDICT_REPO_FULL_NAME ?? process.env.CAT_CAFE_REPO_FULL_NAME ?? 'zts212653/cat-cafe';
  }
  return env;
}

/**
 * F212 Phase A — collect text from NDJSON stream `error` events. CLI providers (Codex, opencode)
 * often report real failure semantics in stream events rather than stderr (AC-A8).
 *
 * 云端 codex P2 (2026-05-26): JSON.stringify alone drops `Error` instance fields because
 * `message`/`name`/`stack` are non-enumerable on Error. We extract those explicitly so the
 * classifier regex can still see provider error text.
 *
 * 云端 codex round-5 P2 (2026-05-26): bounded sink growth — long-running sessions emitting
 * repeated error events would otherwise grow streamErrorTexts unbounded. Enforce entry +
 * char caps consistent with tmux nonJsonOutput buffer pattern (see tmux-agent-spawner.ts L294).
 */
const STREAM_ERROR_MAX_ENTRIES = 50;
const STREAM_ERROR_MAX_CHARS = 16384;

export function maybeCollectStreamError(value: unknown, sink: string[], structuredSink?: string[]): void {
  if (typeof value !== 'object' || value === null) return;
  const evt = value as Record<string, unknown>;
  const isErrorEvent = evt.type === 'error';
  // F212 Phase D: Claude CLI reports tool-call-parse failures via a result event whose shape is
  // counter-intuitive — verified against 7 real opus-4.8 archive samples (2026-05-29):
  //   {type:'result', subtype:'success', is_error:true, result:'...could not be parsed...', errors:null}
  // The authoritative error flag is `is_error===true` (NOT subtype — which stays 'success'); the cause
  // text lives in `result` (errors[] is null). We ALSO honor subtype!=='success' for any classic error
  // subtype CC may emit (e.g. error_during_execution / error_max_turns). This was the "未识别" root
  // cause: the result error never reached cliDiagnostics' rawText, and a subtype-only guard would
  // STILL have missed it because subtype is 'success'.
  const isResultError =
    evt.type === 'result' && (evt.is_error === true || (typeof evt.subtype === 'string' && evt.subtype !== 'success'));
  if (!isErrorEvent && !isResultError) return;
  // Bound: skip new entries once cap is reached (entries or total chars).
  if (sink.length >= STREAM_ERROR_MAX_ENTRIES) return;
  let currentChars = 0;
  for (const s of sink) currentChars += s.length;
  if (currentChars >= STREAM_ERROR_MAX_CHARS) return;
  // Explicit extraction of common error-shape fields (handles Error instances + plain objects)
  const explicitParts: string[] = [];
  const collectFrom = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object') return;
    if (obj instanceof Error) {
      explicitParts.push(`${obj.name ?? 'Error'}: ${obj.message ?? ''}`);
      return;
    }
    const r = obj as Record<string, unknown>;
    if (typeof r.name === 'string') explicitParts.push(r.name);
    if (typeof r.message === 'string') explicitParts.push(r.message);
    if (r.data && typeof r.data === 'object') {
      const d = r.data as Record<string, unknown>;
      if (typeof d.message === 'string') explicitParts.push(d.message);
      if (typeof d.statusCode === 'number') explicitParts.push(String(d.statusCode));
    }
  };
  collectFrom(evt.error);
  collectFrom(evt);
  // F212 Phase D: result error fields (errors[] / result) carry CC's emitted cause text
  // (e.g. "The model's tool call could not be parsed"). type==='error' events don't have these.
  if (isResultError) {
    if (Array.isArray(evt.errors)) {
      for (const e of evt.errors) if (typeof e === 'string' && e.trim()) explicitParts.push(e);
    }
    if (typeof evt.result === 'string' && evt.result.trim()) explicitParts.push(evt.result);
  }
  const remainingChars = STREAM_ERROR_MAX_CHARS - currentChars;
  const pushBounded = (entry: string): void => {
    sink.push(entry.length > remainingChars ? entry.slice(0, remainingChars) : entry);
  };
  // AC-D3: CC structured friendly message (explicitParts) → structuredSink for unknown fallback
  // display ("Claude Code 报告：<cause>"). Safe source — CC standard wording, not raw stderr.
  // Cloud codex P1 fix (2026-05-29 on da1f81763): MUST gate on isResultError so unclassified
  // type='error' events (whose explicitParts include arbitrary provider stderr-like content)
  // don't leak through AC-D3 → buildCliDiagnostics → safeExcerpt. Result events with is_error:true
  // remain the only "safe structured source" admitted to structuredSink (KD-1/AC-A9 red line).
  if (structuredSink && isResultError && explicitParts.length > 0) {
    const friendly = explicitParts.join('\n');
    structuredSink.push(friendly.length > remainingChars ? friendly.slice(0, remainingChars) : friendly);
  }
  try {
    const serialized = JSON.stringify(evt);
    pushBounded(explicitParts.length > 0 ? `${explicitParts.join('\n')}\n${serialized}` : serialized);
  } catch {
    // Circular ref / non-serializable — at least preserve the extracted text
    if (explicitParts.length > 0) pushBounded(explicitParts.join('\n'));
  }
}

function isStallAutoKillWarning(
  options: CliSpawnOptions,
  warning: unknown,
): warning is import('./ProcessLivenessProbe.js').LivenessWarningEvent {
  return (
    options.livenessProbe?.stallAutoKill === true &&
    isLivenessWarning(warning) &&
    warning.level === 'suspected_stall' &&
    warning.state === 'idle-silent'
  );
}

/** Grace period between SIGTERM and SIGKILL */
export const KILL_GRACE_MS = 3_000;

/** Codex gets a short cooperative interrupt window before the existing terminate path. */
export const INTERRUPT_GRACE_MS = 2_000;

/** Drain queued liveness warnings frequently without increasing the CPU sampling cadence. */
export const LIVENESS_WARNING_DRAIN_INTERVAL_MS = 1_000;

/** Final bounded window for close/stderr delivery after exit or the SIGKILL attempt. */
export const TERMINATION_STDIO_DRAIN_GRACE_MS = 100;

/** Grace period after semantic completion before force-killing a lingering process */
export const SEMANTIC_COMPLETION_GRACE_MS = 5_000;

/**
 * Options for spawnCli (dependency injection for testing)
 */
export interface CliSpawnerDeps {
  /** Inject a custom spawn function (for testing) */
  spawnFn?: SpawnFn;
  /** Short grace windows for lifecycle tests; production uses the exported constants. */
  terminationGraces?: Partial<CliTerminationGraces>;
  /** Test-only clock override; CPU sampling remains owned by ProcessLivenessProbe. */
  livenessWarningDrainIntervalMs?: number;
}

/** Env vars to strip from child processes to prevent E2BIG (overly large values). */
const ENV_VARS_TO_STRIP: ReadonlySet<string> = new Set([
  'LS_COLORS', // typically 1-2 KB of color mappings
  'LSCOLORS', // BSD/macOS equivalent
  // Runtime-only lifecycle capabilities must stop at the API process boundary.
  // Agent CLIs and terminal shells may launch commands inside feature worktrees;
  // forwarding either value would let a raw dev command act like the runtime owner.
  'CONNECTOR_GATEWAY_AUTOSTART',
  'CAT_CAFE_PROVISION_GLOBAL_SIDECAR',
  // Legacy F296 process-scoped bearer. Session hooks authenticate with the
  // invocation-bound callback pair; never leak a stale operator token to any child.
  'CAT_CAFE_HOOK_TOKEN',
  // Per-invocation process ownership is a capability, not ambient config. A
  // nested API or persistent host must not inherit the outer invocation.
  CLI_EXECUTION_OWNER_BINDING_ENV,
  CLI_EXECUTION_ID_ENV,
]);

export interface CliPlainTextResult {
  __cliPlainText: true;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  command: string;
}

function terminationStageForSignal(signal: NodeJS.Signals | undefined): CliTimeoutTerminalContext['finalStage'] {
  if (signal === 'SIGINT') return 'interrupt';
  if (signal === 'SIGTERM') return 'terminate';
  if (signal === 'SIGKILL') return 'kill';
  return 'none';
}

/** Stable, secret-free dimensions consumed by the F118/F212 timeout verdict. */
export function buildCliTimeoutTelemetryAttributes(terminal: CliTimeoutTerminalContext) {
  return {
    'cli.reason_code': terminal.kind === 'stall_timeout' ? 'cli_stall_timeout' : 'cli_response_timeout',
    'cli.timeout_reason': terminal.kind,
    'cli.timeout_ms': terminal.configuredTimeoutMs,
    'cli.silence_ms': terminal.observedSilenceDurationMs,
    'cli.process_alive_at_timeout': terminal.processAliveAtTimeout,
    'cli.first_termination_stage': terminationStageForSignal(terminal.signalsSent[0]),
    'cli.termination_stage': terminal.finalStage,
    'cli.termination_signals': terminal.signalsSent.join(','),
  } as const;
}

async function waitForIteratorUntil<T>(
  pending: Promise<IteratorResult<T>>,
  deadlineMs: number,
): Promise<IteratorResult<T> | undefined> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) return undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function buildChildEnv(
  overrides?: Record<string, string | null>,
  options: { bindExecutionOwner?: boolean; workingDirectory?: string } = {},
): NodeJS.ProcessEnv {
  // Clone process.env but strip known bloated vars to avoid E2BIG (ARG_MAX exceeded).
  const merged: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (ENV_VARS_TO_STRIP.has(key)) continue;
    merged[key] = value;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (ENV_VARS_TO_STRIP.has(key)) {
        delete merged[key];
        if (key === CLI_EXECUTION_ID_ENV && options.bindExecutionOwner === true && value !== null) {
          merged[key] = value;
        }
        continue;
      }
      if (value === null) {
        delete merged[key];
        continue;
      }
      merged[key] = value;
    }
  }
  // spawn.cwd and shell cwd env are distinct inputs. Providers such as OpenCode
  // consult PWD/INIT_CWD during bootstrap, so inherited runtime values must not
  // override the workspace assigned to the child process.
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  merged.PWD = workingDirectory;
  merged.INIT_CWD = workingDirectory;
  return withVerdictGhGuardEnv(merged, overrides);
}

/**
 * Spawns a CLI process and yields parsed NDJSON events from stdout.
 * On non-zero exit: yields __cliError. On timeout: yields __cliTimeout.
 * On spawn error (ENOENT): throws. Messages are sanitized (no raw stderr).
 */
export async function* spawnCli(
  options: CliSpawnOptions,
  deps?: CliSpawnerDeps,
): AsyncGenerator<unknown, void, undefined> {
  const doSpawn: SpawnFn = deps?.spawnFn ?? defaultSpawn;
  const livenessWarningDrainIntervalMs = deps?.livenessWarningDrainIntervalMs ?? LIVENESS_WARNING_DRAIN_INTERVAL_MS;
  // Default timeout is configurable via CLI_TIMEOUT_MS env var; 0 disables timeout.
  const timeoutMs = resolveCliTimeoutMs(options.timeoutMs);

  // Log only flag names (--foo) and arg count — never raw values.
  // Multiple providers pass prompt text via different shapes (positional,
  // --prompt, -p, after --) so pattern-based redaction is unreliable.
  const flagNames = options.args.filter((a) => a.startsWith('-'));
  log.debug(
    {
      command: options.command,
      flagNames,
      argCount: options.args.length,
      cwd: options.cwd,
      timeoutMs,
      invocationId: options.invocationId,
    },
    '[cli-spawn] Spawning CLI process',
  );

  const child = doSpawn(options.command, options.args, {
    cwd: options.cwd,
    env: buildChildEnv(options.env, {
      bindExecutionOwner: options.bindExecutionOwner !== false,
      workingDirectory: options.cwd,
    }),
    // Incident 2026-05-29 (cross-thread-context-contamination): when stdinInput is
    // provided, open stdin as a pipe so the prompt can be streamed off the command
    // line. Otherwise keep 'ignore' (unchanged for providers not using stdin).
    stdio: [options.stdinInput != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    bindExecutionOwner: options.bindExecutionOwner !== false,
  });

  // Incident 2026-05-29: feed prompt via stdin instead of argv to prevent
  // cross-process prompt leakage (`ps -o command=` / /proc/<pid>/cmdline can read
  // any concurrent process's full argv). The child reads it because the CLI is
  // invoked with PROMPT='-'.
  if (options.stdinInput != null) {
    const childStdin = child.stdin;
    if (childStdin) {
      // EPIPE guard: child may exit before consuming all stdin. EPIPE is expected
      // (child gone); surface anything else for future diagnosis (P2-1, opus-46 review).
      childStdin.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
          log.warn({ err, pid: child.pid, command: options.command }, 'Unexpected CLI stdin write error');
        }
      });
      childStdin.write(options.stdinInput);
      childStdin.end();
    }
  }

  log.debug({ pid: child.pid, command: options.command }, 'CLI process spawned');

  // F153 Phase B: Create CLI session child span under invocation span
  let cliSpan: Span | undefined;
  if (options.parentSpan) {
    const tracer = trace.getTracer('cat-cafe-api');
    const parentCtx = trace.setSpan(context.active(), options.parentSpan);
    cliSpan = tracer.startSpan(
      'cat_cafe.cli_session',
      {
        attributes: {
          'cli.command': options.command,
          'cli.arg_count': options.args.length,
          ...(child.pid ? { 'cli.pid': child.pid } : {}),
          ...(options.invocationId ? { invocationId: options.invocationId } : {}),
          ...(options.cliSessionId ? { sessionId: options.cliSessionId } : {}),
        },
      },
      parentCtx,
    );
  }

  // Buffer stderr for error reporting (handler attached after resetTimeout is defined)
  let stderrBuffer = '';

  // F212 AC-A8: collect NDJSON stream error event payloads alongside stderr
  const streamErrorTexts: string[] = [];
  // F212 Phase D (AC-D3): CC structured result error friendly messages (errors[]/result),
  // surfaced when reasonCode is unknown so the panel shows "Claude Code 报告：<cause>" not "未识别".
  const structuredErrorTexts: string[] = [];

  // Track child exit state (P1: prevents PID reuse kills)
  let childExited = false;
  let childClosed = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let closeWaitResolved = false;
  let resolveCloseWait!: () => void;
  const closePromise = new Promise<void>((resolve) => {
    resolveCloseWait = () => {
      if (closeWaitResolved) return;
      closeWaitResolved = true;
      resolve();
    };
  });

  let killed = false;
  let timedOut = false;
  let stallKilled = false; // #774: set when idle-silent stall triggers auto-kill
  let processAliveAtTimeout = false;
  let timeoutObservedSilenceMs: number | undefined;
  let terminalCause: 'response_timeout' | 'stall_timeout' | 'abort' | 'cleanup' | undefined;
  const terminationController = new CliTerminationController({
    child,
    isChildExited: () => childExited,
    graces: {
      interruptMs: deps?.terminationGraces?.interruptMs ?? INTERRUPT_GRACE_MS,
      terminateMs: deps?.terminationGraces?.terminateMs ?? KILL_GRACE_MS,
    },
    onTransition: ({ signal, stage, state, sequence }) => {
      const attributes = {
        command: options.command,
        ...(options.invocationId ? { invocationId: options.invocationId } : {}),
        signal,
        stage,
        state,
        sequence,
        cause: terminalCause ?? 'cleanup',
      };
      if (terminalCause === 'response_timeout' || terminalCause === 'stall_timeout') {
        log.warn(attributes, 'CLI termination signal sent');
      } else {
        log.debug(attributes, 'CLI termination signal sent');
      }
      cliSpan?.addEvent('cli.termination_signal', attributes);
    },
  });
  const terminationCommittedRace = terminationController
    .waitForCommit()
    .then(() => ({ source: 'termination' as const }));

  child.once('exit', (code, signal) => {
    childExited = true;
    exitCode = code;
    exitSignal = signal;
    terminationController.markExited();
    log.debug({ pid: child.pid, command: options.command, exitCode: code, signal }, 'CLI process exited');
  });
  child.once('close', (code: unknown, signal: unknown) => {
    childClosed = true;
    if (!childExited) {
      childExited = true;
      exitCode = typeof code === 'number' ? code : null;
      exitSignal = typeof signal === 'string' ? (signal as NodeJS.Signals) : null;
    }
    terminationController.markExited();
    log.debug({ pid: child.pid, command: options.command, exitCode, signal: exitSignal }, 'CLI process stdio closed');
    resolveCloseWait();
  });

  // Handle spawn errors (P2: ENOENT for command-not-found)
  let spawnError: Error | undefined;
  child.once('error', (err: Error) => {
    spawnError = err;
    // F173 Phase D AC-D1: ENOENT means cached path is stale (binary uninstalled,
    // symlink rebuild moved target, etc.). Drop the cache entry so the next
    // resolveCliCommand call re-probes; otherwise we ENOENT-loop forever
    // until process restart.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      invalidateCliCommand(options.command);
    }
  });

  function killChild(mode: CliTerminationMode = 'terminate-first', cause: typeof terminalCause = 'cleanup'): void {
    if (killed || childExited) return;
    terminalCause ??= cause;
    killed = terminationController.request(mode);
  }

  function commitTimeout(
    kind: 'response_timeout' | 'stall_timeout',
    observedSilenceDurationMs: number,
    mode: CliTerminationMode,
  ): boolean {
    if (timedOut || killed || childExited) return false;
    terminalCause = kind;
    timedOut = true;
    stallKilled = kind === 'stall_timeout';
    processAliveAtTimeout = !childExited;
    timeoutObservedSilenceMs = observedSilenceDurationMs;
    killChild(mode, kind);
    return true;
  }

  // Timeout: reset on any output, timeoutMs=0 disables
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const startedAt = Date.now(); // F118: for hard cap calculation
  let probe: ProcessLivenessProbe | undefined; // F118: declared early for closure access
  const resetTimeout = (): void => {
    if (timeoutMs === 0) return; // Disabled
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(() => {
      // F118: If busy-silent (CPU growing), extend timeout unless hard cap exceeded
      if (probe?.shouldExtendTimeout()) {
        const innerElapsed = Date.now() - startedAt;
        if (!probe.isHardCapExceeded(innerElapsed, timeoutMs)) {
          resetTimeout(); // extend once more
          return;
        }
      }
      const observedSilenceDurationMs = lastEventAt === null ? Date.now() - startedAt : Date.now() - lastEventAt;
      commitTimeout('response_timeout', observedSilenceDurationMs, 'terminate-first');
    }, timeoutMs);
    timeoutTimer.unref();
  };
  if (timeoutMs > 0) resetTimeout(); // Start initial timeout only if enabled

  // Attach stderr handler — collect output but do NOT extend timeout or probe.
  // stderr is transport/reconnect noise, not user-visible output. Extending
  // timeout on stderr was the root cause of the 30-min stall bug: chatter kept
  // resetting the timer so the callback never fired and the probe never reached
  // suspected_stall. Silence tracking (probe) is also not reset here.
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
  });

  // AbortSignal
  const abortHandler = (): void => killChild('terminate-first', 'abort');
  if (options.signal) {
    if (options.signal.aborted) {
      killChild('terminate-first', 'abort');
    } else {
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  // Zombie prevention (P1: guard with childExited to prevent PID reuse kills)
  const exitHandler = (): void => {
    if (!childExited && child.pid !== undefined) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // Process already gone
      }
    }
  };
  process.on('exit', exitHandler);

  // F118: Track NDJSON event timestamps for timeout diagnostics
  let firstEventAt: number | null = null;
  let lastEventAt: number | null = null;
  let lastEventType: string | null = null;
  /** F212 Phase H cloud R5 P2: chronological last terminal signal (defeats sticky abort). */
  let localFinalTerminal: 'completed' | 'failed' | null = null;

  // F118 Phase B: Initialize liveness probe
  if (options.livenessProbe && child.pid !== undefined) {
    probe = new ProcessLivenessProbe(child.pid, options.livenessProbe);
    probe.start();
    // F152: Register probe for OTel agentLiveness gauge
    if (options.invocationId) {
      const catId = options.env?.CAT_CAFE_CAT_ID ?? 'unknown';
      registerLivenessProbe(options.invocationId, catId, () => probe!.getState());
    }
  }

  const withStreamContext = (
    warning: import('./ProcessLivenessProbe.js').LivenessWarningEvent,
  ): import('./ProcessLivenessProbe.js').LivenessWarningEvent => ({
    ...warning,
    firstEventAt,
    lastEventAt,
    lastEventType,
  });

  let timeoutTerminalContext: CliTimeoutTerminalContext | undefined;
  let terminationStreamDrainDeadline: number | undefined;
  const snapshotTimeoutTerminalContext = (): CliTimeoutTerminalContext => ({
    kind: terminalCause === 'stall_timeout' ? 'stall_timeout' : 'response_timeout',
    configuredTimeoutMs: terminalCause === 'stall_timeout' ? (probe?.config.stallWarningMs ?? timeoutMs) : timeoutMs,
    observedSilenceDurationMs:
      timeoutObservedSilenceMs ?? (lastEventAt === null ? Date.now() - startedAt : Date.now() - lastEventAt),
    processAliveAtTimeout,
    postKillExitCode: exitCode,
    postKillSignal: exitSignal,
    signalsSent: terminationController.getSignalsSent(),
    finalStage: terminationController.getFinalStage(),
  });

  try {
    if (!child.stdout) {
      throw new Error(`CLI process ${options.command} has no stdout`);
    }

    // Throw on spawn error before iterating
    if (spawnError) {
      throw spawnError;
    }

    let plainTextResult: { stdout: string } | undefined;

    if (options.outputMode === 'plainText') {
      const stdoutChunks: string[] = [];
      const plaintext = (child.stdout as AsyncIterable<Buffer | string>)[Symbol.asyncIterator]();
      let pendingNext = plaintext.next();

      // Keep plainText providers protected by the same liveness fast-fail path
      // as NDJSON providers while still buffering raw stdout until completion.
      let pendingStallKill: import('./ProcessLivenessProbe.js').LivenessWarningEvent | undefined;

      for (;;) {
        if (spawnError) throw spawnError;

        if (probe && terminationStreamDrainDeadline === undefined) {
          for (const warning of probe.drainWarnings()) {
            yield withStreamContext(warning);
            if (isStallAutoKillWarning(options, warning)) {
              pendingStallKill = warning;
            }
          }
          if (probe.getState() === 'dead') {
            killChild('terminate-first', 'cleanup');
            break;
          }
        }

        let raceTimer: ReturnType<typeof setTimeout> | undefined;
        const stdoutRace = pendingNext.then((result) => ({ source: 'stdout' as const, result }));
        let raceResult = probe
          ? await Promise.race([
              stdoutRace,
              terminationCommittedRace,
              new Promise<{ source: 'probe' }>((resolve) => {
                const pollMs = Math.min(probe.config.sampleIntervalMs, livenessWarningDrainIntervalMs);
                raceTimer = setTimeout(() => resolve({ source: 'probe' }), pollMs);
              }),
            ])
          : await Promise.race([stdoutRace, terminationCommittedRace]);
        if (raceTimer !== undefined) clearTimeout(raceTimer);

        if (raceResult.source === 'termination') {
          terminationStreamDrainDeadline ??= Date.now() + TERMINATION_STDIO_DRAIN_GRACE_MS;
          const drained = await waitForIteratorUntil(pendingNext, terminationStreamDrainDeadline);
          if (!drained) break;
          raceResult = { source: 'stdout', result: drained };
        }

        if (raceResult.source === 'probe') {
          if (pendingStallKill) {
            commitTimeout(
              'stall_timeout',
              pendingStallKill.silenceDurationMs,
              options.livenessProbe?.stallTerminationMode ?? 'terminate-first',
            );
            break;
          }
          continue;
        }

        pendingStallKill = undefined;

        const { done, value } = raceResult.result;
        if (done) break;

        stdoutChunks.push(value.toString());
        if (terminationStreamDrainDeadline === undefined) {
          resetTimeout();
          if (probe) probe.notifyActivity();
        }
        const now = Date.now();
        if (firstEventAt === null) firstEventAt = now;
        lastEventAt = now;
        lastEventType = 'stdout';
        pendingNext = plaintext.next();
      }
      plainTextResult = { stdout: stdoutChunks.join('') };
    } else {
      const ndjson = parseNDJSON(child.stdout)[Symbol.asyncIterator]();
      let pendingNext = ndjson.next();

      // #774 R2: Deferred stall-kill — only execute when probe timer wins the race,
      // meaning no NDJSON event arrived. If NDJSON wins, the pending kill is cancelled
      // because CLI has recovered. This prevents the stale-warning race condition where
      // a recovery event is pending in the stream but hasn't been consumed yet.
      let pendingStallKill: import('./ProcessLivenessProbe.js').LivenessWarningEvent | undefined;

      for (;;) {
        if (spawnError) throw spawnError;

        // F118: Drain probe warnings and check for dead process
        if (probe && terminationStreamDrainDeadline === undefined) {
          for (const warning of probe.drainWarnings()) {
            yield withStreamContext(warning);
            // #774: Mark for deferred kill — don't kill here (recovery NDJSON may be pending)
            if (isStallAutoKillWarning(options, warning)) {
              pendingStallKill = warning;
            }
          }
          if (probe.getState() === 'dead') {
            killChild('terminate-first', 'cleanup');
            break;
          }
        }

        // Race NDJSON event vs probe poll interval
        let raceTimer: ReturnType<typeof setTimeout> | undefined;
        const ndjsonRace = pendingNext.then((result) => ({ source: 'ndjson' as const, result }));
        let raceResult = probe
          ? await Promise.race([
              ndjsonRace,
              terminationCommittedRace,
              new Promise<{ source: 'probe' }>((resolve) => {
                const pollMs = Math.min(probe.config.sampleIntervalMs, livenessWarningDrainIntervalMs);
                raceTimer = setTimeout(() => resolve({ source: 'probe' }), pollMs);
              }),
            ])
          : await Promise.race([ndjsonRace, terminationCommittedRace]);
        if (raceTimer !== undefined) clearTimeout(raceTimer);

        if (raceResult.source === 'termination') {
          terminationStreamDrainDeadline ??= Date.now() + TERMINATION_STDIO_DRAIN_GRACE_MS;
          const drained = await waitForIteratorUntil(pendingNext, terminationStreamDrainDeadline);
          if (!drained) break;
          raceResult = { source: 'ndjson', result: drained };
        }

        if (raceResult.source === 'probe') {
          // No NDJSON arrived — if stall-kill is pending, execute it now
          if (pendingStallKill) {
            commitTimeout(
              'stall_timeout',
              pendingStallKill.silenceDurationMs,
              options.livenessProbe?.stallTerminationMode ?? 'terminate-first',
            );
            break;
          }
          continue;
        }

        // NDJSON event arrived — CLI is alive, cancel any pending stall-kill
        pendingStallKill = undefined;

        const { done, value } = raceResult.result;
        if (done) break;

        if (isParseError(value)) {
          const parseErr = value as { line: string };
          log.warn({ command: options.command, line: parseErr.line }, 'CLI non-JSON output');
          yield value;
          pendingNext = ndjson.next();
          continue;
        }
        // Reset timeout only after a valid NDJSON event.
        // Invalid chatter should not keep a stuck invocation alive forever.
        if (terminationStreamDrainDeadline === undefined) {
          resetTimeout();
          if (probe) probe.notifyActivity();
        }
        // F118: Record event timestamps for diagnostic enrichment
        const now = Date.now();
        if (firstEventAt === null) firstEventAt = now;
        lastEventAt = now;
        if (typeof value === 'object' && value !== null && 'type' in value) {
          lastEventType = String((value as Record<string, unknown>).type);
        }
        // F212 AC-A8: collect stream error events for cliDiagnostics
        maybeCollectStreamError(value, streamErrorTexts, structuredErrorTexts);
        // F212 Phase H cloud R5 P2 (2026-07-10): track LAST terminal event locally.
        // Symmetric to tmux-agent-spawner. AbortSignal (semanticCompletionSignal) is
        // sticky — a subsequent turn.failed after turn.completed cannot clear it,
        // so `.aborted === true` at exit reports "complete" for real multi-turn
        // failures. Use localFinalTerminal (below) to gate the exit=1 suppress.
        if (value && typeof value === 'object' && 'type' in value) {
          const payloadType = (value as { type?: string }).type;
          if (payloadType === 'turn.completed') localFinalTerminal = 'completed';
          else if (payloadType === 'turn.failed') localFinalTerminal = 'failed';
        }
        yield value;
        pendingNext = ndjson.next();
      }
    }

    if (probe) {
      await probe.flushPendingWarnings();
      for (const warning of probe.drainWarnings()) {
        yield withStreamContext(warning);
        if (isStallAutoKillWarning(options, warning)) {
          commitTimeout(
            'stall_timeout',
            warning.silenceDurationMs,
            options.livenessProbe?.stallTerminationMode ?? 'terminate-first',
          );
        }
      }
    }

    // Check for spawn error that arrived during/after iteration
    if (spawnError) throw spawnError;

    // Issue #116: If provider signaled semantic completion, give a short grace period
    // instead of blocking on full exit. Process gets SEMANTIC_COMPLETION_GRACE_MS to
    // exit naturally; if it doesn't, killChild() in finally will clean up.
    const semanticDone = options.semanticCompletionSignal?.aborted === true;

    if (!semanticDone) {
      if (killed) {
        // A timeout/abort must not depend forever on a broken wrapper closing stdout.
        // Wait through the bounded signal sequence, then allow one final short stdio drain.
        await Promise.race([closePromise, terminationController.waitForCompletion()]);
        if (!childClosed) {
          const drainDeadline = terminationStreamDrainDeadline ?? Date.now() + TERMINATION_STDIO_DRAIN_GRACE_MS;
          const remainingDrainMs = drainDeadline - Date.now();
          if (remainingDrainMs > 0) {
            await Promise.race([closePromise, new Promise<void>((resolve) => setTimeout(resolve, remainingDrainMs))]);
          }
        }
      } else {
        // Healthy completion still waits for close so trailing stderr is not truncated.
        await closePromise;
      }
    } else if (!childClosed) {
      // Grace period: give the process time to exit naturally before force-killing.
      // If it exits within grace, great; if not, killChild() in finally will clean up.
      await Promise.race([closePromise, new Promise<void>((r) => setTimeout(r, SEMANTIC_COMPLETION_GRACE_MS).unref())]);
    }

    // F212 AC-A7 / OQ-2 (砚砚 review BLOCKED P1-1): successful exit stderr also gated by
    // LOG_CLI_STDERR + sanitized via shared helper. Previously this branch wrote raw stderr unconditionally.
    if (exitCode === 0 && exitSignal === null) {
      const stderrForLog = formatCliStderrForLog(stderrBuffer);
      const stderrTrimmed = stderrBuffer.trim();
      options.onSuccessfulExitStderr?.({
        stderrPresent: stderrTrimmed.length > 0,
        ...(stderrTrimmed ? { stderrExcerpt: sanitizeCliStderr(stderrBuffer).slice(-500) } : {}),
      });
      if (stderrForLog) {
        log.debug(
          {
            command: options.command,
            hadNdjsonEvent: firstEventAt !== null,
            stderr: stderrForLog,
          },
          'CLI stderr on successful exit (LOG_CLI_STDERR=1)',
        );
      }
    }

    if (plainTextResult) {
      yield {
        __cliPlainText: true,
        stdout: plainTextResult.stdout,
        stderr: stderrBuffer,
        exitCode,
        signal: exitSignal,
        command: options.command,
      } satisfies CliPlainTextResult;
    }

    // F212 Phase H Sol Final确权 P1-A (2026-07-10) — unified `finalSemanticDone`
    // predicate that handles all four cells of the 2×2 truth table:
    //   1. sticky signal + turn.completed → localFinalTerminal='completed' → SUPPRESS
    //   2. sticky signal + completed then failed → localFinalTerminal='failed' → SURFACE (cloud R5 P2)
    //   3. sticky signal + no terminal event → localFinalTerminal=null, sig aborted → SUPPRESS
    //      (preserves the "caller-side signal-only" contract — see Group A test in
    //      cli-spawn.test.js:1427: `item.completed` counts as work but is NOT a
    //      turn-level terminal, so localFinalTerminal stays null)
    //   4. no signal + no terminal → both falsy → SURFACE (unchanged behavior)
    //
    // Local terminal WINS over sticky abort — a chronological `turn.failed` always
    // outranks a prior `turn.completed`. Sticky abort only fires when we saw NO
    // turn-level terminal at all (cell 3).
    const finalSemanticDone = localFinalTerminal === 'completed' || (localFinalTerminal === null && semanticDone);
    // Yield error on abnormal exit (only if WE didn't kill it AND semantic completion
    // did not truly land). Covers non-zero exitCode + external signal kills.
    // Windows libuv-crash quirk: exit code 3221226505 (0xC0000409 STATUS_STACK_BUFFER_OVERRUN)
    // is a libuv assertion crash on MCP subprocess shutdown. Use the same unified
    // predicate for the tie-break so cell 2 (multi-turn failure) still surfaces.
    const isWindowsLibuvCrash = process.platform === 'win32' && exitCode === 3221226505 && finalSemanticDone;
    if (!finalSemanticDone && !killed && !isWindowsLibuvCrash && (exitCode !== 0 || exitSignal !== null)) {
      // F212 AC-A1 + AC-A8: build structured diagnostics from BOTH stderr and stream error events.
      // Stream errors (NDJSON `{type:"error"}`) often carry the real semantic (Codex code 1 case).
      const rawText = [...streamErrorTexts, stderrBuffer].filter(Boolean).join('\n');
      // F212 Phase F (AC-F4/F5): pass stderrEmpty so buildCliDiagnostics can pick the
      // honest unknown-fallback hint (empty → "no stderr produced" vs non-empty → env-summary).
      const stderrTrimLen = stderrBuffer.trim().length;
      const cliDiagnostics: CliDiagnostics = buildCliDiagnostics({
        rawText,
        structuredErrorText: structuredErrorTexts.filter(Boolean).join('\n'),
        stderrEmpty: stderrTrimLen === 0,
        ...(options.managedArgvFlags ? { managedArgvFlags: options.managedArgvFlags } : {}),
        debugRef: {
          command: options.command,
          exitCode,
          signal: exitSignal,
          ...(options.invocationId ? { invocationId: options.invocationId } : {}),
        },
      });
      // F212 Phase F (AC-F1 + AC-F2): UNCONDITIONAL structured exit diagnostic log,
      // independent of LOG_CLI_STDERR env gate and independent of stderr emptiness. This
      // guarantees that Windows codex.cmd + empty stderr abnormal exits still leave a
      // searchable trail keyed by invocationId. AC-F2 scope contract: env gate STILL only
      // controls the raw/sanitized stderr field below.
      // P1-1 (砚砚 R1): use options.diagnosticLogger when provided so AC-F6 tests can
      // assert the actual log payload — production omits and falls back to module log.
      const diagLog = options.diagnosticLogger ?? log;
      diagLog.error(
        buildCliExitDiagnostic({
          ...(options.invocationId ? { invocationId: options.invocationId } : {}),
          command: options.command,
          exitCode,
          signal: exitSignal,
          ...(cliDiagnostics.reasonCode ? { reasonCode: cliDiagnostics.reasonCode } : {}),
          stderrLength: stderrTrimLen,
          streamErrorCount: streamErrorTexts.length,
          // P1-2 (砚砚 R1): cwd dropped entirely. sanitizeCliStderr only covers HOME /
          // userprofile / C:\Users / /tmp — non-HOME server installs (/srv, /workspace,
          // /var/lib, D:\work) would leak raw absolute paths. Per 砚砚 directive "无法证明
          // 安全就 omit" — the diagnostic value of cwd is redundant with `command` (binary
          // path already conveys install context) and invocationId (lookup via thread metadata).
        }),
        'CLI abnormal exit',
      );
      // F212 AC-A7 + OQ-2 + Phase F AC-F3: stderr log gated + sanitized via shared helper.
      // AC-F3 adds invocationId to the payload so frontend debugRef.invocationId can be used
      // to grep the corresponding stderr log line (previously the field was missing).
      const stderrForLog = formatCliStderrForLog(stderrBuffer);
      if (stderrForLog) {
        diagLog.error(
          {
            ...(options.invocationId ? { invocationId: options.invocationId } : {}),
            command: options.command,
            stderr: stderrForLog,
            reasonCode: cliDiagnostics.reasonCode,
          },
          'CLI stderr (LOG_CLI_STDERR=1)',
        );
      }
      // Diagnostic: always log sanitized stderr summary when reasonCode is unknown
      // (the actual root cause is invisible otherwise). Safe: uses sanitizer, capped length.
      if (!cliDiagnostics.reasonCode && stderrBuffer.trim()) {
        const sanitized = sanitizeCliStderr(stderrBuffer).slice(-500);
        log.info(
          {
            command: options.command,
            exitCode,
            signal: exitSignal,
            stderrTail: sanitized,
            streamErrorCount: streamErrorTexts.length,
            invocationId: options.invocationId,
          },
          '[cli-diag] Unknown CLI error — stderr tail (auto-sanitized)',
        );
      }
      yield {
        __cliError: true,
        exitCode,
        signal: exitSignal,
        // AC-A9 红线: message is humanized only — no raw stderr exposed
        message: `CLI 异常退出 (code: ${exitCode ?? 'null'}, signal: ${exitSignal ?? 'none'})`,
        command: options.command,
        ...(cliDiagnostics.reasonCode ? { reasonCode: cliDiagnostics.reasonCode } : {}),
        cliDiagnostics,
      };
    }

    // Yield timeout error (distinct from user cancel which stays silent)
    if (timedOut) {
      // Timeout is a causal terminal state, not an abnormal-exit classification. Snapshot
      // the timeout before projecting diagnostics so a cooperative exit=0 cannot overwrite
      // the user-visible reason with "CLI exited".
      timeoutTerminalContext = snapshotTimeoutTerminalContext();
      const rawText = [...streamErrorTexts, stderrBuffer].filter(Boolean).join('\n');
      const timeoutStderrTrimLen = stderrBuffer.trim().length;
      const cliDiagnostics: CliDiagnostics = buildCliDiagnostics({
        rawText,
        structuredErrorText: structuredErrorTexts.filter(Boolean).join('\n'),
        stderrEmpty: timeoutStderrTrimLen === 0,
        ...(options.managedArgvFlags ? { managedArgvFlags: options.managedArgvFlags } : {}),
        debugRef: {
          command: options.command,
          signal: null,
          ...(options.invocationId ? { invocationId: options.invocationId } : {}),
        },
        terminalContext: timeoutTerminalContext,
      });
      const timeoutDiagLog = options.diagnosticLogger ?? log;
      timeoutDiagLog.error(
        {
          ...(options.invocationId ? { invocationId: options.invocationId } : {}),
          command: options.command,
          reasonCode: cliDiagnostics.reasonCode,
          configuredTimeoutMs: timeoutTerminalContext.configuredTimeoutMs,
          observedSilenceDurationMs: timeoutTerminalContext.observedSilenceDurationMs,
          processAliveAtTimeout: timeoutTerminalContext.processAliveAtTimeout,
          signalsSent: timeoutTerminalContext.signalsSent,
          finalStage: timeoutTerminalContext.finalStage,
          postKillExitCode: timeoutTerminalContext.postKillExitCode,
          postKillSignal: timeoutTerminalContext.postKillSignal,
        },
        'CLI timeout',
      );
      // F212 AC-A7 + Phase F AC-F3 (砚砚 R2 P1 follow-up): gated + sanitized stderr log via
      // shared helper. AC-F3 spec covers BOTH 'CLI stderr (LOG_CLI_STDERR=1)' and 'CLI stderr
      // on timeout' — the post-merge R2 review caught that the timeout branch was still hard-
      // using module `log`, so the diagnosticLogger stub couldn't verify the contract. Reuse
      // `diagLog = options.diagnosticLogger ?? log` so AC-F3 spec line is actually testable.
      const stderrForLog = formatCliStderrForLog(stderrBuffer);
      if (stderrForLog) {
        timeoutDiagLog.error(
          {
            ...(options.invocationId ? { invocationId: options.invocationId } : {}),
            command: options.command,
            stderr: stderrForLog,
            reasonCode: cliDiagnostics.reasonCode,
          },
          'CLI stderr on timeout (LOG_CLI_STDERR=1)',
        );
      }
      yield {
        __cliTimeout: true,
        timeoutMs: timeoutTerminalContext.configuredTimeoutMs,
        // AC-A9 红线: humanized only, no raw stderr
        message: stallKilled
          ? `CLI idle-silent 超时 (${Math.round(timeoutTerminalContext.configuredTimeoutMs / 1000)}s — stall auto-kill)`
          : `CLI 响应超时 (${Math.round(timeoutMs / 1000)}s)`,
        command: options.command,
        // F118: Diagnostic enrichment
        firstEventAt,
        lastEventAt,
        lastEventType,
        silenceDurationMs: timeoutTerminalContext.observedSilenceDurationMs,
        processAlive: processAliveAtTimeout,
        terminalContext: timeoutTerminalContext,
        ...(stallKilled ? { stallKill: true } : {}),
        ...(options.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options.rawArchivePath ? { rawArchivePath: options.rawArchivePath } : {}),
        cliDiagnostics,
      };
    }
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (options.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
    process.off('exit', exitHandler);
    probe?.stop();
    // F152: Unregister probe from OTel gauge
    if (options.invocationId) unregisterLivenessProbe(options.invocationId);
    killChild();

    // F153 Phase B: End CLI session span with appropriate status
    if (cliSpan) {
      if (timedOut) {
        timeoutTerminalContext ??= snapshotTimeoutTerminalContext();
        cliSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'CLI timeout' });
        const timeoutAttributes = buildCliTimeoutTelemetryAttributes(timeoutTerminalContext);
        cliSpan.setAttributes(timeoutAttributes);
        emitOtelLog('ERROR', 'cli_session_timeout', timeoutAttributes, cliSpan);
      } else if (exitCode !== null && exitCode !== 0) {
        cliSpan.setStatus({ code: SpanStatusCode.ERROR, message: `CLI exit code ${exitCode}` });
        emitOtelLog('ERROR', 'cli_session_error', { 'cli.exit_code': exitCode }, cliSpan);
      } else if (exitSignal) {
        cliSpan.setStatus({ code: SpanStatusCode.ERROR, message: `CLI killed by ${exitSignal}` });
        emitOtelLog('WARN', 'cli_session_killed', { 'cli.signal': exitSignal }, cliSpan);
      } else {
        cliSpan.setStatus({ code: SpanStatusCode.OK });
      }
      cliSpan.setAttribute('cli.exit_code', exitCode ?? -1);
      if (exitSignal) cliSpan.setAttribute('cli.exit_signal', exitSignal);
      cliSpan.end();
    }
  }
}

/**
 * Type guard for CLI error objects (abnormal exit or external signal kill)
 * Note: `message` is sanitized for user display; raw stderr is logged to console only.
 */
export function isCliError(value: unknown): value is {
  __cliError: true;
  exitCode: number | null;
  signal: string | null;
  message: string;
  command: string;
  reasonCode?: CliErrorReasonCode;
  /** F212 Phase A: structured diagnostics (added on every emit; existing consumers safe to ignore) */
  cliDiagnostics?: CliDiagnostics;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__cliError' in value &&
    (value as Record<string, unknown>).__cliError === true
  );
}

export function isCliPlainTextResult(value: unknown): value is CliPlainTextResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__cliPlainText' in value &&
    (value as Record<string, unknown>).__cliPlainText === true
  );
}

/**
 * Type guard for CLI timeout objects (process killed due to timeout)
 * Note: `message` is sanitized for user display; raw stderr is logged to console only.
 */
export interface CliTimeoutEvent {
  __cliTimeout: true;
  timeoutMs: number;
  message: string;
  command: string;
  // F118 AC-C3: Diagnostic enrichment fields
  silenceDurationMs?: number;
  processAlive?: boolean;
  lastEventType?: string;
  firstEventAt?: number;
  lastEventAt?: number;
  cliSessionId?: string;
  invocationId?: string;
  rawArchivePath?: string;
  stallKill?: true;
  /** Causal timeout snapshot; post-kill fields are explicitly observational. */
  terminalContext?: CliTimeoutTerminalContext;
  // F212 Phase A: structured CLI diagnostics on timeout events (mirrors __cliError shape)
  cliDiagnostics?: CliDiagnostics;
}

export function isCliTimeout(value: unknown): value is CliTimeoutEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__cliTimeout' in value &&
    (value as Record<string, unknown>).__cliTimeout === true
  );
}

/**
 * Type guard for liveness warning events from ProcessLivenessProbe (F118 Phase C)
 */
export function isLivenessWarning(value: unknown): value is import('./ProcessLivenessProbe.js').LivenessWarningEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__livenessWarning' in value &&
    (value as Record<string, unknown>).__livenessWarning === true
  );
}

/**
 * Default spawn function wrapping child_process.spawn.
 *
 * On Windows (#64): bypasses .cmd shim by resolving the underlying .js
 * script and spawning via `node` directly. Falls back to `shell: true`
 * if shim resolution fails.
 */
function defaultSpawn(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    stdio: ['ignore' | 'pipe', 'pipe', 'pipe'];
    bindExecutionOwner?: boolean | undefined;
  },
): ChildProcessLike {
  if (IS_WINDOWS) {
    const spawnPlan = resolveWindowsSpawnPlan(command, args);
    if (spawnPlan.mode === 'shim') {
      log.debug(
        {
          original: command,
          resolved: spawnPlan.command,
          argCount: spawnPlan.args.length,
          mode: spawnPlan.mode,
          shell: spawnPlan.shell,
        },
        'Windows shim resolved',
      );
    } else {
      log.debug(
        {
          original: command,
          resolved: spawnPlan.command,
          argCount: spawnPlan.args.length,
          mode: spawnPlan.mode,
          shell: spawnPlan.shell,
        },
        'Windows spawn plan resolved',
      );
    }
    return nodeSpawn(spawnPlan.command, spawnPlan.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio,
      ...(spawnPlan.shell !== undefined ? { shell: spawnPlan.shell } : {}),
    });
  }

  const plan = buildUnixSupervisedSpawnPlan(command, args, {
    env: {
      ...options.env,
      ...(options.bindExecutionOwner === false ? {} : { [CLI_EXECUTION_OWNER_BINDING_ENV]: '1' }),
    },
    killGraceMs: Math.max(250, KILL_GRACE_MS - 500),
  });

  return nodeSpawn(plan.command, plan.args, {
    cwd: options.cwd,
    env: plan.env,
    stdio: options.stdio,
  });
}
