import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { installV41CueLedgerFixture } from '../helpers/v41-memory-cue-ledger-fixture.js';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function consumption(overrides = {}) {
  return {
    eventId: 'event-1',
    idempotencyKey: 'idempotency-1',
    cueId: 'cue-1',
    opportunityId: 'opportunity-1',
    scope: {
      ownerUserId: 'owner-1',
      threadId: 'thread-1',
      invocationId: 'invocation-1',
    },
    resolverFamily: 'person_entity',
    sourceAnchor: 'person:alden',
    sourceRevision: 'revision-1',
    axis: 'consumption',
    consumptionOutcome: 'presented',
    catalogVersion: 1,
    resolverVersion: 1,
    occurredAt: 1_000,
    ...overrides,
  };
}

function openFileDb() {
  const root = join(tmpdir(), `memory-cue-ledger-${randomUUID().slice(0, 8)}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const dbPath = join(root, 'memory.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return { db, dbPath };
}

function runWorker({ dbPath, moduleUrl, input, barrier }) {
  const source = `
    import Database from 'better-sqlite3';
    import { parentPort, workerData } from 'node:worker_threads';
    const { MemoryCueEpisodeStore } = await import(workerData.moduleUrl);
    const db = new Database(workerData.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    const state = new Int32Array(workerData.barrier);
    Atomics.add(state, 0, 1);
    Atomics.notify(state, 0);
    while (Atomics.load(state, 0) < 2) Atomics.wait(state, 0, 1, 5000);
    try {
      const result = new MemoryCueEpisodeStore(db).append(workerData.input);
      parentPort.postMessage({ ok: true, result });
    } catch (error) {
      parentPort.postMessage({ ok: false, error: String(error?.stack ?? error) });
    } finally {
      db.close();
    }
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      type: 'module',
      workerData: { dbPath, moduleUrl, input, barrier },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}`));
    });
  });
}

describe('MemoryCueEpisodeStore', () => {
  it('returns the same durable event for an exact retry and rejects conflicting immutable fields', async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { MemoryCueEpisodeStore, MemoryCueEventConflictError } = await import(
      '../../dist/domains/memory/cue/MemoryCueEpisodeStore.js'
    );
    const db = new Database(':memory:');
    applyMigrations(db);
    const store = new MemoryCueEpisodeStore(db, { nowIso: () => '2026-08-01T00:00:00.000Z' });

    const first = store.append(consumption());
    const retry = store.append(consumption());
    assert.deepEqual(retry, first);
    assert.equal(store.listByCue('owner-1', 'cue-1').length, 1);

    const conflict = consumption({
      eventId: 'event-conflict',
      axis: 'invalidation',
      invalidationReason: 'source_corrected',
    });
    delete conflict.consumptionOutcome;
    assert.throws(() => store.append(conflict), MemoryCueEventConflictError);
    assert.deepEqual(store.listByCue('owner-1', 'cue-1'), [first]);
  });

  it('rejects private text/rationale fields and never exposes mutation methods', async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { MemoryCueEpisodeStore } = await import('../../dist/domains/memory/cue/MemoryCueEpisodeStore.js');
    const db = new Database(':memory:');
    applyMigrations(db);
    const store = new MemoryCueEpisodeStore(db);

    assert.throws(() => store.append({ ...consumption(), rationale: 'private chain of thought' }));
    assert.throws(() => store.append({ ...consumption(), sourceBody: 'secret source' }));
    assert.equal(store.update, undefined);
    assert.equal(store.delete, undefined);
  });

  it('requires presented truth before drilled/applied/dismissed outcomes', async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { MemoryCueEpisodeStore, MemoryCuePresentationRequiredError } = await import(
      '../../dist/domains/memory/cue/MemoryCueEpisodeStore.js'
    );
    const db = new Database(':memory:');
    applyMigrations(db);
    const store = new MemoryCueEpisodeStore(db);

    assert.throws(
      () =>
        store.append(
          consumption({
            eventId: 'event-applied',
            idempotencyKey: 'idempotency-applied',
            consumptionOutcome: 'applied',
          }),
        ),
      MemoryCuePresentationRequiredError,
    );
    store.append(consumption());
    assert.equal(
      store.append(
        consumption({
          eventId: 'event-applied',
          idempotencyKey: 'idempotency-applied',
          consumptionOutcome: 'applied',
        }),
      ).consumptionOutcome,
      'applied',
    );
  });

  it('migrates a real v41 ledger to v43 without losing receipts or append-only guards', async () => {
    const { applyMigrations, CURRENT_SCHEMA_VERSION } = await import('../../dist/domains/memory/schema.js');
    const { MemoryCueEpisodeStore } = await import('../../dist/domains/memory/cue/MemoryCueEpisodeStore.js');
    const db = new Database(':memory:');
    installV41CueLedgerFixture(db);
    const rowsBefore = db.prepare('SELECT * FROM memory_cue_events ORDER BY occurred_at').all();
    applyMigrations(db);
    const store = new MemoryCueEpisodeStore(db);
    const decisionReceipt = store.append(
      consumption({
        eventId: 'v42-decision-event',
        idempotencyKey: 'v42-decision-idempotency',
        cueId: 'v42-decision-cue',
        opportunityId: 'v42-decision-opportunity',
        resolverFamily: 'decision',
        sourceAnchor: 'ADR-020',
        sourceRevision: 'sha256:v42-decision-revision',
      }),
    );

    assert.equal(CURRENT_SCHEMA_VERSION, 43);
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version, 43);
    assert.deepEqual(
      db
        .prepare("SELECT * FROM memory_cue_events WHERE event_id LIKE 'v41-%' ORDER BY occurred_at")
        .all()
        .map(({ consumer_cat_id: _consumerCatId, ...row }) => row),
      rowsBefore,
    );
    assert.equal(
      db.prepare("SELECT consumer_cat_id FROM memory_cue_events WHERE event_id = 'v41-person-event'").get()
        .consumer_cat_id,
      'legacy-unbound',
    );
    assert.equal(decisionReceipt.resolverFamily, 'decision');
    assert.deepEqual(
      db
        .prepare('PRAGMA table_info(memory_cue_events)')
        .all()
        .map(({ name }) => name),
      [
        'event_id',
        'idempotency_key',
        'cue_id',
        'opportunity_id',
        'owner_user_id',
        'thread_id',
        'invocation_id',
        'consumer_cat_id',
        'resolver_family',
        'source_anchor',
        'source_revision',
        'axis',
        'consumption_outcome',
        'invalidation_reason',
        'catalog_version',
        'resolver_version',
        'occurred_at',
        'created_at',
      ],
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_memory_cue_events_%' ORDER BY name",
        )
        .all()
        .map(({ name }) => name),
      ['idx_memory_cue_events_cue_scope', 'idx_memory_cue_events_opportunity'],
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memory_cue_events_no_%' ORDER BY name",
        )
        .all()
        .map(({ name }) => name),
      ['memory_cue_events_no_delete', 'memory_cue_events_no_update'],
    );
    assert.throws(() => db.prepare("UPDATE memory_cue_events SET source_revision = 'changed'").run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM memory_cue_events').run(), /append-only/);

    const rowCount = db.prepare('SELECT COUNT(*) AS count FROM memory_cue_events').get().count;
    applyMigrations(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_cue_events').get().count, rowCount);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_version WHERE version = 43').get().count, 1);
  });

  it('repairs rewound migration markers without downgrading a v43 ledger or losing its cat binding', async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { MemoryCueEpisodeStore } = await import('../../dist/domains/memory/cue/MemoryCueEpisodeStore.js');
    const db = new Database(':memory:');
    applyMigrations(db);
    const store = new MemoryCueEpisodeStore(db);
    store.append(consumption({ consumerCatId: 'codex-sol' }));
    db.prepare('DELETE FROM schema_version WHERE version >= 41').run();

    assert.doesNotThrow(() => applyMigrations(db));
    assert.equal(
      db.prepare("SELECT consumer_cat_id FROM memory_cue_events WHERE event_id = 'event-1'").get().consumer_cat_id,
      'codex-sol',
    );
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version, 43);
  });

  it('serializes two independent WAL connections racing on one idempotency key', async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { db, dbPath } = openFileDb();
    applyMigrations(db);
    db.close();

    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const moduleUrl = new URL('../../dist/domains/memory/cue/MemoryCueEpisodeStore.js', import.meta.url).href;
    const input = consumption();
    const results = await Promise.all([
      runWorker({ dbPath, moduleUrl, input, barrier }),
      runWorker({ dbPath, moduleUrl, input, barrier }),
    ]);
    assert.deepEqual(
      results.map((result) => result.ok),
      [true, true],
      JSON.stringify(results),
    );
    assert.deepEqual(results[0].result, results[1].result);

    const verify = new Database(dbPath);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM memory_cue_events').get().count, 1);
    verify.close();
  });

  it('reopens without restoring a CueEnvelope body', async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    const { MemoryCueEpisodeStore } = await import('../../dist/domains/memory/cue/MemoryCueEpisodeStore.js');
    const { db, dbPath } = openFileDb();
    applyMigrations(db);
    new MemoryCueEpisodeStore(db).append(consumption());
    db.close();

    const reopened = new Database(dbPath);
    const event = new MemoryCueEpisodeStore(reopened).listByCue('owner-1', 'cue-1')[0];
    assert.equal(event.cueId, 'cue-1');
    assert.equal(Object.hasOwn(event, 'title'), false);
    assert.equal(Object.hasOwn(event, 'summary'), false);
    assert.equal(Object.hasOwn(event, 'whyNow'), false);
    assert.equal(Object.hasOwn(event, 'sourceBody'), false);
    reopened.close();
  });
});
