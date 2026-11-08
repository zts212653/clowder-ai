import { readMacSleepEvidence } from './gate-sleep-evidence.mjs';

function confirmedOverlap(evidence, from, to) {
  if (evidence?.status !== 'available' || !Array.isArray(evidence.confirmedSleep)) return 0;
  const intervals = [];
  for (const interval of evidence.confirmedSleep) {
    if (
      typeof interval.evidenceId !== 'string' ||
      !interval.evidenceId ||
      !Number.isFinite(interval.startedAt) ||
      !Number.isFinite(interval.endedAt) ||
      interval.endedAt < interval.startedAt ||
      interval.endedAt > to
    )
      return 0;
    const start = Math.max(from, interval.startedAt);
    const end = Math.min(to, interval.endedAt);
    if (end > start) intervals.push([start, end]);
  }
  intervals.sort(([a], [b]) => a - b);
  let total = 0;
  let cursor = from;
  for (const [start, end] of intervals) {
    total += Math.max(0, end - Math.max(cursor, start));
    cursor = Math.max(cursor, end);
  }
  return total;
}

export function createGateCommandClock({
  now = () => Math.floor(performance.now()),
  wallNow = Date.now,
  readSleepEvidence = readMacSleepEvidence,
  gapThresholdMs = 1_000,
} = {}) {
  let previousRaw = now();
  let previousWall = wallNow();
  let sleepDurationMs = 0;
  return {
    sleepDurationMs: () => sleepDurationMs,
    now: () => {
      let raw = now();
      let wall = wallNow();
      const rawGap = raw - previousRaw;
      const wallGap = wall - previousWall;
      // A delayed supervisor is only a reason to inspect OS evidence. Its child
      // may have remained active, so the gap itself never forgives any budget.
      if (rawGap >= gapThresholdMs && wallGap >= gapThresholdMs && Math.abs(rawGap - wallGap) <= 250) {
        let evidence;
        try {
          evidence = readSleepEvidence({ from: previousWall, to: wall });
        } catch {
          evidence = null;
        }
        const afterRaw = now();
        const afterWall = wallNow();
        if (Math.abs(afterRaw - raw - (afterWall - wall)) <= 250) {
          sleepDurationMs += Math.min(
            afterRaw - previousRaw,
            Math.floor(confirmedOverlap(evidence, previousWall, afterWall)),
          );
        }
        // Include the reader's own elapsed time, without repeatedly probing it.
        raw = afterRaw;
        wall = afterWall;
      }
      previousRaw = raw;
      previousWall = wall;
      return raw - sleepDurationMs;
    },
  };
}

export function monitorGateCommandBudget({ clock, startedAt, budgetMs, onTimeout, pollMs = 250 }) {
  let stopped = false;
  let timer;
  const check = () => {
    if (stopped) return;
    const remainingMs = budgetMs - (clock.now() - startedAt);
    if (remainingMs <= 0) {
      stopped = true;
      onTimeout();
      return;
    }
    timer = setTimeout(check, Math.min(remainingMs, pollMs));
    timer.unref();
  };
  check();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
