import { closeSync, constants, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { TripwireLogBudget } from './event-loop-tripwire-budget.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETAIN_DAYS = 14;

/** Worker-owned code-only evidence, independent of main-thread callbacks and Worker stdio forwarding. */
export function openTripwireLog(logDir: string, stream: 'code' | 'resources' = 'code') {
  if (isMainThread) throw Error('tripwire_log_requires_worker');
  mkdirSync(logDir, { recursive: true });
  let fd: number | undefined;
  let day = '';
  let failed = false;
  const budget = stream === 'code' ? new TripwireLogBudget() : new TripwireLogBudget(12, 65536);
  const prefix = stream === 'code' ? 'event-loop-tripwire' : 'event-loop-resources';
  const summaryForStream = (summary: ReturnType<TripwireLogBudget['drain']>) =>
    summary && stream === 'resources' ? { ...summary, kind: 'event_loop_resource_suppressed' } : summary;
  function append(report: object) {
    const now = Date.now();
    rotate(now);
    const line = Buffer.from(`${JSON.stringify({ level: 40, time: new Date(now).toISOString(), ...report })}\n`);
    if (fd === undefined || writeSync(fd, line) !== line.byteLength) throw Error('short_tripwire_write');
  }
  function rotate(now: number) {
    const nextDay = new Date(now).toISOString().slice(0, 10);
    if (nextDay === day) return;
    if (fd !== undefined) closeSync(fd);
    fd = undefined;
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);
    fd = openSync(join(logDir, `${prefix}.${nextDay}.ndjson`), flags, 0o600);
    day = nextDay;
    for (const file of readdirSync(logDir)) {
      const date = new RegExp(`^${prefix}\\.(\\d{4}-\\d{2}-\\d{2})\\.ndjson$`).exec(file)?.[1];
      if (!date || Date.parse(date) >= now - RETAIN_DAYS * DAY_MS) continue;
      try {
        unlinkSync(join(logDir, file));
      } catch {
        /* Retention cannot lose this process's evidence. */
      }
    }
  }
  rotate(Date.now());
  return {
    write(report: object) {
      const allowance = budget.take(Buffer.byteLength(JSON.stringify(report)) + 80, performance.now());
      const { allowed } = allowance;
      const summary = summaryForStream(allowance.summary);
      if (!allowed) return { status: 'suppressed' as const, summary };
      if (failed) return { status: 'failed' as const, summary };
      try {
        if (summary) append({ pid: process.pid, ...summary });
        append(report);
        return { status: 'written' as const, summary };
      } catch {
        failed = true;
        return { status: 'failed' as const };
      }
    },
    close() {
      const summary = summaryForStream(budget.drain(performance.now()));
      if (summary && !failed) {
        try {
          append({ pid: process.pid, ...summary });
        } catch {
          /* Cleanup remains independent of the sink. */
        }
      }
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* A diagnostic sink cannot fail shutdown. */
        }
      }
      fd = undefined;
      return summary;
    },
  };
}
