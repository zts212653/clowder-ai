/**
 * ManagedRunner — F167 Phase P (H3)
 *
 * Spawns a shell command, captures combined stdout+stderr output to a temp log file,
 * and returns a structured result when the command exits, times out, or is cancelled.
 *
 * Shell expressions run once per instance; output is captured to a temporary log.
 * Termination follows SIGTERM → 5s grace → SIGKILL and returns the last 50 lines.
 *
 * State machine:
 *   IDLE → RUNNING → {COMPLETED | TIMED_OUT | CANCELLED} → (log cleaned up)
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DurableManagedGateJob } from '../domains/ball-custody/durable-managed-gate-job.js';
import { readUnixProcessSnapshotSync, type UnixProcessIdentity } from '../utils/cli-process-ownership.js';
import { createModuleLogger } from './logger.js';
import { buildManagedRunnerEnvironment } from './managed-runner-environment.js';
import {
  armProcessTreeKillEscalation,
  type ProcessTreeKillEscalation,
  terminateWindowsProcessTree,
  type WindowsProcessTreeTerminationResult,
} from './managed-runner-process-tree.js';

const log = createModuleLogger('managed-runner');

/** Default timeout: 10 minutes */
export const DEFAULT_TIMEOUT_MS = 600_000;
/** Maximum timeout: 1 hour */
export const MAX_TIMEOUT_MS = 3_600_000;
/** Grace period after SIGTERM before SIGKILL */
export const KILL_GRACE_MS = 5_000;
/** Maximum lines to return in tailOutput */
const TAIL_LINES = 50;
/** Maximum log file size (10MB) — truncate head if exceeded */
const MAX_LOG_BYTES = 10 * 1024 * 1024;
/** P2-7 fix (cloud R4): cap partial-line buffer to prevent unbounded memory growth
 *  for commands that emit very long lines without newlines (e.g. minified JSON, binary). */
const MAX_PARTIAL_LINE_BYTES = 1024 * 1024; // 1MB
/** Temp directory for runner log files */
const RUNNER_LOG_DIR = join(tmpdir(), 'cat-cafe-runner');
const DURABLE_WORKER_PATH = fileURLToPath(new URL('./managed-runner-durable-worker.js', import.meta.url));

export type ManagedRunnerState = 'idle' | 'running' | 'completed' | 'timed_out' | 'cancelled';

export interface WakeWhenResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  tailOutput: string;
}

export interface ManagedRunnerOptions {
  cwd?: string;
  timeoutMs?: number;
  maximumTimeoutMs?: number;
  managedJob?: DurableManagedGateJob;
}

/** Spawn admission result — resolves as soon as the child spawns or errors. */
export interface SpawnAdmission {
  /** True if the child process spawned successfully. */
  spawned: boolean;
  /** Process ID, available only when spawned=true. */
  pid: number | null;
  /** PID reuse-safe process birth identity, captured at admission when available. */
  processIdentity?: UnixProcessIdentity;
  /** Error message when spawned=false. */
  error?: string;
}

/** Two-phase start result: admission resolves on spawn, completion on exit. */
export interface ManagedRunnerStartResult {
  /** Resolves when the child process spawns (fast) or on spawn error. */
  admission: Promise<SpawnAdmission>;
  /** Resolves when the command finishes, times out, or is cancelled. */
  completion: Promise<WakeWhenResult>;
}

export class ManagedRunner {
  private _state: ManagedRunnerState = 'idle';
  private _pid: number | null = null;
  private _logPath: string | null = null;
  private _child: ChildProcess | null = null;
  private _timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private _killEscalation: ProcessTreeKillEscalation | null = null;
  private _preserveLog = false;
  /** P2-3 fix: rolling tail buffer keeps last TAIL_LINES regardless of log file truncation */
  private _rollingTail: string[] = [];

  get state(): ManagedRunnerState {
    return this._state;
  }

  get pid(): number | null {
    return this._pid;
  }

  get logPath(): string | null {
    return this._logPath;
  }

  /**
   * Two-phase start: admission resolves on spawn (fast), completion on exit.
   *
   * Use this when the caller needs to know the pid before the command finishes.
   * The admission promise resolves as soon as spawn() succeeds or fails;
   * the completion promise resolves when the command exits/times out/is cancelled
   * (same semantics as launch()).
   */
  start(command: string, opts?: ManagedRunnerOptions): ManagedRunnerStartResult {
    if (this._state !== 'idle') {
      throw new Error(`ManagedRunner is not idle (state=${this._state}), cannot launch`);
    }

    let resolveAdmission!: (result: SpawnAdmission) => void;
    const admission = new Promise<SpawnAdmission>((resolve) => {
      resolveAdmission = resolve;
    });

    const completion = this._run(command, opts, resolveAdmission);

    return { admission, completion };
  }

  /**
   * Launch a shell command and wait for it to complete (or timeout/cancel).
   * Each ManagedRunner instance can only launch once.
   *
   * For callers that need the pid before the command finishes, use start() instead.
   */
  async launch(command: string, opts?: ManagedRunnerOptions): Promise<WakeWhenResult> {
    if (this._state !== 'idle') {
      throw new Error(`ManagedRunner is not idle (state=${this._state}), cannot launch`);
    }
    return this._run(command, opts);
  }

  /**
   * Internal: run the command. If onAdmission is provided (from start()),
   * it is called synchronously after spawn succeeds or on spawn error.
   */
  private _run(
    command: string,
    opts?: ManagedRunnerOptions,
    onAdmission?: (result: SpawnAdmission) => void,
  ): Promise<WakeWhenResult> {
    const timeoutMs = Math.min(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts?.maximumTimeoutMs ?? MAX_TIMEOUT_MS);
    const cwd = opts?.cwd;

    this._preserveLog = opts?.managedJob != null;
    if (opts?.managedJob) {
      this._logPath = opts.managedJob.logPath;
      mkdirSync(dirname(this._logPath), { recursive: true });
    } else {
      if (!existsSync(RUNNER_LOG_DIR)) {
        mkdirSync(RUNNER_LOG_DIR, { recursive: true });
      }
      const logId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this._logPath = join(RUNNER_LOG_DIR, `${logId}.log`);
    }
    if (!this._logPath) throw new Error('ManagedRunner log path initialization failed');

    const startTime = Date.now();
    const logPath = this._logPath;

    return new Promise<WakeWhenResult>((resolve) => {
      const logStream = opts?.managedJob ? null : createWriteStream(logPath, { flags: 'w' });

      const finishLog = (callback: () => void) => {
        if (logStream) {
          logStream.end(callback);
        } else {
          callback();
        }
      };

      // A detached child leads the process group used for tree termination.
      let child: ChildProcess;
      try {
        child = spawn(opts?.managedJob ? process.execPath : command, opts?.managedJob ? [DURABLE_WORKER_PATH] : [], {
          shell: !opts?.managedJob,
          cwd,
          // Keep repository-owned tools available when the API daemon has a minimal PATH.
          env: {
            ...buildManagedRunnerEnvironment(process.env),
            ...(opts?.managedJob
              ? {
                  CAT_CAFE_MANAGED_JOB_ID: opts.managedJob.jobId,
                  CAT_CAFE_MANAGED_JOB_RECORD_PATH: opts.managedJob.gateReceiptPath,
                  CAT_CAFE_MANAGED_JOB_LOG_PATH: opts.managedJob.logPath,
                  CAT_CAFE_MANAGED_JOB_DESCRIPTOR: JSON.stringify(opts.managedJob),
                  CAT_CAFE_GATE_EXECUTION_SLA_MS: String(opts.managedJob.executionSlaMs),
                  CAT_CAFE_MANAGED_RUNNER_COMMAND: command,
                  ...(cwd ? { CAT_CAFE_MANAGED_RUNNER_CWD: cwd } : {}),
                }
              : {}),
          },
          stdio: opts?.managedJob ? 'ignore' : ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
      } catch (spawnErr) {
        // Synchronous spawn failure (e.g. ENOENT for shell, invalid cwd)
        const durationMs = Date.now() - startTime;
        this._state = 'completed';
        const errMsg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        log.error({ err: spawnErr, command, cwd }, 'ManagedRunner: synchronous spawn failure');
        onAdmission?.({ spawned: false, pid: null, error: errMsg });
        finishLog(() => {
          this._cleanupLog();
          resolve({ exitCode: null, timedOut: false, durationMs, tailOutput: `Error: ${errMsg}` });
        });
        return;
      }

      this._child = child;
      this._pid = child.pid ?? null;

      // child.pid is defined synchronously when spawn succeeds.
      // Undefined pid means the OS rejected the spawn (e.g. bad cwd) — the 'error'
      // event will fire asynchronously. Defer admission to the error handler.
      let admissionSettled = false;
      if (this._pid != null) {
        this._state = 'running';
        log.debug({ command, pid: this._pid, cwd, timeoutMs }, 'ManagedRunner: process launched');
        admissionSettled = true;
        const processIdentity = readUnixProcessSnapshotSync({ pids: [this._pid] })?.get(this._pid);
        onAdmission?.({ spawned: true, pid: this._pid, ...(processIdentity ? { processIdentity } : {}) });
      } else {
        log.debug({ command, cwd }, 'ManagedRunner: spawn returned no pid, awaiting error event');
      }

      // Pipe stdout + stderr to log file
      if (logStream) {
        child.stdout?.pipe(logStream, { end: false });
        child.stderr?.pipe(logStream, { end: false });
      }

      // Track written bytes to enforce size limit
      let writtenBytes = 0;
      let _rollingPartialLine = '';
      const originalWrite = logStream?.write.bind(logStream);
      // P2-6 fix (cloud R3): properly type the write shim instead of using explicit `any`.
      // WriteStream.write has overloads (chunk+cb / chunk+encoding+cb); we capture the chunk
      // for rolling tail and delegate the full call via the bound original.
      if (logStream && originalWrite)
        logStream.write = ((
          chunk: Uint8Array | string,
          encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
          cb?: (error?: Error | null) => void,
        ): boolean => {
          const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
          // P2-3 fix: always feed the rolling tail buffer, even after the file cap.
          // This ensures _readTailOutput returns the ACTUAL last 50 lines of the command,
          // not the last 50 lines of the first 10MB.
          const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
          _rollingPartialLine += text;
          // P2-7 fix (cloud R4): cap partial-line buffer. Commands that emit very long
          // lines without newlines (minified JSON, binary-ish output) could grow this
          // buffer unboundedly. Truncate the head, keeping the tail (most recent bytes).
          if (_rollingPartialLine.length > MAX_PARTIAL_LINE_BYTES) {
            _rollingPartialLine = _rollingPartialLine.slice(-MAX_PARTIAL_LINE_BYTES);
          }
          const parts = _rollingPartialLine.split('\n');
          // Last element is the incomplete line (carry forward)
          _rollingPartialLine = parts.pop() ?? '';
          for (const line of parts) {
            this._rollingTail.push(line);
            if (this._rollingTail.length > TAIL_LINES) {
              this._rollingTail.shift();
            }
          }

          writtenBytes += size;
          if (writtenBytes > MAX_LOG_BYTES) {
            // Stop writing to file — too large. Rolling tail still captures the end.
            return true;
          }
          // Delegate to original write, preserving the overload shape
          if (typeof encodingOrCb === 'function') {
            return originalWrite(chunk, encodingOrCb);
          }
          if (encodingOrCb != null) {
            return originalWrite(chunk, encodingOrCb, cb);
          }
          return originalWrite(chunk);
        }) as typeof logStream.write;

      // Timeout handler
      this._timeoutTimer = setTimeout(() => {
        if (this._state !== 'running') return;
        log.info({ pid: this._pid, command, timeoutMs }, 'ManagedRunner: timeout reached, sending SIGTERM');
        this._state = 'timed_out';
        const gracefulTermination = this._killProcessGroup('SIGTERM');
        this._armKillEscalation(gracefulTermination, 'ManagedRunner: SIGKILL after grace period');
      }, timeoutMs);

      // `close` waits for stdout/stderr to drain before the tail is read.
      child.on('close', (code, signal) => {
        // P2-3 fix: flush any remaining partial line to rolling tail
        if (_rollingPartialLine) {
          this._rollingTail.push(_rollingPartialLine);
          if (this._rollingTail.length > TAIL_LINES) {
            this._rollingTail.shift();
          }
          _rollingPartialLine = '';
        }
        // Keep escalation alive when descendants may outlive the shell.
        if (this._timeoutTimer) {
          clearTimeout(this._timeoutTimer);
          this._timeoutTimer = null;
        }
        if (this._state !== 'timed_out' && this._state !== 'cancelled') {
          this._clearKillEscalation();
        }
        const durationMs = Date.now() - startTime;

        // Determine terminal state if not already set (cancel/timeout set it before exit)
        if (this._state === 'running') {
          this._state = 'completed';
        }

        const timedOut = this._state === 'timed_out';
        const exitCode = timedOut || this._state === 'cancelled' ? null : code;

        // Wait for write stream to finish draining before reading the log file
        finishLog(() => {
          const tailOutput = this._readTailOutput();
          this._cleanupLog();

          log.debug(
            { pid: this._pid, exitCode, signal, timedOut, durationMs, state: this._state },
            'ManagedRunner: process exited',
          );

          resolve({
            exitCode: exitCode ?? null,
            timedOut,
            durationMs,
            tailOutput,
          });
        });
      });

      child.on('error', (err) => {
        this._clearTimers();
        const durationMs = Date.now() - startTime;

        // If admission hasn't been signaled yet (pid was null after spawn),
        // this error IS the spawn failure — signal it now.
        if (!admissionSettled) {
          admissionSettled = true;
          this._state = 'completed';
          onAdmission?.({ spawned: false, pid: null, error: err.message });
        }

        if (this._state === 'running') {
          this._state = 'completed';
        }

        log.error({ err, pid: this._pid, command }, 'ManagedRunner: process error');

        finishLog(() => {
          const tailOutput = this._readTailOutput();
          this._cleanupLog();

          resolve({
            exitCode: null,
            timedOut: false,
            durationMs,
            tailOutput: tailOutput || `Error: ${err.message}`,
          });
        });
      });
    });
  }

  /** Cancel the running process. SIGTERM → 5s grace → SIGKILL. */
  cancel(): void {
    if (this._state !== 'running' || !this._child) return;

    log.info({ pid: this._pid }, 'ManagedRunner: cancel requested, sending SIGTERM');
    this._state = 'cancelled';
    this._clearTimers();
    const gracefulTermination = this._killProcessGroup('SIGTERM');
    this._armKillEscalation(gracefulTermination, 'ManagedRunner: SIGKILL after cancel grace period');
  }

  /** Terminate the detached process group (Unix) or process tree (Windows). */
  private _killProcessGroup(signal: NodeJS.Signals): Promise<WindowsProcessTreeTerminationResult> | null {
    if (!this._pid) return null;

    if (process.platform === 'win32') {
      const pid = this._pid;
      const termination = terminateWindowsProcessTree(pid, signal);
      void termination.then((result) => {
        if (result.status === 'completed') {
          log.debug({ pid, signal }, 'ManagedRunner: taskkill completed');
          return;
        }
        log.warn({ pid, signal, result }, `ManagedRunner: taskkill ${result.status}`);
      });
      return termination;
    }

    try {
      process.kill(-this._pid, signal);
    } catch (err) {
      // Process group may already be gone — that's fine
      log.debug({ pid: this._pid, signal, err }, 'ManagedRunner: kill process group failed (may already be gone)');
    }
    return null;
  }

  private _armKillEscalation(
    gracefulTermination: Promise<WindowsProcessTreeTerminationResult> | null,
    warningMessage: string,
  ): void {
    this._killEscalation = armProcessTreeKillEscalation(
      gracefulTermination,
      () => {
        log.warn({ pid: this._pid }, warningMessage);
        this._killProcessGroup('SIGKILL');
      },
      KILL_GRACE_MS,
    );
  }

  private _clearKillEscalation(): void {
    this._killEscalation?.cancel();
    this._killEscalation = null;
  }

  private _clearTimers(): void {
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = null;
    }
    this._clearKillEscalation();
  }

  private _readTailOutput(): string {
    // P2-3 fix: prefer rolling tail buffer (always has the ACTUAL last lines,
    // even when log file was truncated at MAX_LOG_BYTES).
    if (this._rollingTail.length > 0) {
      return this._rollingTail.join('\n');
    }
    // Fallback: read from log file (for short commands that fit within MAX_LOG_BYTES)
    if (!this._logPath || !existsSync(this._logPath)) return '';
    try {
      const content = readFileSync(this._logPath, 'utf-8');
      const lines = content.split('\n');
      // Take last TAIL_LINES lines (filter out trailing empty line from split)
      const nonEmpty = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
      return nonEmpty.slice(-TAIL_LINES).join('\n');
    } catch {
      return '';
    }
  }

  private _cleanupLog(): void {
    if (this._preserveLog) return;
    if (this._logPath && existsSync(this._logPath)) {
      try {
        unlinkSync(this._logPath);
      } catch {
        // Best-effort cleanup
      }
    }
    this._logPath = null;
  }
}
