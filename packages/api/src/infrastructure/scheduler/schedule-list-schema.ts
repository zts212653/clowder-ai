import { DEVELOPMENT_RETURN_TEMPLATE_ID } from '@cat-cafe/shared';
import { HOLD_TERMINAL_LIFECYCLE_STATUSES } from '../../domains/ball-custody/hold-lifecycle-status.js';

/** Same identity and valid-projection boundary as isRetiredHoldBallTombstone.
 * Share the literal filter with the partial index so polling never scans or
 * decodes historical wake payloads. Paused ordinary tasks remain resumable. */
export const SCHEDULE_LIST_FILTER = `template_id <> '${DEVELOPMENT_RETURN_TEMPLATE_ID}'
  AND NOT COALESCE(
    CASE WHEN id GLOB 'hold-ball-*' AND template_id = 'reminder' AND created_by GLOB 'hold-ball:*'
    THEN json_extract(params_json, '$.holdLifecycle.mode') IN ('timer', 'wake_when')
    AND json_type(params_json, '$.holdLifecycle.createdBy') = 'text'
    AND json_extract(params_json, '$.holdLifecycle.status') IN (${HOLD_TERMINAL_LIFECYCLE_STATUSES.map((s) => `'${s}'`).join(', ')}) END,
    0)`;

export const SCHEDULE_LIST_INDEX = `CREATE INDEX IF NOT EXISTS idx_dynamic_schedule_list
  ON dynamic_task_defs(created_at DESC) WHERE ${SCHEDULE_LIST_FILTER}`;
