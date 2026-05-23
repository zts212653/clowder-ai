import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

describe('PassageVectorStore', () => {
  let db;

  beforeEach(async () => {
    const { applyMigrations, ensurePassageVectorTable, ensureVectorTable } = await import(
      '../../dist/domains/memory/schema.js'
    );

    db = new Database(':memory:');
    applyMigrations(db);
    sqliteVec.load(db);
    assert.equal(ensureVectorTable(db, 4), true);
    assert.equal(ensurePassageVectorTable(db, 4), true);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('round-trips arbitrary passage vector keys without ad hoc splitting', async () => {
    const { parsePassageVectorKey, passageVectorKey } = await import('../../dist/domains/memory/PassageVectorStore.js');

    const key = passageVectorKey('thread-thread_abc::with-delimiter', 'msg-001/with/slash');
    assert.deepEqual(parsePassageVectorKey(key), {
      docAnchor: 'thread-thread_abc::with-delimiter',
      passageId: 'msg-001/with/slash',
    });
  });

  it('stores and searches passage vectors independently from document vectors', async () => {
    const { VectorStore } = await import('../../dist/domains/memory/VectorStore.js');
    const { PassageVectorStore, passageVectorKey } = await import('../../dist/domains/memory/PassageVectorStore.js');

    const docVectors = new VectorStore(db, 4);
    const passageVectors = new PassageVectorStore(db, 4);

    docVectors.upsert('F102', new Float32Array([0, 0, 1, 0]));
    passageVectors.upsert(passageVectorKey('thread-thread_a', 'msg-001'), new Float32Array([1, 0, 0, 0]));
    passageVectors.upsert(passageVectorKey('thread-thread_b', 'msg-002'), new Float32Array([0, 1, 0, 0]));

    const hits = passageVectors.search(new Float32Array([1, 0, 0, 0]), 2);
    assert.equal(hits[0].passageKey, passageVectorKey('thread-thread_a', 'msg-001'));
    assert.equal(passageVectors.count(), 2);
    assert.equal(docVectors.count(), 1);

    passageVectors.delete(passageVectorKey('thread-thread_a', 'msg-001'));
    assert.equal(passageVectors.count(), 1);
    assert.equal(docVectors.count(), 1);

    passageVectors.clearAll();
    assert.equal(passageVectors.count(), 0);
    assert.equal(docVectors.count(), 1);
  });
});
