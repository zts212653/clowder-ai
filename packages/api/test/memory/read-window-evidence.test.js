import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import * as vec from 'sqlite-vec';
import { prepareFileVectorReadWindow } from '../../dist/domains/memory/file-vector-read-window.js';
import {
  decodeReadWindowNativeSnapshot,
  safeFileVectorReadWindowSnapshot,
} from '../../dist/domains/memory/file-vector-read-window-diagnostics.js';
import { safeMessageReadProgress } from '../../dist/domains/memory/message-search-lifetime.js';
import { PassageVectorStore } from '../../dist/domains/memory/PassageVectorStore.js';
import { buildMemoryReadWindow } from '../../scripts/build-memory-read-window.mjs';

const supported = process.platform === 'darwin';
const root = mkdtempSync(join(tmpdir(), 'read-window-evidence-'));
const source = join(root, 'source.sqlite');
const library = join(root, 'test-window.dylib');
let sequence = 0;
const query = new Float32Array([1, 0, 0, 0]);

before(() => {
  const db = new Database(source);
  try {
    vec.load(db);
    db.exec('CREATE TABLE embedding_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.exec('CREATE VIRTUAL TABLE passage_vectors USING vec0(passage_key TEXT PRIMARY KEY, embedding float[4])');
    const store = new PassageVectorStore(db, 4);
    db.transaction(() => {
      for (let i = 0; i < 4096; i++) store.upsert(`row-${i}`, new Float32Array([i, 1, 0, 0]));
    })();
  } finally {
    db.close();
  }
  if (supported) buildMemoryReadWindow({ output: library, test: true });
});
after(() => rmSync(root, { recursive: true, force: true }));

function open() {
  const file = join(root, `${++sequence}.sqlite`);
  copyFileSync(source, file);
  const db = new Database(file, { readonly: true });
  vec.load(db);
  return db;
}

for (const [failure, limit, fallback] of [
  [0, 0, 'none'],
  [1, 0, 'map_failed'],
  [0, 1, 'map_limit'],
]) {
  test(`same-query scalar counters preserve results (${fallback})`, { skip: !supported }, () => {
    const db = open();
    const observations = [];
    try {
      const expected = new PassageVectorStore(db, 4).search(query, 2000);
      const read = prepareFileVectorReadWindow(db, library, (s) => observations.push(s));
      db.prepare('SELECT memory_read_window_test_control(?,0,NULL,NULL,?)').get(failure, limit);
      db.pragma('cache_size=1');
      let backingReads;
      const countedRead = (run) =>
        read(() => {
          db.prepare('SELECT memory_read_window_test_probe_begin()').get();
          try {
            return run();
          } finally {
            backingReads = db.prepare('SELECT memory_read_window_test_probe_end() AS n').get().n;
          }
        });
      assert.deepEqual(new PassageVectorStore(db, 4, countedRead).search(query, 2000), expected);
      const snapshot = observations.at(-1);
      assert.ok(snapshot, 'same-request window evidence missing');
      const independent = JSON.parse(db.prepare('SELECT memory_read_window_test_stats() AS j').get().j);
      assert.equal(snapshot.prepared, true);
      assert.equal(snapshot.active, true);
      assert.equal(snapshot.cleanup, true);
      assert.equal(snapshot.counters.mapCalls, independent.mapCalls);
      assert.equal(snapshot.counters.mappedReads, independent.mappedReads);
      assert.equal(snapshot.counters.mainPreadCalls, backingReads, 'independent backing-call probe');
      assert.equal(snapshot.counters.firstFallback, fallback);
      assert.ok(snapshot.counters.mapCalls > 0);
      assert.equal(db.inTransaction, false);
      assert.ok(JSON.stringify(snapshot).length < 512);
    } finally {
      db.close();
    }
  });
}

test('unavailable setup records a fixed reason without its path or replacing reads', { skip: !supported }, () => {
  const db = open();
  const observations = [];
  try {
    const reader = prepareFileVectorReadWindow(db, join(root, 'private-path-canary.dylib'), (s) =>
      observations.push(s),
    );
    assert.equal(reader, undefined);
    assert.equal(new PassageVectorStore(db, 4).search(query, 1).length, 1);
    assert.equal(observations.at(-1)?.reason, 'extension_unavailable');
    assert.equal(observations.at(-1)?.active, null);
    assert.equal(observations.at(-1)?.counters, null);
    assert.doesNotMatch(JSON.stringify(observations), /private-path|sqlite|dylib|row-/);
  } finally {
    db.close();
  }
});

test('diagnostic callbacks cannot replace a query result or its original error', { skip: !supported }, () => {
  const db = open();
  try {
    const read = prepareFileVectorReadWindow(db, library, () => {
      throw new Error('diagnostic consumer');
    });
    assert.equal(new PassageVectorStore(db, 4, read).search(query, 1).length, 1);
    const original = new Error('original native failure');
    assert.throws(
      () =>
        read(() => {
          throw original;
        }),
      (error) => error === original,
    );
    assert.equal(db.inTransaction, false);
  } finally {
    db.close();
  }
});

test('unverified backing descriptors remain non-main, including a live journal', { skip: !supported }, () => {
  const db = open();
  const writer = new Database(db.name);
  const observations = [];
  try {
    vec.load(writer);
    writer.pragma('journal_mode=WAL');
    writer.pragma('wal_autocheckpoint=0');
    writer.prepare('UPDATE passage_vectors SET embedding=? WHERE passage_key=?').run(query, 'row-0');
    const expected = new PassageVectorStore(db, 4).search(query, 2000);
    db.pragma('cache_size=1');
    const reader = prepareFileVectorReadWindow(db, library, (s) => observations.push(s));
    assert.deepEqual(new PassageVectorStore(db, 4, reader).search(query, 2000), expected);
    const final = observations.at(-1);
    assert.ok(final.counters.nonMainPreadCalls > 0);
    assert.doesNotMatch(JSON.stringify(final), /WAL|wal|journal|sqlite|row-/);
  } finally {
    writer.close();
    db.close();
  }
});

test('a declined connection cannot consume another scope counts or poison its reason', { skip: !supported }, () => {
  const owner = open(),
    other = open();
  const ownerFrames = [],
    otherFrames = [];
  try {
    const read = prepareFileVectorReadWindow(owner, library, (s) => ownerFrames.push(s));
    const otherRead = prepareFileVectorReadWindow(other, library, (s) => otherFrames.push(s));
    read(() => {
      assert.equal(otherRead(() => new PassageVectorStore(other, 4).search(query, 1)).length, 1);
      assert.equal(otherFrames.at(-1).reason, 'scope_busy');
      assert.equal(otherFrames.at(-1).active, false);
      assert.equal(otherFrames.at(-1).counters, null);
      assert.equal(otherFrames.at(-1).preload, null);
      return new PassageVectorStore(owner, 4).search(query, 1);
    });
    assert.equal(ownerFrames.at(-1).reason, 'active');
    assert.equal(ownerFrames.at(-1).cleanup, true);
    assert.equal(other.prepare('SELECT memory_read_window_snapshot() AS j').get().j, null);
  } finally {
    owner.close();
    other.close();
  }
});

test('preload progress distinguishes a completed non-start from missing or unfinished evidence', () => {
  const window = { prepared: true, active: true, reason: 'active', counters: null, cleanup: true };
  const noStart = { attempted: false, started: false, joined: false, logicalBytes: 0, readCalls: 0, errorCode: 0 };
  assert.equal(safeFileVectorReadWindowSnapshot(window).preload, null, 'legacy missing field is unknown');
  assert.deepEqual(safeFileVectorReadWindowSnapshot({ ...window, preload: noStart }).preload, noStart);
  const completed = { attempted: true, started: true, joined: true, logicalBytes: 4194304, readCalls: 1, errorCode: 0 };
  const large = { ...completed, logicalBytes: 5083238400, readCalls: 1212 };
  const decoded = decodeReadWindowNativeSnapshot(
    JSON.stringify({
      reason: 0,
      maps: 1,
      mapped: 1,
      main: 0,
      nonMain: 0,
      fallback: 0,
      preload: large,
    }),
  );
  assert.deepEqual(
    safeFileVectorReadWindowSnapshot({ ...window, ...decoded }).preload,
    large,
    'logical byte counts larger than 4GiB survive native decoding and private IPC projection',
  );
  for (const cleanup of [null, undefined])
    assert.equal(
      safeFileVectorReadWindowSnapshot({ ...window, cleanup: cleanup ?? null, preload: completed }).preload,
      null,
    );
  assert.equal(safeFileVectorReadWindowSnapshot({ ...window, active: false, preload: completed }).preload, null);
  assert.equal(safeFileVectorReadWindowSnapshot({ ...window, preload: { ...completed, joined: false } }).preload, null);
  for (const invalid of [
    { ...completed, logicalBytes: Infinity },
    { ...completed, logicalBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...completed, readCalls: -1 },
    { ...completed, errorCode: 'private-canary' },
  ])
    assert.equal(safeFileVectorReadWindowSnapshot({ ...window, preload: invalid }).preload, null);
  const value = safeMessageReadProgress({
    stage: 'retrieval',
    state: 'fulfilled',
    elapsedMs: 2,
    native: {
      phase: 'worker-processing',
      outcome: 'fulfilled',
      elapsedMs: 1,
      readWindow: { ...window, preload: { ...completed, privatePath: 'private-canary' } },
    },
  });
  assert.deepEqual(
    value.native.readWindow.preload,
    completed,
    'the existing private progress projection carries the counters',
  );
  completed.logicalBytes = 1;
  assert.equal(
    value.native.readWindow.preload.logicalBytes,
    4194304,
    'projection does not retain mutable producer state',
  );
  assert.doesNotMatch(JSON.stringify(value), /private-canary|privatePath/);
});
