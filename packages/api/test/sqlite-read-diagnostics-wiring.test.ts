import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SqliteEvidenceStore } from '../src/domains/memory/SqliteEvidenceStore.js';

test('standalone stores initialize twice with an unusable logger path and no console/filesystem side effects', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'sql-diagnostic-no-logger-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('../src/domains/memory/SqliteEvidenceStore.ts', import.meta.url));
  const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
  const script = `
    import { existsSync } from 'node:fs';
    const consoleBefore = console.log;
    const { SqliteEvidenceStore } = await import(${JSON.stringify(source)});
    for (let i = 0; i < 2; i++) {
      const store = new SqliteEvidenceStore(':memory:');
      await store.initialize();
      store.close();
    }
    process.stdout.write(JSON.stringify({ consoleChanged: console.log !== consoleBefore, logsCreated: existsSync('data/logs/api') }));
  `;
  const result = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', script], {
    cwd: scratch,
    env: { ...process.env, LOG_DIR: '/dev/null/blocked' },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { consoleChanged: false, logsCreated: false });
  assert(!existsSync(join(scratch, 'data/logs/api')));
});

test('diagnostic attachment failure cannot prevent store initialization or poison a later attempt', async () => {
  let attempts = 0;
  const store = new SqliteEvidenceStore(':memory:', undefined, {
    readDiagnostics: () => {
      attempts++;
      throw new Error('logger unavailable');
    },
  });
  try {
    await store.initialize();
    assert.deepEqual(store.getDb().prepare('SELECT 1 AS n').get(), { n: 1 });
    store.close();
    await store.initialize();
    assert.deepEqual(store.getDb().prepare('SELECT 2 AS n').get(), { n: 2 });
    assert.equal(attempts, 2);
  } finally {
    store.close();
  }
});

test('worker-mode store constructors ignore injected API observers; process-owner diagnostics are separate', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'sql-diagnostic-worker-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const path = join(scratch, 'evidence.sqlite');
  const setup = new SqliteEvidenceStore(path);
  await setup.initialize();
  setup.close();
  let attachments = 0;
  const worker = new SqliteEvidenceStore(path, undefined, {
    workerMode: 'read',
    readDiagnostics: () => {
      attachments++;
      return () => {};
    },
  });
  try {
    await worker.initialize();
    assert.equal(attachments, 0);
  } finally {
    worker.close();
  }
});

test('concurrent initialization of the same store attaches once and close detaches that observer', async () => {
  let attachments = 0;
  let detached = 0;
  const store = new SqliteEvidenceStore(':memory:', undefined, {
    readDiagnostics: () => {
      attachments++;
      return () => {
        detached++;
      };
    },
  });
  try {
    await Promise.all([store.initialize(), store.initialize(), store.initialize()]);
    assert.equal(attachments, 1);
    assert.deepEqual(store.getDb().prepare('SELECT 1 AS n').get(), { n: 1 });
    store.close();
    assert.equal(detached, 1);
    await store.initialize();
    assert.equal(attachments, 2);
  } finally {
    store.close();
  }
  assert.equal(detached, 2);
});

test('memory factory forwards the API observer only to the project connection', async (t) => {
  const { createMemoryServices } = await import('../src/domains/memory/factory.js');
  const scratch = mkdtempSync(join(tmpdir(), 'sql-diagnostic-factory-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const previousEventDb = process.env.EVENT_MEMORY_DB;
  process.env.EVENT_MEMORY_DB = ':memory:';
  t.after(() => {
    if (previousEventDb === undefined) delete process.env.EVENT_MEMORY_DB;
    else process.env.EVENT_MEMORY_DB = previousEventDb;
  });
  const attached: unknown[] = [];
  const services = await createMemoryServices({
    type: 'sqlite',
    sqlitePath: ':memory:',
    embed: { embedMode: 'off' },
    dataDir: scratch,
    docsRoot: join(scratch, 'docs'),
    markersDir: join(scratch, 'markers'),
    globalDbPath: join(scratch, 'global.sqlite'),
    skillsRoot: join(scratch, 'skills'),
    memoryRoot: join(scratch, 'memory'),
    privateUserId: 'diagnostic-fixture-owner',
    includeRosterEntitySeeds: false,
    readDiagnostics: (db) => {
      attached.push(db);
      return () => {};
    },
  });
  try {
    assert.deepEqual(attached, [services.store.getDb()]);
    assert(services.globalStore);
    assert(!attached.includes(services.globalStore.getDb()));
  } finally {
    for (const store of new Set([
      services.store,
      services.globalStore,
      ...(services.collectionStores?.values() ?? []),
    ])) {
      if (store instanceof SqliteEvidenceStore) store.close();
    }
  }
});
