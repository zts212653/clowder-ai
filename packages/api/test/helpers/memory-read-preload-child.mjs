import Database from 'better-sqlite3';
import * as vec from 'sqlite-vec';
import { prepareFileVectorReadWindow } from '../../dist/domains/memory/file-vector-read-window.js';
import { PassageVectorStore } from '../../dist/domains/memory/PassageVectorStore.js';

const [file, library, ready, release, flags = '257', scenario] = process.argv.slice(2);
const db = new Database(file, { readonly: true });
vec.load(db);
const observations = [];
const reader = prepareFileVectorReadWindow(db, library, (s) => observations.push(s));
db.prepare('SELECT memory_read_preload_test_control(?,?,?)').get(Number(flags), ready, release);
try {
  const query = Float32Array.from({ length: 256 }, (_, i) => (i + 1) / 256);
  const start = performance.now();
  let rows = [],
    errorPreserved = false,
    livePreload;
  if (scenario === 'error' || scenario === 'result') {
    const failure = new Error('query failed after native SQL');
    try {
      rows = reader(() => {
        const result = new PassageVectorStore(db, 256).search(query, 2000);
        const until = performance.now() + 1000;
        while (!existsSync(ready) && performance.now() < until)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        if (!existsSync(ready)) throw new Error('helper did not reach its live checkpoint');
        livePreload = JSON.parse(db.prepare('SELECT memory_read_window_snapshot() j').get().j).preload;
        if (scenario === 'error') throw failure;
        return result;
      });
    } catch (error) {
      if (error !== failure) throw error;
      errorPreserved = true;
    }
  } else rows = new PassageVectorStore(db, 256, reader).search(query, 2000);
  const elapsedMs = performance.now() - start;
  const preload = JSON.parse(db.prepare('SELECT memory_read_preload_test_stats() j').get().j);
  await new Promise((resolve, reject) =>
    process.send({ rows, preload, readWindow: observations.at(-1), livePreload, elapsedMs, errorPreserved }, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
} finally {
  db.close();
  process.disconnect();
}

import { existsSync } from 'node:fs';
