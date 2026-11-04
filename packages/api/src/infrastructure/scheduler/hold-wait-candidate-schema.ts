import { SCHEDULE_LIST_FILTER } from './schedule-list-schema.js';

/**
 * Armed hold-ball wake carriers, read by the 4-second active-execution poll.
 *
 * It starts with SCHEDULE_LIST_FILTER verbatim, so SQLite can serve the query from the existing
 * `idx_dynamic_schedule_list` partial index (which already excludes retired hold tombstones) instead of
 * scanning and decoding history. The narrower terms run only on that small set. `isPendingHoldBallWakeTask`
 * remains the authority; this selector only removes rows that cannot be armed holds before hydration.
 *
 * The unary `+` on `id` is deliberate: a bare `id GLOB 'hold-ball-*'` is a primary-key range, and the planner
 * prefers it — walking every historical hold row — over the partial index.
 */
export const HOLD_WAIT_CANDIDATE_FILTER = `${SCHEDULE_LIST_FILTER}
  AND enabled = 1
  AND template_id = 'reminder'
  AND +id GLOB 'hold-ball-*'`;
