/**
 * F167 sibling-PR (telemetry counter baseline awareness).
 *
 * Builds the counter-domain window for RuntimeEvalSnapshot.counterWindow.
 * Extracted from f167-eval.ts to avoid further entrenching that pre-existing
 * over-limit file (R3 cloud P1: AGENTS.md `文件 200 警告/350 硬上限`; the
 * parent file was already 475 lines on main before this feature landed).
 *
 * Why counterWindow exists (silent false positive fix):
 *   OTel SDK counters are in-memory and reset to 0 on every API process
 *   restart. LocalTraceStore hydrates 24h of history from Redis. Eval cats
 *   computing `rate = counter / window.durationHours` divide a fresh counter
 *   by a hydrated 24h trace window → false-negative "low activity" verdicts
 *   after restart. counterWindow exposes the process-lifetime denominator
 *   independently from the trace window so the eval rate stays correct.
 */

export interface CounterWindow {
  startMs: number;
  endMs: number;
  durationHours: number;
}

/**
 * Inputs the snapshot generator should accept from /api/telemetry/process-info.
 *
 *   processStartMs — epoch ms wall-clock anchor (server: Date.now() -
 *     Math.floor(uptime*1000)). Used as `counterWindow.startMs`.
 *   processUptimeSec — monotonic uptime from process.uptime() (NTP-safe).
 *     When present, this is the authoritative source for durationHours;
 *     falling back to `now - processStartMs` only when the server didn't
 *     expose uptime. R2 cloud P2 fix: prevents local-vs-remote clock mix.
 */
export interface CounterWindowInput {
  processStartMs?: number;
  processUptimeSec?: number;
}

/**
 * Build CounterWindow from process info, or undefined when nothing was supplied
 * (older runner / no /process-info endpoint). Pass the snapshot's `now` value
 * so the legacy fallback branch and the snapshot `endMs` stay consistent.
 *
 * R2 cloud P1 fix: process.uptime() returns fractional seconds, so
 * uptimeSec*1000 is fractional ms; bundleSnapshotSchema requires
 * counterWindow.startMs/endMs to be integer (z.number().int()). Math.round
 * the duration before adding to startMs.
 */
export function buildCounterWindow(input: CounterWindowInput, now: number): CounterWindow | undefined {
  if (input.processStartMs == null) return undefined;
  if (input.processUptimeSec != null) {
    const durationMs = Math.round(input.processUptimeSec * 1000);
    return {
      startMs: input.processStartMs,
      endMs: input.processStartMs + durationMs,
      durationHours: input.processUptimeSec / 3600,
    };
  }
  // Legacy / older-server fallback: derive duration from local clock.
  // Accepts NTP/cross-host drift risk; new servers should always supply
  // processUptimeSec via /api/telemetry/process-info.
  return {
    startMs: input.processStartMs,
    endMs: now,
    durationHours: (now - input.processStartMs) / 3_600_000,
  };
}
