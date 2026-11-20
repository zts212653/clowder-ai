import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { CURRENT_SCHEMA_VERSION } from '../../dist/domains/memory/schema.js';

test('file initialization yields while a real SQLite writer holds the migration lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sqlite-init-liveness-'));
  const dbPath = join(root, 'evidence.sqlite');
  const seed = new Database(dbPath);
  seed.pragma('journal_mode = WAL');
  seed.exec("CREATE TABLE initialization_witness (value TEXT); INSERT INTO initialization_witness VALUES ('kept')");
  seed.close();
  const holder = fork(new URL('../helpers/sqlite-initialization-lock.mjs', import.meta.url), [dbPath], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const closed = once(holder, 'close');
  const messages = [];
  holder.on('message', (message) => messages.push(message));
  const store = new SqliteEvidenceStore(dbPath);
  let timer;
  try {
    const [message] = await once(holder, 'message');
    assert.equal(message.type, 'locked');
    let ticks = 0;
    timer = setInterval(() => ticks++, 5);
    const first = store.initialize();
    assert.equal(store.initialize(), first, 'concurrent initialization shares one completion');
    await first;
    clearInterval(timer);
    assert.ok(ticks >= 5, `SQLite initialization starved the API heartbeat (${ticks} ticks)`);
    assert.equal(await store.health(), true);
    assert.equal(store.getDb().prepare('SELECT value FROM initialization_witness').get().value, 'kept');
    assert.equal(
      store.getDb().prepare('SELECT MAX(version) AS version FROM schema_version').get().version,
      CURRENT_SCHEMA_VERSION,
    );
    await closed;
    assert.ok(
      messages.find((entry) => entry.type === 'released')?.heldMs >= 500,
      'the external writer really held the lock',
    );
  } finally {
    clearInterval(timer);
    store.close();
    if (holder.exitCode === null && holder.signalCode === null) holder.kill();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});

test('a file initialized off the caller supports durable writes and a read-only child connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sqlite-init-state-'));
  const dbPath = join(root, 'evidence.sqlite');
  const store = new SqliteEvidenceStore(dbPath);
  const reader = new SqliteEvidenceStore(dbPath, undefined, { workerMode: 'read' });
  try {
    await store.initialize();
    await store.upsert([
      {
        anchor: 'doc:preserved',
        kind: 'feature',
        status: 'active',
        title: 'Preserved',
        updatedAt: '2026-11-17T00:00:00.000Z',
      },
    ]);
    await reader.initialize();
    assert.equal((await reader.getByAnchor('doc:preserved')).title, 'Preserved');
    assert.equal(reader.getDb().readonly, true);
    assert.throws(() => reader.getDb().prepare('DELETE FROM evidence_docs').run(), { code: 'SQLITE_READONLY' });
    reader.close();
    await store.upsert([
      {
        anchor: 'doc:later',
        kind: 'feature',
        status: 'active',
        title: 'Later write',
        updatedAt: '2026-11-17T00:00:01.000Z',
      },
    ]);
    assert.equal((await store.getByAnchor('doc:later')).title, 'Later write');
  } finally {
    reader.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed file open preserves its error and can be retried after the directory is created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sqlite-init-retry-'));
  const directory = join(root, 'missing');
  const store = new SqliteEvidenceStore(join(directory, 'evidence.sqlite'));
  try {
    await assert.rejects(
      store.initialize(),
      (error) => error instanceof Error && /directory does not exist|unable to open database/i.test(error.message),
    );
    await mkdir(directory);
    await store.initialize();
    assert.equal(await store.health(), true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('close cancels an in-flight schema child before a later initialize can open its connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sqlite-init-close-'));
  const dbPath = join(root, 'evidence.sqlite');
  const seed = new Database(dbPath);
  seed.pragma('journal_mode = WAL');
  seed.close();
  const holder = fork(new URL('../helpers/sqlite-initialization-lock.mjs', import.meta.url), [dbPath], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const holderClosed = once(holder, 'close');
  const store = new SqliteEvidenceStore(dbPath);
  const events = channel('cat-cafe.memory-process');
  let observe;
  const started = new Promise((resolve) => {
    observe = (event) => {
      if (event.kind === 'schema-initialize') resolve(event.pid);
    };
    events.subscribe(observe);
  });
  try {
    const [message] = await once(holder, 'message');
    assert.equal(message.type, 'locked');
    const initializing = store.initialize();
    const rejected = assert.rejects(initializing, /closed during initialization/);
    const schemaPid = await started;
    assert.notEqual(schemaPid, process.pid);
    store.close();
    await rejected;
    assert.equal(await store.health(), false, 'a late completion must not reopen the closed store');
    assert.throws(() => process.kill(schemaPid, 0), { code: 'ESRCH' }, 'cancellation settles after the child exits');
    await holderClosed;
    await store.initialize();
    assert.equal(await store.health(), true, 'the existing close/reinitialize contract remains usable');
  } finally {
    events.unsubscribe(observe);
    store.close();
    if (holder.exitCode === null && holder.signalCode === null) holder.kill();
    await holderClosed;
    await rm(root, { recursive: true, force: true });
  }
});

test('schema errors retain SQLite metadata and do not poison a corrected retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sqlite-init-schema-error-'));
  const dbPath = join(root, 'evidence.sqlite');
  const seed = new Database(dbPath);
  seed.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');
  seed.close();
  const store = new SqliteEvidenceStore(dbPath);
  try {
    await assert.rejects(store.initialize(), { name: 'SqliteError', code: 'SQLITE_ERROR' });
    const repair = new Database(dbPath);
    repair.exec('ALTER TABLE schema_version ADD COLUMN applied_at TEXT');
    repair.close();
    await store.initialize();
    assert.equal(await store.health(), true);
    assert.equal(
      store.getDb().prepare('SELECT MAX(version) AS version FROM schema_version').get().version,
      CURRENT_SCHEMA_VERSION,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
