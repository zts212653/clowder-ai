/** Shared verbatim by the partial index and its selector: SQLite can prove
 * the query is covered, and disabled live-command tombstones remain eligible. */
export const MANAGED_COMMAND_CANDIDATE_FILTER = `template_id = 'reminder'
  AND json_extract(params_json, '$.holdLifecycle.mode') = 'wake_when'
  AND ((enabled = 1 AND json_extract(params_json, '$.holdLifecycle.status') = 'active')
    OR json_extract(params_json, '$.holdLifecycle.managedCommand.state') IN ('command_running', 'condition_met'))`;

export const MANAGED_COMMAND_CANDIDATE_INDEX = `CREATE INDEX IF NOT EXISTS idx_dynamic_managed_candidates
  ON dynamic_task_defs(created_at DESC) WHERE ${MANAGED_COMMAND_CANDIDATE_FILTER}`;
