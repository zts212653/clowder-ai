import { writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const db = new Database(process.argv[2]);
db.exec('BEGIN EXCLUSIVE');
process.send?.('locked');
// This independent process releases its lock even when the API loop is blocked.
setTimeout(
  () => {
    // Optional witness is written by this independent process before releasing the lock.
    if (process.argv[4]) writeFileSync(process.argv[4], 'released');
    db.exec('ROLLBACK');
    db.close();
    process.disconnect();
  },
  Number(process.argv[3] ?? 700),
);
