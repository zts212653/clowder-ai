/**
 * F174 Phase C — MCP client background refresh loop.
 *
 * Periodically pings POST /api/callbacks/refresh-token to keep the callback
 * token alive in long sessions where猫 has no incidental tool calls.
 * Uses adaptive interval per KD-6 (gpt52 proposal):
 *   nextDelayMs = clamp(ttlRemainingMs / 4, 5min, 30min) * jitter
 *
 * Why background loop instead of猫-callable tool: refresh is plumbing, not a
 * cognitive action; surfacing it as an MCP tool would invite猫 to call it
 * proactively for the wrong reasons. Best-effort; failures log warn and
 * reschedule — the next real verify() surfaces auth issues with structured
 * reason from Phase A.
 */

import { buildAuthHeaders, getCallbackConfig } from './tools/callback-tools.js';

/**
 * Server-side refresh cooldown is 5min per invocation. The client's adaptive
 * delay must NEVER fall below cooldown — otherwise the loop fires before
 * cooldown clears, gets 429, wastes a round-trip + warn-log noise. Cloud
 * Codex P2 (PR #1368): with previous MIN_DELAY_MS=5min and ±15% jitter,
 * worst-case lower bound was 5min × 0.85 = 4.25min < 5min cooldown.
 *
 * Fix: pre-divide MIN by jitter floor so jittered value stays above cooldown.
 * Plus a small safety buffer for clock skew between client and server.
 */
const SERVER_COOLDOWN_MS = 5 * 60_000;
const JITTER_FLOOR = 0.85; // 0.85 + Math.random() * 0.3 → range [0.85, 1.15]
const COOLDOWN_BUFFER = 1.05; // 5% margin for clock skew
const MIN_DELAY_MS = Math.ceil((SERVER_COOLDOWN_MS * COOLDOWN_BUFFER) / JITTER_FLOOR); // ≈ 6.18min
const MAX_DELAY_MS = 30 * 60_000;
const FALLBACK_DELAY_MS = MIN_DELAY_MS; // initial / on-failure back-off

/**
 * AC-C3: clamp(ttlRemainingMs/4, 5min, 30min) + ±15% jitter.
 *
 * Pure function — testable without a running timer or HTTP layer.
 */
export function computeNextRefreshDelay(ttlRemainingMs: number): number {
  const proportional = ttlRemainingMs / 4;
  const clamped = Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, proportional));
  const jitter = JITTER_FLOOR + Math.random() * 0.3; // ±15% around 1.0
  return Math.floor(clamped * jitter);
}

/**
 * AC-C5: refresh failure does not crash. Returns rescheduling decision so
 * the loop can keep trying. Does not differentiate by error type yet — we
 * back off uniformly to FALLBACK_DELAY_MS. The next real verify() will
 * surface persistent auth failures with structured Phase A reason.
 */
export function handleRefreshFailure(_err: unknown): { shouldReschedule: boolean; delayMs: number } {
  return { shouldReschedule: true, delayMs: FALLBACK_DELAY_MS };
}

interface RefreshLoopHandle {
  stop: () => void;
}

/**
 * Default per-tick fetch timeout. Cloud Codex P1 (PR #1368, e521cc7aa):
 * without an AbortSignal, a hung TCP socket leaves the await pending forever
 * and the loop never reschedules — token expires silently in long sessions.
 * 10s covers slow networks; well under the 5min server cooldown so a stuck
 * tick doesn't shift the next attempt out of the cooldown safety window.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Cloud Codex P2 (PR #1368): single refresh attempt — raw fetch, no retry
 * layer. callbackPost goes through callback-retry (`shouldRetryStatus` retries
 * 408/429/5xx) which would burn 3 wasted retries on 429 (server cooldown is
 * 5min — retry within seconds always fails). Refresh loop already IS a retry
 * mechanism; doubling is structural duplication.
 *
 * Returns ok+nextDelayMs from server-reported ttlRemainingMs, or
 * ok:false+nextDelayMs from FALLBACK_DELAY_MS on any failure (including timeout).
 */
export async function performRefreshTick(
  options: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; nextDelayMs: number }> {
  const config = getCallbackConfig();
  if (!config) {
    return { ok: false, nextDelayMs: FALLBACK_DELAY_MS };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  try {
    const response = await fetch(`${config.apiUrl}/api/callbacks/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(config) },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`[refresh-loop] refresh failed (${response.status}):`, body.slice(0, 200));
      return { ok: false, nextDelayMs: FALLBACK_DELAY_MS };
    }

    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      if (parsed?.ok && typeof parsed.ttlRemainingMs === 'number') {
        return { ok: true, nextDelayMs: computeNextRefreshDelay(parsed.ttlRemainingMs) };
      }
    } catch {
      /* malformed response — fall back */
    }
    return { ok: false, nextDelayMs: FALLBACK_DELAY_MS };
  } catch (err) {
    console.warn('[refresh-loop] refresh threw:', err);
    return { ok: false, nextDelayMs: FALLBACK_DELAY_MS };
  }
}

/**
 * Cloud Codex P1 (PR #1368, e4da094a59): registering custom SIGINT/SIGTERM
 * handlers without calling process.exit() suppresses Node's default termination
 * behavior, leaving the MCP process unable to shut down on signals.
 *
 * Cloud Codex P2 (PR #1368, 7de77a70d): exit(0) hides termination cause from
 * supervisors. Standard Unix convention: exit(128 + signum) — SIGTERM → 143,
 * SIGINT → 130 — preserves signal semantics for shells/process managers.
 *
 * Process is dependency-injected for tests.
 */
interface ShutdownProcess {
  on: (signal: 'SIGTERM' | 'SIGINT', handler: () => void) => unknown;
  exit: (code: number) => void;
}

const SIGNAL_NUMBERS: Record<'SIGTERM' | 'SIGINT', number> = { SIGTERM: 15, SIGINT: 2 };

export function installShutdownHandlers(loop: RefreshLoopHandle, proc: ShutdownProcess = process): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    proc.on(signal, () => {
      loop.stop();
      proc.exit(128 + SIGNAL_NUMBERS[signal]);
    });
  }
}

/**
 * Spawns a background timer that periodically calls /api/callbacks/refresh-token.
 * Returns a handle to stop the loop on process exit.
 *
 * No-op (warn) when callback config is absent — refresh isn't applicable.
 */
export function startRefreshLoop(): RefreshLoopHandle {
  const config = getCallbackConfig();
  if (!config) {
    console.warn('[refresh-loop] no callback config — refresh loop disabled');
    return { stop: () => {} };
  }

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const { nextDelayMs } = await performRefreshTick();
    if (!stopped) {
      timer = setTimeout(tick, nextDelayMs);
      timer.unref();
    }
  };

  // First tick after FALLBACK_DELAY_MS (let server settle).
  timer = setTimeout(tick, FALLBACK_DELAY_MS);
  timer.unref();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
