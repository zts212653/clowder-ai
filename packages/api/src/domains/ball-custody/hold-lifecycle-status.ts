/**
 * Terminal wake carriers remain durable history, never resumable schedule tasks.
 * This list also defines the persisted idx_dynamic_schedule_list predicate.
 * Changing it requires a new schema migration that rebuilds that index.
 */
export const HOLD_TERMINAL_LIFECYCLE_STATUSES = [
  'retired_by_event',
  'retired_by_replacement',
  'retired_expired',
  'retired_invalid',
  'cancelled_by_user',
  'fired',
  'not_started',
  'escalated',
] as const;

export type HoldLifecycleStatus = (typeof HOLD_TERMINAL_LIFECYCLE_STATUSES)[number] | 'active' | 'cancel_requested';

export function isTerminalHoldLifecycleStatus(status: unknown): boolean {
  return HOLD_TERMINAL_LIFECYCLE_STATUSES.some((terminal) => terminal === status);
}
