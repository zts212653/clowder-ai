/**
 * CLI Process Spawner
 * 通用 CLI 子进程管理器，处理生命周期、超时和清理
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Span } from '@opentelemetry/api';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { createModuleLogger } from '../infrastructure/logger.js';
import { registerLivenessProbe, unregisterLivenessProbe } from '../infrastructure/telemetry/instruments.js';
import { emitOtelLog } from '../infrastructure/telemetry/otel-logger.js';
import {
  buildCliDiagnostics,
  type CliDiagnostics,
  type CliErrorReasonCode,
  formatCliStderrForLog,
} from './cli-diagnostics.js';
import { invalidateCliCommand } from './cli-resolve.js';
import { resolveWindowsSpawnPlan } from './cli-spawn-win.js';
import { resolveCliTimeoutMs } from './cli-timeout.js';
import type { ChildProcessLike, CliSpawnOptions, SpawnFn } from './cli-types.js';
import { isParseError, parseNDJSON } from './ndjson-parser.js';
import { ProcessLivenessProbe } from './ProcessLivenessProbe.js';
import { sanitizeCliStderr } from './sanitize-cli-stderr.js';

const log = createModuleLogger('cli-spawn');

const IS_WINDOWS = process.platform === 'win32';

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

function isStallAutoKillWarning(options: CliSpawnOptions, warning: unknown): boolean {
  return (
    options.livenessProbe?.stallAutoKill === true &&
    isLivenessWarning(warning) &&
    warning.level === 'suspected_stall' &&
    warning.state === 'idle-silent'
  );
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

export function resolveCliSupervisorNodeArgs(moduleUrl = import.meta.url, execArgv = process.execArgv): string[] {
  const jsPath = fileURLToPath(new URL('./cli-supervisor.js', moduleUrl));
  if (existsSync(jsPath)) return [jsPath];

  const tsPath = fileURLToPath(new URL('./cli-supervisor.ts', moduleUrl));
  if (existsSync(tsPath)) return [...execArgv, tsPath];

  return [jsPath];
}

/** Env vars to strip from child processes to prevent E2BIG (overly large values). */
const ENV_VARS_TO_STRIP: ReadonlySet<string> = new Set([
  'LS_COLORS', // typically 1-2 KB of color mappings
  'LSCOLORS', // BSD/macOS equivalent
]);

export interface CliPlainTextResult {
  __cliPlainText: true;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  command: string;
}

export function buildChildEnv(overrides?: Record<string, string | null>): NodeJS.ProcessEnv {
  // Clone process.env but strip known bloated vars to avoid E2BIG (ARG_MAX exceeded).
  const merged: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (ENV_VARS_TO_STRIP.has(key)) continue;
    merged[key] = value;
  }
  if (!overrides) return merged;
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
    env: buildChildEnv(options.env),
    // Incident 2026-05-29 (cross-thread-context-contamination): when stdinInput is
    // provided, open stdin as a pipe so the prompt can be streamed off the command
    // line. Otherwise keep 'ignore' (unchanged for providers not using stdin).
    stdio: [options.stdinInput != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
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

  child.once('exit', (code, signal) => {
    childExited = true;
    exitCode = code;
    exitSignal = signal;
    log.debug({ pid: child.pid, command: options.command, exitCode: code, signal }, 'CLI process exited');
  });
  child.once('close', (code: unknown, signal: unknown) => {
    childClosed = true;
    if (!childExited) {
      childExited = true;
      exitCode = typeof code === 'number' ? code : null;
      exitSignal = typeof signal === 'string' ? (signal as NodeJS.Signals) : null;
    }
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

  let killed = false;
  let timedOut = false;
  let stallKilled = false; // #774: set when idle-silent stall triggers auto-kill
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
        const innerElapsed = Date.now() - startedAt;
        if (!probe.isHardCapExceeded(innerElapsed, timeoutMs)) {
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

  // Attach stderr handler — collect output but do NOT extend timeout or probe.
  // stderr is transport/reconnect noise, not user-visible output. Extending
  // timeout on stderr was the root cause of the 30-min stall bug: chatter kept
  // resetting the timer so the callback never fired and the probe never reached
  // suspected_stall. Silence tracking (probe) is also not reset here.
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
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
    // F152: Register probe for OTel agentLiveness gauge
    if (options.invocationId) {
      const catId = options.env?.CAT_CAFE_CAT_ID ?? 'unknown';
      registerLivenessProbe(options.invocationId, catId, () => probe!.getState());
    }
  }

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
      let pendingStallKill = false;

      for (;;) {
        if (spawnError) throw spawnError;

        if (probe) {
          for (const warning of probe.drainWarnings()) {
            yield warning;
            if (isStallAutoKillWarning(options, warning)) {
              pendingStallKill = true;
            }
          }
          if (probe.getState() === 'dead') {
            killChild();
            break;
          }
        }

        let raceTimer: ReturnType<typeof setTimeout> | undefined;
        const raceResult = probe
          ? await Promise.race([
              pendingNext.then((r) => {
                if (raceTimer !== undefined) clearTimeout(raceTimer);
                return { source: 'stdout' as const, result: r };
              }),
              new Promise<{ source: 'probe' }>((r) => {
                raceTimer = setTimeout(() => r({ source: 'probe' }), probe.config.sampleIntervalMs);
              }),
            ])
          : { source: 'stdout' as const, result: await pendingNext };

        if (raceResult.source === 'probe') {
          if (pendingStallKill) {
            stallKilled = true;
            timedOut = true;
            processAliveAtTimeout = !childExited;
            killChild();
            break;
          }
          continue;
        }

        pendingStallKill = false;

        const { done, value } = raceResult.result;
        if (done) break;

        stdoutChunks.push(value.toString());
        resetTimeout();
        if (probe) probe.notifyActivity();
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
      let pendingStallKill = false;

      for (;;) {
        if (spawnError) throw spawnError;

        // F118: Drain probe warnings and check for dead process
        if (probe) {
          for (const warning of probe.drainWarnings()) {
            yield warning;
            // #774: Mark for deferred kill — don't kill here (recovery NDJSON may be pending)
            if (isStallAutoKillWarning(options, warning)) {
              pendingStallKill = true;
            }
          }
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

        if (raceResult.source === 'probe') {
          // No NDJSON arrived — if stall-kill is pending, execute it now
          if (pendingStallKill) {
            stallKilled = true;
            timedOut = true;
            processAliveAtTimeout = !childExited;
            killChild();
            break;
          }
          continue;
        }

        // NDJSON event arrived — CLI is alive, cancel any pending stall-kill
        pendingStallKill = false;

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
        // F212 AC-A8: collect stream error events for cliDiagnostics
        maybeCollectStreamError(value, streamErrorTexts, structuredErrorTexts);
        yield value;
        pendingNext = ndjson.next();
      }
    }

    if (probe) {
      await probe.flushPendingWarnings();
      for (const warning of probe.drainWarnings()) {
        yield warning;
        if (isStallAutoKillWarning(options, warning)) {
          stallKilled = true;
          timedOut = true;
          processAliveAtTimeout = !childExited;
          killChild();
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
      // Wait for stdio close after stdout iteration so trailing stderr cannot be truncated.
      await closePromise;
    } else if (!childClosed) {
      // Grace period: give the process time to exit naturally before force-killing.
      // If it exits within grace, great; if not, killChild() in finally will clean up.
      await Promise.race([closePromise, new Promise<void>((r) => setTimeout(r, SEMANTIC_COMPLETION_GRACE_MS).unref())]);
    }

    // F212 AC-A7 / OQ-2 (砚砚 review BLOCKED P1-1): successful exit stderr also gated by
    // LOG_CLI_STDERR + sanitized via shared helper. Previously this branch wrote raw stderr unconditionally.
    if (exitCode === 0 && exitSignal === null) {
      const stderrForLog = formatCliStderrForLog(stderrBuffer);
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

    // Yield error on abnormal exit (only if WE didn't kill it AND no semantic completion)
    // Covers both non-zero exitCode AND external signal kills
    // Windows: exit code 3221226505 (0xC0000409 STATUS_STACK_BUFFER_OVERRUN) is a libuv
    // assertion crash in the MCP subprocess shutdown path. If we already received valid
    // NDJSON events, the CLI output is fine — suppress the spurious error.
    const isWindowsLibuvCrash = process.platform === 'win32' && exitCode === 3221226505 && semanticDone;
    if (!semanticDone && !killed && !isWindowsLibuvCrash && (exitCode !== 0 || exitSignal !== null)) {
      // F212 AC-A1 + AC-A8: build structured diagnostics from BOTH stderr and stream error events.
      // Stream errors (NDJSON `{type:"error"}`) often carry the real semantic (Codex code 1 case).
      const rawText = [...streamErrorTexts, stderrBuffer].filter(Boolean).join('\n');
      const cliDiagnostics: CliDiagnostics = buildCliDiagnostics({
        rawText,
        structuredErrorText: structuredErrorTexts.filter(Boolean).join('\n'),
        debugRef: {
          command: options.command,
          exitCode,
          signal: exitSignal,
          ...(options.invocationId ? { invocationId: options.invocationId } : {}),
        },
      });
      // F212 AC-A7 + OQ-2: stderr log gated + sanitized via shared helper.
      const stderrForLog = formatCliStderrForLog(stderrBuffer);
      if (stderrForLog) {
        log.error(
          { command: options.command, stderr: stderrForLog, reasonCode: cliDiagnostics.reasonCode },
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
      // F212 AC-A1: include cliDiagnostics on timeout too (network timeout etc. often classifiable)
      const rawText = [...streamErrorTexts, stderrBuffer].filter(Boolean).join('\n');
      const cliDiagnostics: CliDiagnostics = buildCliDiagnostics({
        rawText,
        structuredErrorText: structuredErrorTexts.filter(Boolean).join('\n'),
        debugRef: {
          command: options.command,
          exitCode,
          signal: exitSignal,
          ...(options.invocationId ? { invocationId: options.invocationId } : {}),
        },
      });
      // F212 AC-A7: gated + sanitized stderr log via shared helper.
      const stderrForLog = formatCliStderrForLog(stderrBuffer);
      if (stderrForLog) {
        log.error(
          { command: options.command, stderr: stderrForLog, reasonCode: cliDiagnostics.reasonCode },
          'CLI stderr on timeout (LOG_CLI_STDERR=1)',
        );
      }
      const stallWarningMs = probe?.config.stallWarningMs;
      yield {
        __cliTimeout: true,
        timeoutMs: stallKilled && stallWarningMs ? stallWarningMs : timeoutMs,
        // AC-A9 红线: humanized only, no raw stderr
        message: stallKilled
          ? `CLI idle-silent 超时 (${Math.round((stallWarningMs ?? timeoutMs) / 1000)}s — stall auto-kill)`
          : `CLI 响应超时 (${Math.round(timeoutMs / 1000)}s)`,
        command: options.command,
        // F118: Diagnostic enrichment
        firstEventAt,
        lastEventAt,
        lastEventType,
        silenceDurationMs: lastEventAt ? Date.now() - lastEventAt : timeoutMs,
        processAlive: processAliveAtTimeout,
        ...(stallKilled ? { stallKill: true } : {}),
        ...(options.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options.rawArchivePath ? { rawArchivePath: options.rawArchivePath } : {}),
        cliDiagnostics,
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
    // F152: Unregister probe from OTel gauge
    if (options.invocationId) unregisterLivenessProbe(options.invocationId);
    killChild();

    // F153 Phase B: End CLI session span with appropriate status
    if (cliSpan) {
      if (timedOut) {
        cliSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'CLI timeout' });
        emitOtelLog('ERROR', 'cli_session_timeout', { 'cli.timeout_ms': timeoutMs }, cliSpan);
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
  // F212 Phase A: structured CLI diagnostics on timeout events (mirrors __cliError shape)
  cliDiagnostics?: CliDiagnostics;
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
    stdio: ['ignore' | 'pipe', 'pipe', 'pipe'];
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

  // macOS GUI apps (Electron) have a minimal PATH that excludes version
  // managers (nvm/fnm/Volta). CLI shims use `#!/usr/bin/env node`, so the
  // child process must be able to find `node` in its PATH. Prepend the
  // directory containing the resolved CLI binary — it typically sits next
  // to the `node` binary that installed it (e.g. ~/.nvm/versions/node/v20/bin/).
  const env = { ...options.env };
  if (isAbsolute(command)) {
    const binDir = dirname(command);
    env.PATH = env.PATH ? `${binDir}:${env.PATH}` : binDir;
  }

  const supervisorArgs = resolveCliSupervisorNodeArgs();

  return nodeSpawn(process.execPath, [...supervisorArgs, '--', command, ...args], {
    cwd: options.cwd,
    env: {
      ...env,
      CAT_CAFE_SUPERVISOR_PARENT_PID: String(process.pid),
      CAT_CAFE_SUPERVISOR_KILL_GRACE_MS: String(Math.max(250, KILL_GRACE_MS - 500)),
    },
    stdio: options.stdio,
  });
}
