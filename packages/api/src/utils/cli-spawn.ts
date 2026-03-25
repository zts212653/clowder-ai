/**
 * CLI Process Spawner
 * 通用 CLI 子进程管理器，处理生命周期、超时和清理
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { createModuleLogger } from '../infrastructure/logger.js';
import { escapeBashArg, escapeCmdArg, findGitBashPath, resolveWindowsShimSpawn } from './cli-spawn-win.js';
import { resolveCliTimeoutMs } from './cli-timeout.js';
import type { ChildProcessLike, CliSpawnOptions, SpawnFn } from './cli-types.js';
import { isParseError, parseNDJSON } from './ndjson-parser.js';
import { ProcessLivenessProbe } from './ProcessLivenessProbe.js';

const log = createModuleLogger('cli-spawn');

const IS_WINDOWS = process.platform === 'win32';

type CliErrorReasonCode = 'invalid_thinking_signature';

function classifyKnownCliStderr(stderr: string): CliErrorReasonCode | undefined {
  if (/Invalid [`'"]?signature[`'"]? in [`'"]?thinking[`'"]? block/i.test(stderr)) {
    return 'invalid_thinking_signature';
  }
  return undefined;
}

/** Grace period between SIGTERM and SIGKILL */
export const KILL_GRACE_MS = 3_000;

/** Grace period after semantic completion before force-killing a lingering process */
export const SEMANTIC_COMPLETION_GRACE_MS = 5_000;

/**
 * Options for spawnCli (dependency injection for testing)
 */
export interface CliSpawnerDeps {
  /** Inject a custom spawn function (for testing) */
  spawnFn?: SpawnFn;
}

function buildChildEnv(overrides?: Record<string, string | null>): NodeJS.ProcessEnv {
  if (!overrides) return process.env;
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      delete merged[key];
      continue;
    }
    merged[key] = value;
  }
  return merged;
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
  // Default timeout is configurable via CLI_TIMEOUT_MS env var; 0 disables timeout.
  const timeoutMs = resolveCliTimeoutMs(options.timeoutMs);

  log.debug({ command: options.command, args: options.args, cwd: options.cwd, timeoutMs }, 'Spawning CLI process');

  const child = doSpawn(options.command, options.args, {
    cwd: options.cwd,
    env: buildChildEnv(options.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  log.debug({ pid: child.pid, command: options.command }, 'CLI process spawned');

  // Buffer stderr for error reporting (handler attached after resetTimeout is defined)
  let stderrBuffer = '';

  // Track child exit state (P1: prevents PID reuse kills)
  let childExited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      childExited = true;
      exitCode = code;
      exitSignal = signal;
      log.debug({ pid: child.pid, command: options.command, exitCode: code, signal }, 'CLI process exited');
      resolve();
    });
  });

  // Handle spawn errors (P2: ENOENT for command-not-found)
  let spawnError: Error | undefined;
  child.once('error', (err: Error) => {
    spawnError = err;
  });

  let killed = false;
  let timedOut = false;
  // F118 P1-fix: Snapshot process liveness at the moment timeout fires,
  // BEFORE killChild() — otherwise childExited is always true by yield time.
  let processAliveAtTimeout = false;
  let escalationTimer: ReturnType<typeof setTimeout> | undefined;

  function killChild(): void {
    if (killed || childExited) return;
    killed = true;
    child.kill('SIGTERM');
    escalationTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    escalationTimer.unref();
    child.on('exit', () => {
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
    });
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
        const elapsed = Date.now() - startedAt;
        if (!probe.isHardCapExceeded(elapsed, timeoutMs)) {
          resetTimeout(); // extend once more
          return;
        }
      }
      timedOut = true;
      processAliveAtTimeout = !childExited;
      killChild();
    }, timeoutMs);
    timeoutTimer.unref();
  };
  if (timeoutMs > 0) resetTimeout(); // Start initial timeout only if enabled

  // Attach stderr handler now that resetTimeout is defined
  // Reset timeout on stderr activity — CLI is alive (working on tools, thinking, etc.)
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
    resetTimeout();
    probe?.notifyActivity(); // F118: stderr = CLI alive, sync to probe
  });

  // AbortSignal
  const abortHandler = (): void => killChild();
  if (options.signal) {
    if (options.signal.aborted) {
      killChild();
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

  // F118 Phase B: Initialize liveness probe
  if (options.livenessProbe && child.pid !== undefined) {
    probe = new ProcessLivenessProbe(child.pid, options.livenessProbe);
    probe.start();
  }

  try {
    if (!child.stdout) {
      throw new Error(`CLI process ${options.command} has no stdout`);
    }

    // Throw on spawn error before iterating
    if (spawnError) {
      throw spawnError;
    }

    const ndjson = parseNDJSON(child.stdout)[Symbol.asyncIterator]();
    let pendingNext = ndjson.next();

    for (;;) {
      if (spawnError) throw spawnError;

      // F118: Drain probe warnings and check for dead process
      if (probe) {
        for (const warning of probe.drainWarnings()) yield warning;
        if (probe.getState() === 'dead') {
          killChild();
          break;
        }
      }

      // Race NDJSON event vs probe poll interval
      let raceTimer: ReturnType<typeof setTimeout> | undefined;
      const raceResult = probe
        ? await Promise.race([
            pendingNext.then((r) => {
              if (raceTimer !== undefined) clearTimeout(raceTimer);
              return { source: 'ndjson' as const, result: r };
            }),
            new Promise<{ source: 'probe' }>((r) => {
              raceTimer = setTimeout(() => r({ source: 'probe' }), probe.config.sampleIntervalMs);
            }),
          ])
        : { source: 'ndjson' as const, result: await pendingNext };

      if (raceResult.source === 'probe') continue;
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
      resetTimeout();
      if (probe) probe.notifyActivity();
      // F118: Record event timestamps for diagnostic enrichment
      const now = Date.now();
      if (firstEventAt === null) firstEventAt = now;
      lastEventAt = now;
      if (typeof value === 'object' && value !== null && 'type' in value) {
        lastEventType = String((value as Record<string, unknown>).type);
      }
      yield value;
      pendingNext = ndjson.next();
    }

    // Check for spawn error that arrived during/after iteration
    if (spawnError) throw spawnError;

    // Issue #116: If provider signaled semantic completion, give a short grace period
    // instead of blocking on full exit. Process gets SEMANTIC_COMPLETION_GRACE_MS to
    // exit naturally; if it doesn't, killChild() in finally will clean up.
    const semanticDone = options.semanticCompletionSignal?.aborted === true;

    if (!semanticDone) {
      // Wait for child to fully exit after stdout closes
      await exitPromise;
    } else if (!childExited) {
      // Grace period: give the process time to exit naturally before force-killing.
      // If it exits within grace, great; if not, killChild() in finally will clean up.
      await Promise.race([exitPromise, new Promise<void>((r) => setTimeout(r, SEMANTIC_COMPLETION_GRACE_MS).unref())]);
    }

    // Yield error on abnormal exit (only if WE didn't kill it AND no semantic completion)
    // Covers both non-zero exitCode AND external signal kills
    // Windows: exit code 3221226505 (0xC0000409 STATUS_STACK_BUFFER_OVERRUN) is a libuv
    // assertion crash in the MCP subprocess shutdown path. If we already received valid
    // NDJSON events, the CLI output is fine — suppress the spurious error.
    const isWindowsLibuvCrash =
      process.platform === 'win32' && exitCode === 3221226505 && firstEventAt !== null;
    if (!semanticDone && !killed && !isWindowsLibuvCrash && (exitCode !== 0 || exitSignal !== null)) {
      const reasonCode = classifyKnownCliStderr(stderrBuffer);
      // Log stderr for debugging (never expose to users — may contain thinking/traces)
      if (stderrBuffer.trim()) {
        log.error({ command: options.command, stderr: stderrBuffer.trim().slice(-1000) }, 'CLI stderr (debug only)');
      }
      yield {
        __cliError: true,
        exitCode,
        signal: exitSignal,
        // Sanitized message — no raw stderr exposed to users
        message: `CLI 异常退出 (code: ${exitCode ?? 'null'}, signal: ${exitSignal ?? 'none'})`,
        command: options.command,
        ...(reasonCode ? { reasonCode } : {}),
      };
    }

    // Yield timeout error (distinct from user cancel which stays silent)
    if (timedOut) {
      // Log stderr for debugging (never expose to users)
      if (stderrBuffer.trim()) {
        log.error(
          { command: options.command, stderr: stderrBuffer.trim().slice(-1000) },
          'CLI stderr on timeout (debug only)',
        );
      }
      yield {
        __cliTimeout: true,
        timeoutMs,
        // Sanitized message — no raw stderr exposed to users
        message: `CLI 响应超时 (${Math.round(timeoutMs / 1000)}s)`,
        command: options.command,
        // F118: Diagnostic enrichment
        firstEventAt,
        lastEventAt,
        lastEventType,
        silenceDurationMs: lastEventAt ? Date.now() - lastEventAt : timeoutMs,
        processAlive: processAliveAtTimeout,
        ...(options.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options.rawArchivePath ? { rawArchivePath: options.rawArchivePath } : {}),
      };
    }
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (escalationTimer !== undefined) clearTimeout(escalationTimer);
    if (options.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
    process.off('exit', exitHandler);
    probe?.stop();
    killChild();
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
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__cliError' in value &&
    (value as Record<string, unknown>).__cliError === true
  );
}

/**
 * Type guard for CLI timeout objects (process killed due to timeout)
 * Note: `message` is sanitized for user display; raw stderr is logged to console only.
 */
export function isCliTimeout(value: unknown): value is {
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
} {
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
    stdio: ['ignore', 'pipe', 'pipe'];
  },
): ChildProcessLike {
  if (IS_WINDOWS) {
    const shimSpawn = resolveWindowsShimSpawn(command, args);
    if (shimSpawn) {
      log.debug({ original: command, resolved: shimSpawn.command, args: shimSpawn.args }, 'Windows shim resolved');
      return nodeSpawn(shimSpawn.command, shimSpawn.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: options.stdio,
      });
    }
    // Prefer Git Bash (UTF-8 native) over cmd.exe (GBK codepage corrupts CJK args)
    const gitBash = findGitBashPath();
    if (gitBash) {
      log.debug({ command, shell: gitBash }, 'Windows shim unresolved, falling back to Git Bash');
      return nodeSpawn(command, args.map(escapeBashArg), {
        cwd: options.cwd,
        env: options.env,
        stdio: options.stdio,
        shell: gitBash,
      });
    }
    log.debug({ command, shell: true }, 'Windows shim unresolved, falling back to cmd.exe');
    return nodeSpawn(command, args.map(escapeCmdArg), {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio,
      shell: true,
    });
  }

  return nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio,
  });
}
