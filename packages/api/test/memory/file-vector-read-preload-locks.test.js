import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as vec from 'sqlite-vec';
import { prepareFileVectorReadWindow } from '../../dist/domains/memory/file-vector-read-window.js';
import { PassageVectorStore } from '../../dist/domains/memory/PassageVectorStore.js';
import { buildMemoryReadWindow } from '../../scripts/build-memory-read-window.mjs';

const supported = process.platform === 'darwin';
const root = mkdtempSync(path.join(tmpdir(), 'preload-locks-')),
  library = path.join(root, 'test.dylib');
const query = Float32Array.from({ length: 32 }, (_, i) => (i + 1) / 32);
let sequence = 0;
before(() => {
  if (supported) assert.equal(buildMemoryReadWindow({ output: library, test: true }), true);
});
after(() => rmSync(root, { recursive: true, force: true }));
function fixture(journal) {
  const file = path.join(root, `${++sequence}.sqlite`),
    db = new Database(file);
  vec.load(db);
  db.pragma(`journal_mode=${journal}`);
  db.exec('CREATE TABLE embedding_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec("CREATE TABLE lock_probe (value TEXT); INSERT INTO lock_probe VALUES ('original')");
  db.exec('CREATE VIRTUAL TABLE passage_vectors USING vec0(passage_key TEXT PRIMARY KEY, embedding float[32])');
  const vectors = new PassageVectorStore(db, 32);
  db.transaction(() => {
    for (let i = 0; i < 4096; i++) vectors.upsert(`key-${i}`, query);
  })();
  db.close();
  return file;
}
function probe(file, write = false) {
  const p = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../helpers/memory-read-lock-probe.mjs', import.meta.url)),
      file,
      library,
      write ? 'write' : '',
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(p.status, 0, p.stderr);
  return JSON.parse(p.stdout);
}

for (const journal of ['DELETE', 'WAL'])
  for (const flags of [2, 1, 17])
    test(
      `${journal}: preload flags ${flags} retain the external lock through the read transaction`,
      { skip: !supported },
      () => {
        const file = fixture(journal),
          db = new Database(file, { readonly: true });
        vec.load(db);
        db.loadExtension(library);
        db.pragma('cache_size=1');
        db.prepare('SELECT memory_read_preload_test_control(?,NULL,NULL)').get(flags);
        const reader = prepareFileVectorReadWindow(db, library);
        try {
          db.exec('BEGIN');
          db.prepare('SELECT count(*) FROM sqlite_schema').get();
          assert.deepEqual(
            probe(file, journal === 'DELETE'),
            journal === 'DELETE' ? { lock: 'busy', writer: 'busy' } : { lock: 'busy' },
          );
          assert.equal(new PassageVectorStore(db, 32, reader).search(query, 16).length, 16);
          assert.equal(db.inTransaction, true);
          assert.deepEqual(
            probe(file, journal === 'DELETE'),
            journal === 'DELETE' ? { lock: 'busy', writer: 'busy' } : { lock: 'busy' },
          );
          db.exec('COMMIT');
          // WAL holds its main-file shared lock until connection close; DELETE releases at COMMIT.
          assert.equal(probe(file).lock, journal === 'DELETE' ? 'free' : 'busy');
        } finally {
          db.close();
        }
        assert.deepEqual(
          probe(file, journal === 'DELETE'),
          journal === 'DELETE' ? { lock: 'free', writer: 'committed' } : { lock: 'free' },
        );
      },
    );

test('launch failure cannot unlock a SELECT that is still reading', { skip: !supported, timeout: 15000 }, async () => {
  const file = fixture('DELETE'),
    ready = `${file}.ready`,
    release = `${file}.release`;
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../helpers/memory-read-lock-child.mjs', import.meta.url)),
      file,
      library,
      ready,
      release,
      '17',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b) => {
    stdout += b;
  });
  child.stderr.on('data', (b) => {
    stderr += b;
  });
  const closed = once(child, 'close');
  try {
    const until = performance.now() + 4000;
    while (!existsSync(ready) && child.exitCode === null && performance.now() < until)
      await new Promise((r) => setTimeout(r, 5));
    assert.ok(existsSync(ready), stderr);
    assert.deepEqual(probe(file, true), { lock: 'busy', writer: 'busy' });
    assert.equal(stdout, '', 'SELECT must still be at its actual read checkpoint');
    writeFileSync(release, 'go');
    const [code] = await closed;
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).count, 16);
    assert.deepEqual(probe(file, true), { lock: 'free', writer: 'committed' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await closed;
    }
  }
});

test(
  'closing an unfinished scope joins active I/O before SQLite unlocks or closes its file',
  { skip: !supported, timeout: 15000 },
  async () => {
    const file = fixture('DELETE'),
      ready = `${file}.io`,
      release = `${file}.release`,
      closing = `${file}.closing`,
      queryDone = `${file}.done`;
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../helpers/memory-read-close-child.mjs', import.meta.url)),
        file,
        library,
        ready,
        release,
        closing,
        queryDone,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b;
    });
    child.stderr.on('data', (b) => {
      stderr += b;
    });
    const closed = once(child, 'close');
    try {
      const until = performance.now() + 4000;
      while ((!existsSync(ready) || !existsSync(closing)) && child.exitCode === null && performance.now() < until)
        await new Promise((r) => setTimeout(r, 5));
      assert.ok(existsSync(ready) && existsSync(closing) && existsSync(queryDone), stderr);
      assert.deepEqual(probe(file, true), { lock: 'busy', writer: 'busy' });
      assert.equal(stdout, '', 'close must still be waiting for the active read');
      writeFileSync(release, 'go');
      const [code] = await closed;
      assert.equal(code, 0, stderr);
      const result = JSON.parse(stdout);
      assert.equal(result.count, 16);
      assert.equal(result.stats.joined, 1);
      assert.ok(result.stats.calls > 0, 'the already-entered read must actually finish on the borrowed fd');
      assert.equal(result.stats.error, 0, 'SQLite must not close or reuse the fd before that read returns');
      assert.equal(result.stats.borrowedFd, 0);
      assert.deepEqual(probe(file, true), { lock: 'free', writer: 'committed' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await closed;
      }
    }
  },
);
