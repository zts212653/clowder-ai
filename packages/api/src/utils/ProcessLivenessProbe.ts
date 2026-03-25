/**
 * ProcessLivenessProbe — F118 Phase B
 * CPU sampling + liveness state classification for CLI child processes.
 *
 * States:
 * - active:      output received recently
 * - busy-silent: no output but CPU time is growing (process is working)
 * - idle-silent: no output AND CPU is flat (process may be stuck)
 * - dead:        PID no longer exists
 */

import { execFile } from 'node:child_process';

export type LivenessState = 'active' | 'busy-silent' | 'idle-silent' | 'dead';

export interface LivenessWarningEvent {
  __livenessWarning: true;
  state: LivenessState;
  silenceDurationMs: number;
  level: 'alive_but_silent' | 'suspected_stall';
  cpuTimeMs?: number;
  processAlive: boolean;
}

export interface ProbeConfig {
  sampleIntervalMs: number;
  softWarningMs: number;
  stallWarningMs: number;
  boundedExtensionFactor: number;
}

const DEFAULT_CONFIG: ProbeConfig = {
  sampleIntervalMs: 60_000,
  softWarningMs: 120_000,
  stallWarningMs: 300_000,
  boundedExtensionFactor: 2.0,
};

/** Parse ps cputime format (mm:ss.SS or h:mm:ss) to milliseconds */
export function parseCpuTime(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const parts = trimmed.split(':');
  if (parts.length === 3) {
    // h:mm:ss
    const [h, m, s] = parts;
    return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000;
  }
  if (parts.length === 2) {
    // mm:ss.SS
    const [m, s] = parts;
    return (Number(m) * 60 + Number(s)) * 1000;
  }
  return 0;
}

export class ProcessLivenessProbe {
  readonly config: ProbeConfig;
  private readonly pid: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt: number;
  private prevCpuTimeMs = 0;
  private currCpuTimeMs = 0;
  private cpuGrowing = false;
  private pidAlive = true;
  private warningQueue: LivenessWarningEvent[] = [];
  private softWarningEmitted = false;
  private stallWarningEmitted = false;

  constructor(pid: number, config?: Partial<ProbeConfig>) {
    this.pid = pid;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.lastActivityAt = Date.now();
  }

  /** Notify that output was received — resets silence tracking */
  notifyActivity(): void {
    this.lastActivityAt = Date.now();
    this.softWarningEmitted = false;
    this.stallWarningEmitted = false;
  }

  /** Current liveness state */
  getState(): LivenessState {
    if (!this.pidAlive) return 'dead';
    const silenceMs = Date.now() - this.lastActivityAt;
    if (silenceMs < this.config.sampleIntervalMs) return 'active';
    return this.cpuGrowing ? 'busy-silent' : 'idle-silent';
  }

  /** Drain pending warning events */
  drainWarnings(): LivenessWarningEvent[] {
    const warnings = this.warningQueue.splice(0);
    return warnings;
  }

  /** Whether bounded extension applies (busy-silent) */
  shouldExtendTimeout(): boolean {
    return this.getState() === 'busy-silent';
  }

  /** Whether hard cap (boundedExtensionFactor * timeoutMs) is exceeded */
  isHardCapExceeded(elapsedMs: number, timeoutMs: number): boolean {
    return elapsedMs >= this.config.boundedExtensionFactor * timeoutMs;
  }

  /** Start periodic CPU sampling */
  start(): void {
    if (this.timer) return;
    this.sampleOnce(); // immediate first sample
    this.timer = setInterval(() => this.sampleOnce(), this.config.sampleIntervalMs);
    this.timer.unref();
  }

  /** Stop and cleanup */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private sampleOnce(): void {
    // Check PID existence first
    try {
      process.kill(this.pid, 0); // signal 0 = existence check
    } catch {
      this.pidAlive = false;
      return;
    }

    // On Windows, `ps` is not available. The process.kill(pid, 0) check above
    // is sufficient for liveness detection. CPU-based busy-silent classification
    // is only available on Unix.
    if (process.platform === 'win32') return;

    // Sample CPU time via ps
    execFile('ps', ['-o', 'cputime=', '-p', String(this.pid)], (err, stdout) => {
      if (err) {
        // ps failed — process likely dead
        this.pidAlive = false;
        return;
      }
      this.prevCpuTimeMs = this.currCpuTimeMs;
      this.currCpuTimeMs = parseCpuTime(stdout);
      this.cpuGrowing = this.currCpuTimeMs > this.prevCpuTimeMs;

      // Check warning thresholds
      const silenceMs = Date.now() - this.lastActivityAt;

      if (silenceMs >= this.config.stallWarningMs && !this.stallWarningEmitted) {
        this.stallWarningEmitted = true;
        this.warningQueue.push(this.makeWarning('suspected_stall', silenceMs));
      } else if (silenceMs >= this.config.softWarningMs && !this.softWarningEmitted) {
        this.softWarningEmitted = true;
        this.warningQueue.push(this.makeWarning('alive_but_silent', silenceMs));
      }
    });
  }

  private makeWarning(level: 'alive_but_silent' | 'suspected_stall', silenceDurationMs: number): LivenessWarningEvent {
    return {
      __livenessWarning: true,
      state: this.getState(),
      silenceDurationMs,
      level,
      cpuTimeMs: this.currCpuTimeMs,
      processAlive: this.pidAlive,
    };
  }
}
