import { chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Hook processes share a transaction owner, never a whole-file read/modify/write. */
export function withAgyCommandLedger(profileHome, operation) {
  if (typeof profileHome !== 'string' || !profileHome) return undefined;
  const config = join(profileHome, '.gemini/config');
  const directory = lstatSync(config, { throwIfNoEntry: false });
  if (!directory) return undefined;
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('invalid AGY ledger directory');
  const path = join(config, '.cat-cafe-command-ledger.sqlite');
  const previous = lstatSync(path, { throwIfNoEntry: false });
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1))
    throw new Error('invalid AGY ledger file');
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    db.exec(
      'PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS approved_commands (id INTEGER PRIMARY KEY, command_json TEXT NOT NULL, task_id TEXT)',
    );
    db.exec('BEGIN IMMEDIATE');
    const result = operation({
      entries: () =>
        db
          .prepare('SELECT id, command_json, task_id FROM approved_commands ORDER BY id')
          .all()
          .map((row) => ({ ...JSON.parse(row.command_json), ledgerId: row.id, taskId: row.task_id })),
      append: (entry) => {
        db.prepare('INSERT INTO approved_commands(command_json) VALUES (?)').run(JSON.stringify(entry));
        db.exec(
          'DELETE FROM approved_commands WHERE id NOT IN (SELECT id FROM approved_commands ORDER BY id DESC LIMIT 256)',
        );
      },
      saveBindings: (entries) => {
        const update = db.prepare('UPDATE approved_commands SET task_id=? WHERE id=?');
        for (const entry of entries) update.run(entry.taskId, entry.ledgerId);
      },
    });
    db.exec('COMMIT');
    return result;
  } finally {
    // Closing an exceptional transaction rolls it back and releases the writer lock.
    db.close();
  }
}
