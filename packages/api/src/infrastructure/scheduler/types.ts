/**
 * Minimal scheduled task interface.
 *
 * MVP: tasks are run by a simple setInterval-based TaskRunner.
 * Future: replace TaskRunner with cron / priority queue / distributed scheduler
 * without changing task implementations.
 */
export interface ScheduledTask {
  /** Unique task name for logging and dedup */
  name: string;
  /** Interval in milliseconds between ticks */
  intervalMs: number;
  /** Check if this task is enabled (e.g. feature flag) */
  enabled: () => boolean;
  /** Execute one tick. Errors are caught by TaskRunner, never crash the process. */
  execute: () => Promise<void>;
}
