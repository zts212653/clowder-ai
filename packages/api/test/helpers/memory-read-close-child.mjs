import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import * as vec from 'sqlite-vec';
import { prepareFileVectorReadWindow } from '../../dist/domains/memory/file-vector-read-window.js';
import { PassageVectorStore } from '../../dist/domains/memory/PassageVectorStore.js';

const [file, library, ready, release, closing, queryDone] = process.argv.slice(2);
const db = new Database(file, { readonly: true }),
  observer = new Database(':memory:');
vec.load(db);
db.loadExtension(library);
observer.loadExtension(library);
db.pragma('cache_size=1');
prepareFileVectorReadWindow(db, library);
db.prepare('SELECT memory_read_preload_test_control(257,?,?)').get(ready, release);
db.prepare('SELECT memory_read_preload_test_close_control(?)').get(closing);
db.exec('BEGIN');
db.prepare('SELECT memory_read_window_begin() FROM sqlite_schema LIMIT 1').get();
try {
  const query = Float32Array.from({ length: 32 }, (_, i) => (i + 1) / 32);
  const rows = new PassageVectorStore(db, 32).search(query, 16);
  writeFileSync(queryDone, 'query complete');
  const until = performance.now() + 2000;
  while (!existsSync(ready) && performance.now() < until) await new Promise((r) => setTimeout(r, 5));
  assert.ok(existsSync(ready), 'close test requires an actual in-flight helper');
  db.close();
  const stats = JSON.parse(observer.prepare('SELECT memory_read_preload_test_stats() j').get().j);
  console.log(JSON.stringify({ count: rows.length, stats }));
} finally {
  if (db.open) db.close();
  observer.close();
}
