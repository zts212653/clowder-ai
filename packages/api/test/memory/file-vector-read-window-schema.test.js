import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import * as vec from 'sqlite-vec';
import { prepareFileVectorReadWindow } from '../../dist/domains/memory/file-vector-read-window.js';
import { PassageVectorStore } from '../../dist/domains/memory/PassageVectorStore.js';

test(
  'persisted schema cannot call lifecycle functions or retire a top-level scope',
  { skip: process.platform !== 'darwin' },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), 'memory-read-window-schema-'));
    const file = path.join(root, 'neutral.sqlite');
    const writer = new Database(file);
    try {
      vec.load(writer);
      writer.pragma('journal_mode=WAL');
      writer.exec('CREATE VIRTUAL TABLE passage_vectors USING vec0(passage_key TEXT PRIMARY KEY, embedding float[4])');
      const vectors = new PassageVectorStore(writer, 4);
      for (let i = 0; i < 8; i++) vectors.upsert(`neutral-${i}`, new Float32Array([i, 0, 0, 0]));
      for (const name of ['begin', 'end']) {
        writer.exec(`
        CREATE VIEW attack_${name} AS SELECT memory_read_window_${name}() FROM sqlite_schema LIMIT 1;
        CREATE TABLE target_${name}(v);
        CREATE TRIGGER attack_${name} AFTER INSERT ON target_${name}
        BEGIN SELECT memory_read_window_${name}(); END;
      `);
      }
    } finally {
      writer.close();
    }
    const db = new Database(file, { readonly: true });
    try {
      vec.load(db);
      db.pragma('trusted_schema=ON'); // The function's own boundary must reject even trusted persisted schema.
      const reader = prepareFileVectorReadWindow(db);
      assert.equal(typeof reader, 'function', 'use the actual shipped extension');
      const query = new Float32Array([1, 0, 0, 0]);
      const vectors = new PassageVectorStore(db, 4);
      const expected = vectors.search(query, 5);
      const assertSchemaRejected = (name) => {
        const unsafe = (error) =>
          error.code === 'SQLITE_ERROR' && error.message.includes(`unsafe use of memory_read_window_${name}()`);
        assert.throws(() => db.prepare(`SELECT * FROM attack_${name}`).get(), unsafe);
        // Preparation must reject the trigger before a readonly write attempt; no INSERT is run.
        assert.throws(() => db.prepare(`INSERT INTO target_${name} VALUES(1)`), unsafe);
      };
      for (const name of ['begin', 'end']) assertSchemaRejected(name);
      db.exec('BEGIN');
      const begin = db.prepare('SELECT memory_read_window_begin() AS active FROM sqlite_schema LIMIT 1');
      assert.equal(begin.get().active, 1, 'schema did not open a scope');
      assertSchemaRejected('end');
      assert.equal(begin.get().active, 0, 'schema did not close the top-level scope');
      assert.equal(db.prepare('SELECT memory_read_window_end() AS released').get().released, 1);
      db.exec('COMMIT');
      assert.deepEqual(new PassageVectorStore(db, 4, reader).search(query, 5), expected);
      const rebound = prepareFileVectorReadWindow(db);
      for (const name of ['begin', 'end']) assertSchemaRejected(name);
      assert.deepEqual(new PassageVectorStore(db, 4, rebound).search(query, 5), expected);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
