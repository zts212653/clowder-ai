/** F139: transactionally maintained read index; task_run_ledger remains canonical. */

const addNewRun = `
  INSERT INTO task_run_stats (task_id, total, delivered, failed, skipped)
  VALUES (
    NEW.task_id, 1,
    NEW.outcome = 'RUN_DELIVERED',
    NEW.outcome = 'RUN_FAILED',
    NEW.outcome IN ('SKIP_NO_SIGNAL', 'SKIP_DISABLED', 'SKIP_OVERLAP')
  )
  ON CONFLICT(task_id) DO UPDATE SET
    total = total + excluded.total,
    delivered = delivered + excluded.delivered,
    failed = failed + excluded.failed,
    skipped = skipped + excluded.skipped;
`;

const removeOldRun = `
  UPDATE task_run_stats SET
    total = total - 1,
    delivered = delivered - (OLD.outcome = 'RUN_DELIVERED'),
    failed = failed - (OLD.outcome = 'RUN_FAILED'),
    skipped = skipped - (OLD.outcome IN ('SKIP_NO_SIGNAL', 'SKIP_DISABLED', 'SKIP_OVERLAP'))
  WHERE task_id = OLD.task_id;
  DELETE FROM task_run_stats WHERE task_id = OLD.task_id AND total = 0;
`;

export const RUN_LEDGER_STATS_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_run_stats (
  task_id TEXT PRIMARY KEY,
  total INTEGER NOT NULL CHECK (total >= 0),
  delivered INTEGER NOT NULL CHECK (delivered >= 0),
  failed INTEGER NOT NULL CHECK (failed >= 0),
  skipped INTEGER NOT NULL CHECK (skipped >= 0)
);

-- A rewound migration marker may leave an existing projection. Rebuild it
-- from canonical rows inside the surrounding transaction, without double counts.
DELETE FROM task_run_stats;
INSERT INTO task_run_stats (task_id, total, delivered, failed, skipped)
SELECT task_id, COUNT(*),
  SUM(outcome = 'RUN_DELIVERED'),
  SUM(outcome = 'RUN_FAILED'),
  SUM(outcome IN ('SKIP_NO_SIGNAL', 'SKIP_DISABLED', 'SKIP_OVERLAP'))
FROM task_run_ledger GROUP BY task_id;

CREATE TRIGGER IF NOT EXISTS task_run_stats_insert AFTER INSERT ON task_run_ledger
BEGIN
  ${addNewRun}
END;

CREATE TRIGGER IF NOT EXISTS task_run_stats_delete AFTER DELETE ON task_run_ledger
BEGIN
  ${removeOldRun}
END;

CREATE TRIGGER IF NOT EXISTS task_run_stats_update AFTER UPDATE OF task_id, outcome ON task_run_ledger
WHEN OLD.task_id IS NOT NEW.task_id OR OLD.outcome IS NOT NEW.outcome
BEGIN
  ${removeOldRun}
  ${addNewRun}
END;
`;
