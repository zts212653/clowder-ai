import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import * as vec from 'sqlite-vec';
import { prepareFileVectorReadWindow } from '../../dist/domains/memory/file-vector-read-window.js';
import { PassageVectorStore } from '../../dist/domains/memory/PassageVectorStore.js';
import { buildMemoryReadWindow } from '../../scripts/build-memory-read-window.mjs';

const supported = process.platform === 'darwin';
const root = mkdtempSync(path.join(tmpdir(), 'memory-read-window-'));
const source = path.join(root, 'source.sqlite');
const library = path.join(root, 'test-window.dylib');
let sequence = 0;
const query = Float32Array.from({ length: 32 }, (_, i) => (i + 1) / 32);
const input = (i) => Float32Array.from({ length: 32 }, (_, j) => Math.sin(i * 13 + j * 7));
const open = (file, readonly = true) => {
  const db = new Database(file, { readonly });
  vec.load(db);
  return db;
};
const copy = () => {
  const file = path.join(root, `${++sequence}.sqlite`);
  copyFileSync(source, file);
  return file;
};
function setup(file = copy()) {
  const db = open(file);
  db.loadExtension(library);
  db.prepare('SELECT memory_read_window_test_control(0,0,NULL,NULL,0)').get();
  return db;
}
const stats = (db) => JSON.parse(db.prepare('SELECT memory_read_window_test_stats() AS j').get().j);
const search = (db, reader) => new PassageVectorStore(db, 32, reader).search(query, 2000);

before(() => {
  const db = open(source, false);
  db.pragma('journal_mode=WAL');
  db.exec('CREATE VIRTUAL TABLE passage_vectors USING vec0(passage_key TEXT PRIMARY KEY, embedding float[32])');
  const vectors = new PassageVectorStore(db, 32);
  db.transaction(() => {
    for (let i = 0; i < 4096; i++) vectors.upsert(`neutral-${i}`, input(i));
  })();
  db.close();
  if (supported) assert.equal(buildMemoryReadWindow({ output: library, test: true }), true);
});
after(() => rmSync(root, { recursive: true, force: true }));

test('the shipped artifact reduces backing reads through the compiled consumer', { skip: !supported }, async () => {
  const { PassageVectorStore: BuiltStore } = await import('../../dist/domains/memory/PassageVectorStore.js');
  const { prepareFileVectorReadWindow: builtReader } = await import(
    '../../dist/domains/memory/file-vector-read-window.js'
  );
  const original = setup();
  original.prepare('SELECT memory_read_window_test_probe_begin()').get();
  const expected = new BuiltStore(original, 32).search(query, 2000);
  const baselineReads = original.prepare('SELECT memory_read_window_test_probe_end() AS n').get().n;
  original.close();
  const db = setup();
  try {
    db.prepare('SELECT memory_read_window_test_probe_begin()').get();
    const reader = builtReader(db);
    assert.equal(typeof reader, 'function', 'release artifact must load at its shipped path');
    assert.deepEqual(new BuiltStore(db, 32, reader).search(query, 2000), expected);
    const backingReads = db.prepare('SELECT memory_read_window_test_probe_end() AS n').get().n;
    assert.ok(baselineReads > 0);
    assert.ok(backingReads < baselineReads / 2, `${backingReads} versus ${baselineReads} backing reads`);
  } finally {
    db.close();
  }
});

test(
  'uses bounded mappings through the real passage query and releases them before returning',
  { skip: !supported },
  () => {
    const baseline = setup();
    const expected = search(baseline);
    baseline.close();
    const db = setup();
    try {
      const result = search(db, prepareFileVectorReadWindow(db, library));
      assert.deepEqual(result, expected);
      assert.equal(result.length, 2000);
      assert.ok(stats(db).mappedReads > 0, 'file read worker must use the bounded native backend');
      assert.equal(stats(db).active, 0);
      assert.equal(stats(db).liveMappingBytes, 0);
      assert.equal(db.inTransaction, false);
    } finally {
      db.close();
    }
  },
);

test('writers and missing accelerators keep the original native result', () => {
  const db = open(copy(), false);
  try {
    assert.equal(prepareFileVectorReadWindow(db, library), undefined);
    assert.equal(search(db).length, 2000);
  } finally {
    db.close();
  }
  const reader = open(copy());
  try {
    assert.equal(prepareFileVectorReadWindow(reader, path.join(root, 'absent.dylib')), undefined);
    assert.equal(search(reader).length, 2000);
  } finally {
    reader.close();
  }
});

test('mapping failure and the mapping-call limit keep complete ordered results', { skip: !supported }, () => {
  const base = setup();
  const expected = search(base);
  base.close();
  for (const [fail, limit] of [
    [1, 0],
    [0, 3],
  ]) {
    const db = setup();
    try {
      const reader = prepareFileVectorReadWindow(db, library);
      db.prepare('SELECT memory_read_window_test_control(?,0,NULL,NULL,?)').get(fail, limit);
      assert.deepEqual(search(db, reader), expected);
      const observed = stats(db);
      assert.equal(observed.active, 0);
      assert.equal(observed.liveMappingBytes, 0);
      assert.ok(observed.preadCalls > 0);
      assert.ok(fail ? observed.mapFailures === 1 : observed.mapCalls <= 3);
    } finally {
      db.close();
    }
  }
});

test(
  'read snapshot survives a concurrent WAL commit and the next query sees the new vector',
  { skip: !supported },
  () => {
    const file = copy(),
      db = setup(file),
      writer = open(file, false);
    const reader = prepareFileVectorReadWindow(db, library);
    try {
      const before = search(db, reader);
      db.exec('BEGIN');
      const held = search(db, reader);
      writer.prepare('UPDATE passage_vectors SET embedding=? WHERE passage_key=?').run(query, 'neutral-0');
      writer.pragma('wal_checkpoint(PASSIVE)');
      assert.deepEqual(search(db, reader), held);
      db.exec('COMMIT');
      const after = search(db, reader);
      assert.notDeepEqual(after, before);
      assert.equal(after[0].passageKey, 'neutral-0');
      assert.equal(after[0].distance, 0);
      assert.equal(stats(db).liveMappingBytes, 0);
    } finally {
      if (db.inTransaction) db.exec('ROLLBACK');
      writer.close();
      db.close();
    }
  },
);

test('scope cleanup preserves the original thrown object', { skip: !supported }, () => {
  const db = setup();
  const reader = prepareFileVectorReadWindow(db, library);
  const original = new Error('original native consumer failure');
  try {
    assert.throws(
      () =>
        reader(() => {
          search(db);
          throw original;
        }),
      (error) => error === original,
    );
    assert.equal(stats(db).active, 0);
    assert.equal(stats(db).liveMappingBytes, 0);
    assert.equal(db.inTransaction, false);
  } finally {
    db.close();
  }
});

test('an unsuccessful unmap retains one bounded window and cannot publish a result', { skip: !supported }, () => {
  const db = setup(),
    observer = setup(),
    reader = prepareFileVectorReadWindow(db, library);
  try {
    db.prepare('SELECT memory_read_window_test_control(2,0,NULL,NULL,0)').get();
    assert.throws(() => search(db, reader), /read-window cleanup failed/);
    assert.equal(db.open, false);
    assert.equal(stats(observer).active, 0);
    assert.ok(stats(observer).liveMappingBytes > 0);
    assert.ok(stats(observer).liveMappingBytes <= 65536);
    observer.prepare('SELECT memory_read_window_test_control(0,0,NULL,NULL,0)').get();
    assert.equal(search(observer, prepareFileVectorReadWindow(observer, library)).length, 2000);
    assert.equal(stats(observer).liveMappingBytes, 0);
  } finally {
    if (db.open) db.close();
    observer.close();
  }
});

test('connection close releases a scope even when the caller did not end it', { skip: !supported }, () => {
  const owner = setup(),
    observer = setup();
  try {
    owner.exec('BEGIN');
    owner.prepare('SELECT memory_read_window_begin() FROM sqlite_schema LIMIT 1').get();
    search(owner);
    assert.ok(stats(observer).liveMappingBytes > 0);
    owner.close();
    assert.equal(stats(observer).active, 0);
    assert.equal(stats(observer).liveMappingBytes, 0);
  } finally {
    if (owner.open) owner.close();
    observer.close();
  }
});

test('cleanup failure stops reuse and does not replace an existing query error', { skip: !supported }, () => {
  for (const failQuery of [false, true]) {
    const db = setup(),
      reader = prepareFileVectorReadWindow(db, library);
    const original = new Error('original query'),
      cleanup = new Error('failed scope cleanup');
    const expected = failQuery ? original : cleanup;
    assert.throws(
      () =>
        reader(() => {
          search(db);
          db.function('memory_read_window_end', () => {
            throw cleanup;
          });
          if (failQuery) throw original;
          return [];
        }),
      (error) => error === expected,
    );
    assert.equal(db.open, false);
  }
});

test('the production artifact exposes no test-control functions', { skip: !supported }, () => {
  const db = open(copy());
  try {
    assert.equal(typeof prepareFileVectorReadWindow(db), 'function');
    assert.throws(() => db.prepare('SELECT memory_read_window_test_control(0,0,NULL,NULL,0)'), /no such function/);
  } finally {
    db.close();
  }
});

async function mappedChild() {
  const file = copy(),
    ready = path.join(root, `ready-${sequence}`),
    release = path.join(root, `release-${sequence}`);
  const child = fork(
    new URL('../helpers/memory-read-window-child.mjs', import.meta.url),
    [file, library, ready, release],
    {
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  child.stdout.resume();
  child.stderr.resume();
  const messages = [];
  child.on('message', (message) => messages.push(message));
  const closed = once(child, 'close');
  const until = performance.now() + 3000;
  while (!existsSync(ready) && performance.now() < until && child.exitCode === null && child.signalCode === null)
    await new Promise((resolve) => setTimeout(resolve, 5));
  if (!existsSync(ready)) {
    child.kill('SIGKILL');
    await closed;
    assert.fail('no actual mapped-read checkpoint');
  }
  return { child, closed, messages, file, release };
}

test(
  'a mapped I/O fault exits only the owned child and publishes no result',
  { skip: !supported, timeout: 10000 },
  async () => {
    const { child, closed, messages, file, release } = await mappedChild();
    truncateSync(file, 0);
    writeFileSync(release, 'go');
    const [code, signal] = await closed;
    assert.equal(code, null);
    assert.equal(signal, 'SIGBUS');
    assert.equal(
      messages.some((message) => message.type === 'result'),
      false,
    );
    assert.equal(child.connected, false);
  },
);

test(
  'cancellation at the mapped-read checkpoint releases the process and SQLite locks',
  { skip: !supported, timeout: 10000 },
  async () => {
    const { child, closed, messages, file } = await mappedChild();
    child.kill('SIGKILL');
    const [, signal] = await closed;
    assert.equal(signal, 'SIGKILL');
    assert.equal(
      messages.some((message) => message.type === 'result'),
      false,
    );
    const db = open(file, false);
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  },
);
