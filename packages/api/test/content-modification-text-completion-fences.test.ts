import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import type { TextWritebackCompletionIntent } from '../src/domains/collaborative-content/modification/text/text-writeback-completion-intent.js';
import { appliedText, completionMessages } from './helpers/content-modification-text-completion-fixture.js';

test('cancellation after the actual file effect retires its pending completion without another owner wake', async (t) => {
  const f = await appliedText(t, { deferDelivery: true });
  const response = await f.cancel();
  assert.equal(response.statusCode, 200, response.body);
  await f.resumeDelivery();
  await f.integration.receipts.recover();
  await f.dispatcher.drain();
  assert.equal(completionMessages(f).length, 0);
  assert.equal(f.starts.length, f.startsBeforeAcceptance);
  const actual = await f.integration.writer.findApplied(f.accepted.receipt.receiptRef, f.human);
  assert.equal(actual?.appliedSequence, f.accepted.receipt.appliedSequence);
});

for (const continuation of [false, true]) {
  test(`cancellation at the final delivery fence blocks the current ${continuation ? 'B continuation' : 'A'} completion`, async (t) => {
    const f = await appliedText(t, { deferDelivery: true, continuation });
    const intent = f.store.returns.pending().find((item) => item.kind === 'text_writeback_completion');
    assert.ok(intent);
    const cancellations = f.store.requests.cancellations;
    const isReturnCancelled = cancellations.isReturnCancelled.bind(cancellations);
    let checks = 0;
    cancellations.isReturnCancelled = (receiptRef) => {
      if (++checks === 2) cancellations.cancel(f.requestId, f.human.userId);
      return isReturnCancelled(receiptRef);
    };
    await f.resumeDelivery();
    assert.equal(checks, 2, 'cancel lands after both current checks, at the final delivery fence');
    assert.equal(completionMessages(f).length, 0);
    assert.equal(f.starts.length, f.startsBeforeAcceptance);
    const retired = f.store.returns.get(intent.receiptRef);
    assert.equal(retired?.state, 'retired');
    assert.equal(retired?.retirementReason, 'request_cancelled');
    const applied = await f.integration.writer.findApplied(f.accepted.receipt.receiptRef, f.human);
    assert.equal(applied?.appliedSequence, f.accepted.receipt.appliedSequence);
  });
}

test('preserving cancelled root A still permits its uncancelled B completion', async (t) => {
  const f = await appliedText(t, { deferDelivery: true, continuation: true });
  assert.notEqual(f.requestId, f.rootRequest.record.requestId);
  const response = await f.cancel(f.rootRequest.record.requestId);
  assert.equal(response.statusCode, 200, response.body);
  const root = f.store.requests.get(f.rootRequest.record.requestId, f.human.userId);
  assert.equal(root?.control?.taskResolution, 'preserved');
  assert.equal(f.store.requests.get(f.requestId, f.human.userId)?.control, undefined);
  await f.resumeDelivery();
  const completion = completionMessages(f);
  assert.equal(completion.length, 1);
  assert.equal(completion[0]?.source?.meta?.requestId, f.requestId);
  assert.equal(completion[0]?.source?.meta?.closureRequestId, f.rootRequest.record.requestId);
  assert.ok(completion[0]);
  await f.dispatch.waitForAwakening(completion[0].id); // exact persisted Queue/History child, no retired custody field
  const taskRef = f.request.record.progress.task;
  assert.ok(taskRef);
  assert.equal(f.tasks.get(taskRef.taskId)?.entrustedWork?.closure.state, 'open');
});

test('a Task that was actually typed-closed before delivery cannot be awakened by its older completion', async (t) => {
  const f = await appliedText(t, { deferDelivery: true });
  const task = f.tasks.get(f.request.record.progress.task!.taskId)!;
  await f.lifecycle.close({
    taskId: task.id,
    expectedRevision: task.entrustedWork!.revision,
    closure: {
      state: 'satisfied',
      condition: task.entrustedWork!.closure.condition,
      expectedSignal: task.entrustedWork!.closure.expectedSignal,
      evidenceRefs: [f.accepted.acceptance.humanReceiptRef, f.accepted.receipt.receiptRef],
    },
  });
  await f.resumeDelivery();
  assert.equal(completionMessages(f).length, 0);
  assert.equal(f.starts.length, f.startsBeforeAcceptance);
});

test('a changed current-owner snapshot between registration and delivery retires the old completion', async (t) => {
  const f = await appliedText(t, { deferDelivery: true });
  const taskId = f.request.record.progress.task!.taskId;
  const get = f.tasks.get.bind(f.tasks);
  f.tasks.get = (id) => {
    const task = get(id);
    return task && id === taskId ? { ...task, ownerCatId: createCatId('codex') } : task;
  };
  const intent = f.store.returns.pending().find((i) => i.kind === 'text_writeback_completion')!;
  await f.resumeDelivery();
  assert.equal(completionMessages(f).length, 0);
  assert.equal(f.store.returns.get(intent.receiptRef)?.state, 'retired');
  assert.equal(f.starts.length, f.startsBeforeAcceptance);
});

test('a subsequent request for another actual file cannot fulfill the admitted Task file signal', async (t) => {
  const f = await appliedText(t, { continuation: true, continuationFile: 'other.md' });
  assert.equal(f.accepted.receipt.locator.path, 'other.md');
  assert.equal(f.request.record.progress.task!.taskId, f.rootRequest.record.progress.task!.taskId);
  assert.equal(completionMessages(f).length, 0);
  assert.equal(f.starts.length, f.startsBeforeAcceptance);
});

test('preflight changing the owner is revalidated before any queued completion body is appended', async (t) => {
  const f = await appliedText(t, { deferDelivery: true });
  const authorize = f.targets.authorizeDelivery.bind(f.targets);
  const get = f.tasks.get.bind(f.tasks);
  f.targets.authorizeDelivery = async (intent) => {
    await authorize(intent);
    f.tasks.get = (id) => {
      const task = get(id);
      return task && id === intent.taskId ? { ...task, ownerCatId: createCatId('codex') } : task;
    };
  };
  await f.resumeDelivery();
  assert.equal(completionMessages(f).length, 0);
  assert.equal(f.starts.length, f.startsBeforeAcceptance);
});

test('another user or cat cannot read the original owner acceptance/writeback evidence', async (t) => {
  const f = await appliedText(t);
  await assert.rejects(f.integration.text.read(f.requestId, { ...f.cat, userId: 'foreign' }));
  await assert.rejects(f.integration.text.read(f.requestId, { ...f.cat, actor: { kind: 'cat', actorId: 'codex' } }));
});

for (const [name, field, value] of [
  ['thread', 'threadId', 'foreign-thread'],
  ['Task', 'taskId', 'foreign-task'],
  ['closure signal', 'expectedSignal', 'unrelated-signal'],
  ['root request', 'closureRequestId', `f309-modification-${'f'.repeat(64)}`],
  ['candidate', 'candidateRef', 'unrelated-candidate'],
  ['file receipt', 'writebackReceiptRef', 'workspace-writeback:unrelated'],
] as const) {
  test(`a persisted completion with a mismatched ${name} cannot wake an owner`, async (t) => {
    const f = await appliedText(t, { deferDelivery: true });
    const intent = f.store.returns
      .pending()
      .find((i): i is TextWritebackCompletionIntent => i.kind === 'text_writeback_completion')!;
    // Fault injection is restricted to this test's private SQLite outbox. Task/receipt authorities stay real.
    const db = new Database(join(f.root, 'collaborative-content', 'artifact-reviews.sqlite'));
    db.prepare('UPDATE artifact_review_returns SET body=? WHERE receipt_ref=?').run(
      JSON.stringify({ ...intent, [field]: value }),
      intent.receiptRef,
    );
    db.close();
    await f.resumeDelivery();
    assert.equal(completionMessages(f).length, 0);
    assert.equal(f.store.returns.get(intent.receiptRef)?.state, 'retired');
    assert.equal(f.starts.length, f.startsBeforeAcceptance);
  });
}
