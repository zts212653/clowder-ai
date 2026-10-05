import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ContentModificationJournal } from '../src/domains/collaborative-content/modification/journal.js';

test('one confirmed request survives restart and cross-owner gaps without changing its payload or lease winner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-modification-journal-'));
  const path = join(root, 'review.sqlite');
  const db = new Database(path),
    other = new Database(path);
  t.after(async () => {
    db.close();
    other.close();
    await rm(root, { recursive: true, force: true });
  });
  const a = new ContentModificationJournal(db),
    b = new ContentModificationJournal(other);
  const payload = {
    operationId: randomUUID(),
    source: {
      kind: 'publication' as const,
      contentRef: 'media-cover',
      ownerRevision: 1,
      ledgerRef: 'workspace-review-cover',
      expectedLedgerRevision: 2,
    },
    targetCatId: 'codex-astra',
    threadId: 'thread-cover',
    intent: { body: '移除角落多余的字' },
  };
  const first = a.reserve('operator', payload, 1000);
  assert.equal(b.reserve('operator', payload, 1001).requestId, first.requestId);
  assert.throws(() => b.reserve('operator', { ...payload, targetCatId: 'opus5' }, 1002), /operation_reused/);
  assert.notEqual(b.reserve('another-owner', payload, 1003).requestId, first.requestId);
  const lease = a.acquire(first.requestId, 'operator', 1004);
  assert.ok(lease);
  a.renew(first.requestId, lease.token, 2000);
  assert.equal(b.acquire(first.requestId, 'operator', 31005), null, 'renewed work keeps its exclusive lease');
  assert.throws(
    () => a.renew(first.requestId, lease.token, 32001),
    /lease_changed/,
    'expired tokens cannot revive themselves',
  );
  assert.equal(b.acquire(first.requestId, 'operator', 1005), null);
  const saved = a.advance(first.requestId, lease.token, { sourceMessageId: 'human-message' }, 1006);
  assert.equal(saved.progress.sourceMessageId, 'human-message');
  a.release(first.requestId, lease.token);
  const takeover = b.acquire(first.requestId, 'operator', 1007);
  assert.ok(takeover);
  assert.throws(() => a.renew(first.requestId, lease.token, 1008), /lease_changed/);
  assert.throws(
    () =>
      a.advance(first.requestId, lease.token, { task: { taskId: 'task-wrong', revision: 1, receiptRef: 'bad' } }, 1008),
    /lease_changed/,
  );
  assert.throws(
    () => b.advance(first.requestId, takeover.token, { sourceMessageId: 'replacement' }, 1009),
    /operation_reused/,
  );
  b.advance(
    first.requestId,
    takeover.token,
    { prepared: { kind: 'media', contentRef: 'media-cover', ownerRevision: 1, ledgerRef: 'workspace-review-cover' } },
    1010,
  );
  b.advance(
    first.requestId,
    takeover.token,
    { task: { taskId: 'task-cover', revision: 1, receiptRef: 'task-receipt' } },
    1011,
  );
  db.exec('CREATE TABLE ledger_effect (value TEXT PRIMARY KEY)');
  assert.throws(
    () =>
      b.bindReview(
        first.requestId,
        takeover.token,
        () => {
          other.prepare('INSERT INTO ledger_effect VALUES (?)').run('human-receipt');
          throw new Error('outbox failure');
        },
        1012,
      ),
    /outbox failure/,
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM ledger_effect').get() as { count: number }).count, 0);
  assert.equal(a.get(first.requestId, 'operator')?.progress.review, undefined);
  const bound = b.bindReview(
    first.requestId,
    takeover.token,
    () => {
      other.prepare('INSERT INTO ledger_effect VALUES (?)').run('human-receipt');
      return { reviewId: 'review-cover', round: 1, receiptRef: 'human-receipt' };
    },
    1013,
  );
  assert.equal(bound.progress.review?.receiptRef, 'human-receipt');
  assert.equal(a.get(first.requestId, 'operator')?.progress.task?.taskId, 'task-cover');
  assert.equal(a.get(first.requestId, 'other-owner'), null);
  const restarted = new ContentModificationJournal(other);
  assert.equal(restarted.get(first.requestId, 'operator')?.payload.intent.body, payload.intent.body);
  const cancelled = a.cancellations.cancel(first.requestId, 'operator', 1014);
  assert.equal(restarted.get(first.requestId, 'operator')?.control?.receiptRef, cancelled.control?.receiptRef);
  assert.equal(restarted.get(first.requestId, 'operator')?.progress.review?.receiptRef, 'human-receipt');
  assert.equal(
    restarted.pending().some((item) => item.requestId === first.requestId),
    false,
  );
  assert.equal(
    restarted.cancellations.pending().some((item) => item.requestId === first.requestId),
    true,
    'post-binding cancellations have a separate recovery scan',
  );
  assert.equal(restarted.acquire(first.requestId, 'operator', 1015), null);
  assert.throws(() => b.advance(first.requestId, takeover.token, {}, 1015), /lease_changed/);
  assert.throws(
    () =>
      b.cancellations.unlessCancelled(first.requestId, 'operator', () =>
        other.prepare('INSERT INTO ledger_effect VALUES (?)').run('late-effect'),
      ),
    /request_cancelled/,
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM ledger_effect').get() as { count: number }).count, 1);
});
