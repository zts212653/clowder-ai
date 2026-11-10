/**
 * F333: API-side owner of the shared browser process (pattern: MemoryProcess).
 *
 * - Forked on the first browser request, never at API boot.
 * - Single-flight: concurrent requests wait for the same start (Sol5.6 pre-review).
 * - The child dies with the API (IPC disconnect) and exits by itself when idle; a dead child is
 *   re-forked by the next request. In-flight requests are never replayed.
 * - Watchdog: the child heartbeats over IPC. `browser_run_code_unsafe` can block its event loop
 *   forever; a child silent past the hang window is killed so the next request gets a fresh one
 *   (Sol5.6 R1 P1-4). The stuck call fails; it is not retried.
 * - A child about to exit (idle, or a call outlived its deadline; Sol5.6 R3) reports `retiring`.
 * - Generations never overlap: a retired child gets RETIRE_GRACE_MS to close Chrome, then is killed,
 *   and the next child is forked only after it has exited, because both need the same profile.
 */
import { type ChildProcess, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface BrowserEndpoint {
  port: number;
  key: string;
}

export interface BrowserProcessOptions {
  /** Test seam: defaults to forking browser-process-entry. */
  spawn?: () => ChildProcess;
  readyTimeoutMs?: number;
  /** Test seams for the watchdog. */
  hangTimeoutMs?: number;
  watchdogIntervalMs?: number;
  now?: () => number;
  retireGraceMs?: number;
  /** Test seam for the child's per-call deadline (it defaults to 5 minutes). */
  requestDeadlineMs?: number;
}

/** The child heartbeats every 5s; 30s of silence means its event loop is stuck. */
const HANG_TIMEOUT_MS = 30_000;
/** Longer than the child's own close bound, so a healthy child always exits by itself. */
const RETIRE_GRACE_MS = 10_000;

export class BrowserProcess {
  private child?: ChildProcess;
  private ready?: Promise<BrowserEndpoint>;
  /** The previous generation, until it (and the Chrome it launched) has exited. */
  private retiring?: Promise<void>;
  private readonly retired = new WeakSet<ChildProcess>();
  private lastBeat = 0;
  private watchdog?: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly options: BrowserProcessOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  endpoint(): Promise<BrowserEndpoint> {
    if (this.child && !this.child.connected) this.retire(this.child, 0);
    if (this.ready) return this.ready; // running, or still starting
    const ready = this.startAfterRetired();
    this.ready = ready;
    ready.catch(() => {
      if (this.ready === ready) this.ready = undefined;
    });
    return ready;
  }

  private async startAfterRetired(): Promise<BrowserEndpoint> {
    await this.retiring;
    return this.start();
  }

  /** Takes a child out of service: it may close Chrome for `graceMs`, then it is killed. */
  private retire(child: ChildProcess, graceMs: number): void {
    if (this.child === child) {
      this.child = undefined;
      this.ready = undefined;
    }
    if (this.retired.has(child) || child.exitCode != null || child.signalCode != null) return;
    this.retired.add(child);
    let timer: NodeJS.Timeout | undefined;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const retiring: Promise<void> = exited.then(() => {
      clearTimeout(timer);
      if (this.retiring === retiring) this.retiring = undefined;
    });
    this.retiring = retiring;
    if (graceMs <= 0) child.kill('SIGKILL');
    else timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
    this.child?.disconnect();
    this.child = undefined;
    this.ready = undefined;
  }

  private watch(child: ChildProcess): void {
    this.lastBeat = this.now();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.child !== child) return;
      if (this.now() - this.lastBeat <= (this.options.hangTimeoutMs ?? HANG_TIMEOUT_MS)) return;
      this.retire(child, 0);
    }, this.options.watchdogIntervalMs ?? 5_000);
    this.watchdog.unref?.();
  }

  private start(): Promise<BrowserEndpoint> {
    const key = randomBytes(32).toString('hex');
    const child = this.options.spawn?.() ?? defaultSpawn();
    // Drain stderr so a chatty child never blocks on a full pipe; keep a short tail for diagnosis.
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2048);
    });
    const failure = (code: string) => Object.assign(new Error(code), { stderrTail });
    const starting = new Promise<BrowserEndpoint>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Settle first so the cause stays "timeout" even if the kill emits exit synchronously.
        reject(failure('browser_process_start_timeout'));
        child.kill('SIGKILL');
      }, this.options.readyTimeoutMs ?? 20_000);
      child.on('message', (message: unknown) => {
        const port = (message as { type?: string; port?: unknown } | null)?.port;
        if ((message as { type?: string }).type === 'heartbeat' && this.child === child) this.lastBeat = this.now();
        if ((message as { type?: string }).type === 'retiring' && this.child === child)
          this.retire(child, this.options.retireGraceMs ?? RETIRE_GRACE_MS);
        if ((message as { type?: string }).type === 'ready' && typeof port === 'number') {
          clearTimeout(timer);
          this.child = child;
          this.watch(child);
          resolve({ port, key });
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(failure('browser_process_exited'));
      });
      const deadline = this.options.requestDeadlineMs;
      child.send(deadline ? { type: 'init', key, requestDeadlineMs: deadline } : { type: 'init', key });
    });
    child.once('exit', () => {
      if (this.child !== child) return; // a failed start rejects `starting`; endpoint() clears it
      this.child = undefined;
      this.ready = undefined;
    });
    return starting;
  }
}

function defaultSpawn(): ChildProcess {
  const source = import.meta.url.endsWith('.ts');
  const entry = new URL(`./browser-process-entry.${source ? 'ts' : 'js'}`, import.meta.url);
  return fork(fileURLToPath(entry), [], {
    execArgv: source ? ['--import', 'tsx'] : [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
}
