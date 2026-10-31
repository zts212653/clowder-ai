import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import Database from 'better-sqlite3';
import { ArtifactReviewReturnStore } from '../src/domains/collaborative-content/artifact-review/return-store.js';

/** Historical selector rows only; these fixtures never authorize a recovery or publish a candidate. */
function legacyDatabase(t: TestContext, receipts: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'f309-generation-migration-'));
  const path = join(directory, 'owner.sqlite');
  let database = new Database(path);
  database.exec(`CREATE TABLE artifact_review_returns (
    receipt_ref TEXT PRIMARY KEY, state TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL
  )`);
  for (const [index, receiptRef] of receipts.entries()) {
    const body = {
      receiptRef,
      requestId: 'original-request',
      kind: 'resume_media_publication',
      state: 'queued',
      createdAt: `2026-10-${10 + index}T00:00:00Z`,
    };
    database
      .prepare('INSERT INTO artifact_review_returns VALUES(?,?,?,?)')
      .run(receiptRef, body.state, body.createdAt, JSON.stringify(body));
  }
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get database() {
      return database;
    },
    reopen() {
      database.close();
      database = new Database(path);
      return new ArtifactReviewReturnStore(database);
    },
  };
}

test('a single legacy publication initializes generation zero without rewriting its durable body', (t) => {
  const f = legacyDatabase(t, ['old-receipt']);
  const before = f.database.prepare('SELECT * FROM artifact_review_returns').all();
  const returns = new ArtifactReviewReturnStore(f.database);
  assert.deepEqual(returns.publications.current('original-request'), { receipt_ref: 'old-receipt', generation: 0 });
  assert.equal(returns.publicationForRequest('original-request')?.receiptRef, 'old-receipt');
  assert.deepEqual(f.database.prepare('SELECT * FROM artifact_review_returns').all(), before);
  assert.deepEqual(f.reopen().publications.current('original-request'), { receipt_ref: 'old-receipt', generation: 0 });
});

test('ambiguous legacy publications fail closed instead of selecting by timestamp or receipt ordering', (t) => {
  const f = legacyDatabase(t, ['z-old-receipt', 'a-newer-receipt']);
  const before = f.database.prepare('SELECT * FROM artifact_review_returns ORDER BY receipt_ref').all();
  const returns = new ArtifactReviewReturnStore(f.database);
  assert.throws(() => returns.publicationForRequest('original-request'), { code: 'revision_conflict' });
  assert.deepEqual(f.database.prepare('SELECT * FROM artifact_review_returns ORDER BY receipt_ref').all(), before);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM artifact_publication_current').pluck().get(), 0);
  assert.throws(() => f.reopen().publicationForRequest('original-request'), { code: 'revision_conflict' });
});

test('reopening preserves an explicit generation pointer even when another historical receipt sorts later', (t) => {
  const f = legacyDatabase(t, ['current-receipt', 'z-later-history']);
  f.database.exec(`CREATE TABLE artifact_publication_current (
    request_id TEXT PRIMARY KEY, receipt_ref TEXT NOT NULL REFERENCES artifact_review_returns(receipt_ref),
    generation INTEGER NOT NULL CHECK(generation >= 0)
  )`);
  f.database
    .prepare("UPDATE artifact_review_returns SET body=json_set(body,'$.recovery.generation',2) WHERE receipt_ref=?")
    .run('current-receipt');
  f.database
    .prepare('INSERT INTO artifact_publication_current VALUES(?,?,?)')
    .run('original-request', 'current-receipt', 2);
  const reopened = f.reopen();
  assert.deepEqual(reopened.publications.current('original-request'), {
    receipt_ref: 'current-receipt',
    generation: 2,
  });
  assert.equal(reopened.publicationForRequest('original-request')?.receiptRef, 'current-receipt');
  assert.equal(reopened.publicationForRequest('original-request')?.recovery?.generation, 2);
  assert.equal(reopened.publicationForRequest('absent-request'), null);
});
