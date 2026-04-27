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
  private sampling = false;
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

  /**
   * Final flush for shutdown races:
   * stdout can close before the next generator loop drains a warning that was
   * already queued by an in-flight sample. Wait briefly for that sample to land
   * so callers can drain pending warnings before exit, but do not synthesize
   * any new warnings during shutdown.
   */
  async flushPendingWarnings(): Promise<void> {
    const deadline = Date.now() + Math.max(this.config.sampleIntervalMs, 50);
    while (this.sampling && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
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
    // Guard against concurrent samples — nested async calls (ps→pgrep→ps) can
    // overlap when sampleIntervalMs is shorter than the async chain duration.
    if (this.sampling) return;
    this.sampling = true;

    // Check PID existence first
    try {
      process.kill(this.pid, 0); // signal 0 = existence check
    } catch {
      this.pidAlive = false;
      this.sampling = false;
      return;
    }

    // Windows: `ps` is not available. Use process.kill(pid, 0) for liveness
    // and skip CPU sampling. Conservative: assume idle (cpuGrowing = false)
    // so that idle-silent → stall detection still works on Windows.
    if (process.platform === 'win32') {
      this.cpuGrowing = false;
      this.emitSilenceWarnings();
      this.sampling = false;
      return;
    }

    // Single ps call to get CPU for process tree (main + direct children).
    // When the CLI runs a tool call (e.g. pnpm test), the test subprocess is busy
    // but the main CLI process is idle-waiting. Without checking children, the probe
    // would misclassify as idle-silent and trigger stallAutoKill (false positive).
    // Uses one `ps -A` instead of nested ps→pgrep→ps to avoid pgrep callback delays.
    execFile('ps', ['-A', '-o', 'pid=,ppid=,cputime='], (err, stdout) => {
      if (err) {
        this.pidAlive = false;
        this.sampling = false;
        return;
      }
      let mainCpu = -1;
      let childCpuTotal = 0;
      for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const pid = Number(parts[0]);
        const ppid = Number(parts[1]);
        const cpu = parseCpuTime(parts[2]);
        if (pid === this.pid) mainCpu = cpu;
        else if (ppid === this.pid) childCpuTotal += cpu;
      }
      if (mainCpu < 0) {
        this.pidAlive = false;
        this.sampling = false;
        return;
      }
      this.updateCpuSample(mainCpu + childCpuTotal);
    });
  }

  /** Update CPU tracking and emit warnings after sampling */
  private updateCpuSample(totalCpuMs: number): void {
    this.prevCpuTimeMs = this.currCpuTimeMs;
    this.currCpuTimeMs = totalCpuMs;
    this.cpuGrowing = this.currCpuTimeMs > this.prevCpuTimeMs;
    this.emitSilenceWarnings();
    this.sampling = false;
  }

  /** Emit soft/stall warnings based on silence duration (shared by Windows and Unix paths) */
  private emitSilenceWarnings(): void {
    const silenceMs = Date.now() - this.lastActivityAt;
    if (silenceMs >= this.config.stallWarningMs && !this.stallWarningEmitted) {
      this.stallWarningEmitted = true;
      this.warningQueue.push(this.makeWarning('suspected_stall', silenceMs));
    } else if (silenceMs >= this.config.softWarningMs && !this.softWarningEmitted) {
      this.softWarningEmitted = true;
      this.warningQueue.push(this.makeWarning('alive_but_silent', silenceMs));
    }
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
