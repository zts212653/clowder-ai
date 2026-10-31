/**
 * F183 Phase C2/C3 — Per-thread broadcast rate monitor.
 *
 * 背景：Phase A bug report (`docs/bug-report/2026-04-27-stream-event-delivery-lag/`)
 * 截图含黄色警告 "in-process app-server event stream lagged; dropped 32 events"。
 * grep 实证此字面不在 cat-cafe codebase / node_modules 任意 dep 里 —— likely
 * 历史 instrumentation 或外部 (Antigravity IDE / browser extension) 来源。AC-C3 的
 * 字面源追溯到此结论。
 *
 * 本文件落地 AC-C2.3 (backpressure 触发指标暴露) + AC-C3.2 (结构化诊断日志替代
 * 字面)：在 SocketManager.broadcastAgentMessage 唯一 choke point 加 per-thread
 * emit rate 滑动窗口，超阈值时 log.warn 一次（去抖）+ 暴露 `getStats(threadId)`
 * 给 admin/test introspection。
 *
 * 设计选择：
 * - **不做 buffer/drop**：AC-C2.2 spec 文字提了"加 buffer 上限 + 限速 + 丢弃策略"，
 *   但调研后没找到实际 backpressure 触发点 (socket.io emit 是 best-effort，没有内置
 *   drop)。客户端 AC-C1 gap detection + retry catchup 已经是 user-visible safety net。
 *   premature buffer/drop 是过度设计；先让 observability 看到再加 enforcement。
 * - **滑动窗口**：1s 窗口计数。简单、O(1) per emit (只 push timestamp)。
 * - **去抖告警**：同 thread 至多每 5s 一次警告，避免高频持续超阈值时 log 风暴。
 * - **可配阈值**：默认 200 events/sec sustained 1s。生产环境可通过 SocketManager
 *   constructor 传入覆盖。
 */

const DEFAULT_RATE_THRESHOLD = 200; // events/sec
const WINDOW_MS = 1000; // 1s sliding window
const WARN_DEDUP_MS = 5000; // 5s dedup interval per thread

export interface BroadcastRateMonitorOptions {
  /** Rate threshold (events per WINDOW_MS) above which a warning is logged. Default 200. */
  rateThreshold?: number;
  /** Sliding window size in ms. Default 1000ms. */
  windowMs?: number;
  /** Min interval between warnings per thread (ms). Default 5000ms. */
  warnDedupMs?: number;
  /** Logger callback. Default no-op (caller injects pino/console). */
  onWarn?: (event: BroadcastRateWarnEvent) => void;
  /**
   * Clock injection. Cloud R3 P2: must be **monotonic** — wall-clock sources
   * (`Date.now`) get adjusted by NTP / VM time sync and can move backward,
   * which makes throttle / dedup checks `ts - lastT >= window` go negative
   * and silently suppress eviction + warnings. Default uses
   * `performance.now()` (monotonic from process start). Tests inject a fake
   * monotonic clock; production overrides should also be monotonic.
   */
  now?: () => number;
}

export interface BroadcastRateWarnEvent {
  threadId: string;
  /** Events counted in the most recent window. */
  windowCount: number;
  /** Configured threshold that triggered the warn. */
  threshold: number;
  /** Window size in ms. */
  windowMs: number;
  /**
   * Timestamp of warn emission, from the injected `now()` clock. Default is
   * monotonic (`performance.now()` ms since process start) — NOT wall-clock.
   * Logger transports (pino, etc.) add their own wall-clock `time` field.
   */
  timestamp: number;
}

export interface BroadcastRateStats {
  /** Events counted in the current sliding window. */
  windowCount: number;
  /** Sliding window size (ms). */
  windowMs: number;
  /** Configured rate threshold (events / windowMs). */
  threshold: number;
  /** Last warn timestamp (ms) or 0 if never warned. */
  lastWarnAt: number;
}

/**
 * Sliding window state per thread. Uses head-index (deque-style) instead of
 * `Array.shift()` to keep `record()` amortized O(1) under sustained load.
 * 砚砚 R1 P2 fix: array.shift() is O(n) — under high-frequency stream
 * (CLI tool burst 200+/sec), repeated shifts make the monitor itself the
 * bottleneck it's supposed to detect.
 */
interface WindowState {
  /** Append-only buffer of emit timestamps */
  readonly stamps: number[];
  /** Index of first unexpired entry (entries [0..head) are dead) */
  head: number;
}

export class BroadcastRateMonitor {
  private readonly threshold: number;
  private readonly window: number;
  private readonly warnDedup: number;
  private readonly onWarn: (event: BroadcastRateWarnEvent) => void;
  private readonly now: () => number;
  /** threadId → sliding window state */
  private threadEmits: Map<string, WindowState> = new Map();
  /** threadId → last warn timestamp */
  private lastWarnAt: Map<string, number> = new Map();
  /**
   * Cloud R2 P1 — throttle eviction to at most once per window. Sentinel is
   * `-Infinity` (never swept) so the first call always passes the
   * `ts - lastEvictAt >= window` gate regardless of clock base. 砚砚 R5 P2
   * fix: `0` collided with `performance.now()` time base (process-relative)
   * — early `ts < windowMs` would falsely gate the first sweep.
   */
  private lastEvictAt = Number.NEGATIVE_INFINITY;
  /** Diagnostic counter — number of eviction sweeps performed. */
  private evictCount = 0;

  constructor(opts: BroadcastRateMonitorOptions = {}) {
    this.threshold = opts.rateThreshold ?? DEFAULT_RATE_THRESHOLD;
    this.window = opts.windowMs ?? WINDOW_MS;
    this.warnDedup = opts.warnDedupMs ?? WARN_DEDUP_MS;
    this.onWarn = opts.onWarn ?? (() => {});
    // Cloud R3 P2: default to monotonic clock to survive NTP / VM time sync
    // backward jumps. `performance` is global in Node 16+ and browsers.
    this.now = opts.now ?? (() => performance.now());
  }

  /**
   * Record an emit for a thread. Updates sliding window + triggers warn callback
   * if rate exceeds threshold (debounced per thread).
   *
   * **best-effort guarantee** (砚砚 R1 P1 fix): `onWarn` is wrapped in try/catch
   * — a logger throw must NOT propagate to caller. Otherwise broadcast emit
   * (which calls record() before io.to.emit) would be aborted by observability,
   * making the monitor cause the very symptom ("气泡不出来") it's there to detect.
   *
   * Head-index sliding window (砚砚 R1 P2 fix): keep stamps in append-only
   * buffer, advance `head` for expired entries — amortized O(1) per record.
   * When buffer would grow unbounded under continuous traffic, compact in
   * batches (≥ 2× window slots dead) to bound memory.
   */
  record(threadId: string): void {
    const ts = this.now();
    // Cloud R1 P2-A + R2 P1 + R4 P2: opportunistic eviction, throttled to at
    // most once per window, runs at any cardinality.
    // - R1 P2-A: transient threadIds in long-running API would grow unbounded
    // - R2 P1: throttle prevents O(n) walk per emit
    // - R4 P2: low-cardinality (e.g., one noisy idle thread) no longer needs
    //   1024+ threads before cleanup — idle stamps for an active-then-idle
    //   thread now get evicted on the next record() once window has elapsed
    if (this.threadEmits.size > 0 && ts - this.lastEvictAt >= this.window) {
      this.evictExpired(ts);
    }
    let state = this.threadEmits.get(threadId);
    if (!state) {
      state = { stamps: [], head: 0 };
      this.threadEmits.set(threadId, state);
    }
    // Advance head past expired entries — O(k) where k is # of newly-expired
    // entries this call (NOT total array length). Amortized O(1) per record.
    //
    // Cloud R1 P2-B (boundary): use `<= cutoff` (inclusive) so an entry at
    // exactly `cutoff` is treated as expired. Otherwise burst at t=0 and
    // burst at t=1000ms with windowMs=1000 → t=0 entries still counted at
    // t=1000 → false threshold trigger at the boundary.
    const cutoff = ts - this.window;
    while (state.head < state.stamps.length && state.stamps[state.head] <= cutoff) {
      state.head++;
    }
    // Bound memory: when dead-prefix exceeds 2× live count, compact.
    // Without this, sustained traffic grows the buffer linearly. Compact in
    // batches keeps amortized O(1) — 1 splice per ~N records.
    if (state.head > 0 && state.head >= state.stamps.length - state.head) {
      state.stamps.splice(0, state.head);
      state.head = 0;
    }
    state.stamps.push(ts);

    const liveCount = state.stamps.length - state.head;
    if (liveCount > this.threshold) {
      // 砚砚 R5 P2 fix: `undefined` (never warned) bypasses dedup directly —
      // do NOT fall back to `0`, which collides with `performance.now()`'s
      // process-relative time base (early `ts < warnDedupMs` would suppress
      // the first warning).
      const lastWarn = this.lastWarnAt.get(threadId);
      if (lastWarn === undefined || ts - lastWarn >= this.warnDedup) {
        this.lastWarnAt.set(threadId, ts);
        // 砚砚 R1 P1: wrap user callback. Logger / Pino transport / sink errors
        // must NOT abort the broadcast pipeline.
        try {
          this.onWarn({
            threadId,
            windowCount: liveCount,
            threshold: this.threshold,
            windowMs: this.window,
            timestamp: ts,
          });
        } catch {
          // Best-effort observability: swallow callback errors.
        }
      }
    }
  }

  /** Read current stats for a thread (test/admin introspection). */
  getStats(threadId: string): BroadcastRateStats {
    const state = this.threadEmits.get(threadId);
    let windowCount = 0;
    if (state) {
      const ts = this.now();
      const cutoff = ts - this.window;
      // Cloud R1 P2-B: same exclusive boundary as record() (`> cutoff`)
      for (let i = state.head; i < state.stamps.length; i++) {
        if (state.stamps[i] > cutoff) windowCount++;
      }
    }
    return {
      windowCount,
      windowMs: this.window,
      threshold: this.threshold,
      lastWarnAt: this.lastWarnAt.get(threadId) ?? 0,
    };
  }

  /**
   * Cloud R1 P2-A — sweep expired-only entries. Called opportunistically from
   * `record()` once per window. Pure cleanup; does not affect any observable
   * behavior for active threads.
   *
   * Cloud R2 P1: stamps `lastEvictAt` so subsequent record() calls within the
   * same window skip this O(n) walk — caller throttles via the gate.
   *
   * Cloud R4 P2: runs at any cardinality (was gated by 1024-thread threshold,
   * which left low-cardinality deployments with idle thread stamps retained
   * indefinitely).
   */
  private evictExpired(ts: number): void {
    this.evictCount++;
    this.lastEvictAt = ts;
    const cutoff = ts - this.window;
    for (const [threadId, state] of this.threadEmits) {
      // Skip if any live entry remains (cheap head check after compaction)
      const lastStamp = state.stamps[state.stamps.length - 1] ?? 0;
      if (lastStamp > cutoff) continue;
      // All entries expired — drop state entirely (lastWarnAt stays for
      // dedup correctness; will be evicted on its own when stale enough).
      this.threadEmits.delete(threadId);
    }
    // Sweep stale lastWarnAt: any warn timestamp older than 2 dedup windows
    // is also evictable (no dedup decision depends on it anymore).
    const warnCutoff = ts - this.warnDedup * 2;
    for (const [threadId, lastWarn] of this.lastWarnAt) {
      if (lastWarn < warnCutoff && !this.threadEmits.has(threadId)) {
        this.lastWarnAt.delete(threadId);
      }
    }
  }

  /**
   * Diagnostic — number of eviction sweeps performed. Exposed for tests +
   * admin introspection (verifies throttle is bounding sweep frequency).
   */
  get sweepCount(): number {
    return this.evictCount;
  }

  /** Test/admin: clear a thread's tracking state. */
  reset(threadId: string): void {
    this.threadEmits.delete(threadId);
    this.lastWarnAt.delete(threadId);
  }

  /** Test only: clear all tracking state. */
  resetAll(): void {
    this.threadEmits.clear();
    this.lastWarnAt.clear();
    this.lastEvictAt = Number.NEGATIVE_INFINITY;
    this.evictCount = 0;
  }
}
