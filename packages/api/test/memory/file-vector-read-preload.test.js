import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import * as vec from 'sqlite-vec';
import { prepareFileVectorReadWindow } from '../../dist/domains/memory/file-vector-read-window.js';
import { PassageVectorStore } from '../../dist/domains/memory/PassageVectorStore.js';
import { quarantineGenerationInvalidations } from '../../dist/domains/memory/vector-generation-invalidation.js';
import { buildMemoryReadWindow } from '../../scripts/build-memory-read-window.mjs';

const supported = process.platform === 'darwin';
const root = mkdtempSync(path.join(tmpdir(), 'memory-read-preload-'));
const source = path.join(root, 'source.sqlite'),
  library = path.join(root, 'test-preload.dylib');
const query = Float32Array.from({ length: 256 }, (_, i) => (i + 1) / 256);
let sequence = 0,
  expected;
const open = (file, readonly = true) => {
  const db = new Database(file, { readonly });
  vec.load(db);
  return db;
};
const search = (db, reader) => new PassageVectorStore(db, 256, reader).search(query, 2000);
const report = (db) => JSON.parse(db.prepare('SELECT memory_read_preload_test_stats() j').get().j);
const configure = (db, flags) => db.prepare('SELECT memory_read_preload_test_control(?,NULL,NULL)').get(flags);
function setup() {
  const file = path.join(root, `${++sequence}.sqlite`);
  copyFileSync(source, file);
  const db = open(file);
  db.loadExtension(library);
  const observations = [];
  return { db, file, observations, reader: prepareFileVectorReadWindow(db, library, (s) => observations.push(s)) };
}
before(() => {
  const db = open(source, false);
  db.pragma('journal_mode=WAL');
  db.exec('CREATE TABLE embedding_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec('CREATE VIRTUAL TABLE passage_vectors USING vec0(passage_key TEXT PRIMARY KEY, embedding float[256])');
  const vectors = new PassageVectorStore(db, 256);
  db.transaction(() => {
    for (let i = 0; i < 4096; i++)
      vectors.upsert(
        `neutral-${i}`,
        Float32Array.from(query, (v, j) => v + Math.sin(i * 13 + j * 7)),
      );
  })();
  expected = search(db);
  db.close();
  if (supported) assert.equal(buildMemoryReadWindow({ output: library, test: true }), true);
});
after(() => rmSync(root, { recursive: true, force: true }));

test('cold demand joins one optional reader before returning all ordered results', { skip: !supported }, () => {
  const { db, file, reader, observations } = setup();
  try {
    configure(db, 1); // Force the residency observation, not the I/O implementation.
    assert.deepEqual(search(db, reader), expected);
    const done = report(db);
    assert.equal(done.started, 1);
    assert.equal(done.joined, 1);
    assert.ok(done.bytes <= statSync(file).size);
    assert.equal(done.calls, Math.ceil(done.bytes / 4194304));
    assert.equal(done.borrowedFd, 0);
    assert.equal(done.error, 0);
    assert.equal(db.inTransaction, false);
    const observed = observations.at(-1).preload;
    assert.ok(observed, 'completed scope must publish its actual preload observation');
    assert.equal(observed.attempted, true);
    assert.equal(observed.started, true);
    assert.equal(observed.joined, true);
    assert.equal(observed.logicalBytes, done.bytes);
    assert.equal(observed.readCalls, Math.ceil(observed.logicalBytes / 4194304));
    assert.equal(observed.errorCode, 0);
    assert.ok(observations.filter((s) => s.cleanup === null).every((s) => s.preload === null));
    configure(db, 2); // Known-resident control: subsequent scopes do not inherit a thread.
    assert.deepEqual(search(db, reader), expected);
    assert.equal(report(db).started, 0);
    assert.equal(report(db).borrowedFd, 0);
    assert.deepEqual(observations.at(-1).preload, {
      attempted: false,
      started: false,
      joined: false,
      logicalBytes: 0,
      readCalls: 0,
      errorCode: 0,
    });
  } finally {
    db.close();
  }
});

test('optional allocation, launch, read and residency failures keep the SQL result', { skip: !supported }, () => {
  for (const flags of [1 | 8, 1 | 16, 1 | 32, 64]) {
    const { db, reader, observations } = setup();
    try {
      configure(db, flags);
      assert.deepEqual(search(db, reader), expected, `flags=${flags}`);
      const done = report(db);
      assert.equal(done.attempted, 1);
      assert.ok(done.error > 0);
      assert.equal(done.joined, done.started);
      assert.equal(done.borrowedFd, 0);
      assert.equal(db.inTransaction, false);
      const observed = observations.at(-1).preload;
      assert.ok(observed, 'failed optional preloads still have an ended observation');
      assert.equal(observed.attempted, true);
      assert.equal(observed.started, Boolean(done.started));
      assert.equal(observed.joined, observed.started);
      assert.equal(observed.errorCode, done.error);
      assert.equal(observed.logicalBytes, 0);
    } finally {
      db.close();
    }
  }
});

test('SQL failure and unclosed scopes still join and release the helper', { skip: !supported }, () => {
  const { db, reader, observations } = setup(),
    observer = setup().db;
  try {
    configure(db, 1);
    const failure = new Error('query failed after reading');
    assert.throws(
      () =>
        reader(() => {
          search(db);
          throw failure;
        }),
      (e) => e === failure,
    );
    assert.equal(report(db).joined, 1);
    assert.equal(report(db).borrowedFd, 0);
    assert.equal(observations.at(-1).preload?.joined, true);
    db.exec('BEGIN');
    db.prepare('SELECT memory_read_window_begin() FROM sqlite_schema LIMIT 1').get();
    search(db);
    assert.equal(
      JSON.parse(db.prepare('SELECT memory_read_window_snapshot() j').get().j).preload,
      null,
      'SQL has read, but this scope has no end observation yet',
    );
    db.close();
    assert.equal(report(observer).joined, 1);
    assert.equal(report(observer).borrowedFd, 0);
  } finally {
    if (db.open) db.close();
    observer.close();
  }
});

test('another connection cannot trigger or retarget the admitted file preload', { skip: !supported }, () => {
  const owner = setup(),
    other = setup();
  try {
    configure(owner.db, 1);
    other.db.pragma('cache_size=1');
    assert.deepEqual(
      owner.reader(() => {
        assert.deepEqual(search(other.db, other.reader), expected);
        assert.equal(report(owner.db).started, 0);
        return search(owner.db);
      }),
      expected,
    );
    assert.ok(report(owner.db).bytes <= statSync(owner.file).size);
    assert.equal(report(owner.db).started, 1);
    assert.equal(report(owner.db).borrowedFd, 0);
  } finally {
    owner.db.close();
    other.db.close();
  }
});

for (const scenario of ['result', 'error'])
  test(
    `SQL ${scenario} stops a between-read helper without waiting for the remaining file`,
    { skip: !supported, timeout: 10000 },
    async () => {
      const file = path.join(root, `stop-${scenario}.sqlite`),
        ready = `${file}.ready`,
        release = `${file}.release`;
      copyFileSync(source, file);
      const child = fork(
        new URL('../helpers/memory-read-preload-child.mjs', import.meta.url),
        [file, library, ready, release, '1', scenario],
        { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
      );
      let stderr = '';
      child.stderr.on('data', (b) => {
        stderr += b;
      });
      const messages = [];
      child.on('message', (m) => messages.push(m));
      const closed = once(child, 'close');
      try {
        const [code] = await closed;
        assert.equal(code, 0, stderr);
        assert.ok(existsSync(ready), 'helper must actually reach the controlled pause after its first read');
        assert.equal(existsSync(release), false, 'the parent never released the helper pause');
        const result = messages[0];
        assert.ok(result.elapsedMs < 2000, `query held ${result.elapsedMs}ms`);
        assert.equal(result.preload.joined, 1);
        assert.equal(result.preload.borrowedFd, 0);
        assert.ok(result.preload.bytes > 0 && result.preload.bytes < statSync(file).size);
        assert.equal(result.livePreload, null, 'live helper counters stay unknown before scope end');
        assert.deepEqual(
          result.readWindow.preload,
          {
            attempted: true,
            started: true,
            joined: true,
            logicalBytes: 4194304,
            readCalls: 1,
            errorCode: 0,
          },
          'controlled stop follows one real 4MiB backing read',
        );
        if (scenario === 'result') assert.deepEqual(result.rows, expected);
        else assert.equal(result.errorPreserved, true);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await closed;
        }
      }
    },
  );

for (const scenario of ['return', 'cancel', 'invalidate'])
  test(
    scenario === 'cancel'
      ? 'cancellation kills an active preload and releases its file handles'
      : scenario === 'invalidate'
        ? 'invalidation committed during preload prevents publishing the old vector result'
        : 'return waits for the active preload to finish',
    { skip: !supported, timeout: 10000 },
    async () => {
      const file = path.join(root, `child-${scenario}.sqlite`),
        ready = `${file}.ready`,
        release = `${file}.release`;
      copyFileSync(source, file);
      const child = fork(
        new URL('../helpers/memory-read-preload-child.mjs', import.meta.url),
        [file, library, ready, release],
        { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
      );
      let stderr = '';
      child.stderr.on('data', (b) => {
        stderr += b;
      });
      const messages = [];
      child.on('message', (m) => messages.push(m));
      const closed = once(child, 'close');
      try {
        const until = performance.now() + 4000;
        while (!existsSync(ready) && performance.now() < until && child.exitCode === null)
          await new Promise((r) => setTimeout(r, 5));
        assert.ok(existsSync(ready), `helper never reached actual read: ${stderr}`);
        assert.equal(messages.length, 0, 'result cannot escape while the helper owns resources');
        if (scenario === 'cancel') child.kill('SIGKILL');
        else {
          if (scenario === 'invalidate') {
            const writer = open(file, false);
            try {
              quarantineGenerationInvalidations(writer);
            } finally {
              writer.close();
            }
          }
          writeFileSync(release, 'go');
        }
        const [code, signal] = await closed;
        if (scenario === 'cancel') {
          assert.equal(signal, 'SIGKILL');
          assert.equal(messages.length, 0);
        } else {
          assert.equal(code, 0, stderr);
          assert.deepEqual(messages[0].rows, scenario === 'invalidate' ? [] : expected);
          assert.equal(messages[0].preload.joined, 1);
          assert.equal(messages[0].readWindow.preload?.joined, true);
        }
        const writer = open(file, false);
        try {
          writer.exec('BEGIN EXCLUSIVE');
          writer.exec('ROLLBACK');
        } finally {
          writer.close();
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await closed;
        }
      }
    },
  );

test('release artifact has no preload test controls', { skip: !supported }, () => {
  const db = open(source);
  try {
    assert.equal(typeof prepareFileVectorReadWindow(db), 'function');
    assert.throws(() => db.prepare('SELECT memory_read_preload_test_control(1,NULL,NULL)'), /no such function/);
  } finally {
    db.close();
  }
});
