import Database from 'better-sqlite3';

const db = new Database(process.argv[2]);
db.exec('BEGIN EXCLUSIVE');
process.send?.('locked');
// This independent process releases its lock even when the API loop is blocked.
setTimeout(() => {
  db.exec('ROLLBACK');
  db.close();
  process.disconnect();
}, 700);
