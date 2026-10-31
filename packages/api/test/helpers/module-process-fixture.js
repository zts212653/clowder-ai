import { writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';

export function identity() {
  return { pid: process.pid };
}
export function nativeBusy(input) {
  const db = new Database(':memory:');
  try {
    writeFileSync(input.startedPath, String(process.pid));
    return db
      .prepare(
        'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 1000000000) SELECT sum(x) FROM n',
      )
      .get();
  } finally {
    db.close();
  }
}
export function cpuBusy(input) {
  writeFileSync(input.startedPath, String(process.pid));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    /* deliberate CPU work until the child is killed */
  }
  return { pid: process.pid };
}
