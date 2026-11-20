import Database from 'better-sqlite3';

const db = new Database(process.argv[2]);
db.pragma('busy_timeout = 5000');
db.exec('BEGIN IMMEDIATE');
const lockedAt = Date.now();
let closed = false;
function release() {
  if (closed) return;
  closed = true;
  db.exec('ROLLBACK');
  db.close();
  if (process.connected) {
    process.send({ type: 'released', heldMs: Date.now() - lockedAt }, () => process.disconnect());
  }
}
process.once('disconnect', release);
process.send({ type: 'locked' });
setTimeout(release, 800);
