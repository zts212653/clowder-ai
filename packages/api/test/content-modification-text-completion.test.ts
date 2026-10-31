import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { catConsumableHostSpeaker } from '../src/domains/cats/services/stores/host-message-policy.js';
import { appliedText, completionMessages } from './helpers/content-modification-text-completion-fixture.js';

test('real applied text writeback returns its matching open Task to the owner, separately from the display receipt', async (t) => {
  const f = await appliedText(t);
  const taskId = f.request.record.progress.task!.taskId;
  assert.equal(f.tasks.get(taskId)?.entrustedWork?.closure.state, 'open', 'only the original owner can close');
  const display = f.messages
    .getByThread(f.thread.id)
    .find((m) => m.extra?.contentModificationReceiptV1?.state === 'applied');
  assert.deepEqual(display?.extra?.contentModificationReceiptV1?.followUp, { kind: 'none', reason: 'not_applicable' });
  assert.deepEqual(f.errors, [], 'completion registration/delivery must not hide an error');
  const completions = completionMessages(f);
  assert.equal(completions.length, 1, 'a real completion returns the still-open original Task exactly once');
  assert.equal(catConsumableHostSpeaker(completions[0]!), 'Host 文档写回完成：原任务核证续办');
  assert.equal(
    catConsumableHostSpeaker({
      ...completions[0],
      source: {
        ...completions[0]!.source,
        meta: { ...completions[0]!.source!.meta, expectedSignal: 'foreign-signal' },
      },
    }),
    undefined,
  );
  const carrier = completions[0]!.source!.meta!;
  assert.equal(carrier.requestId, f.requestId);
  assert.equal(carrier.taskId, taskId);
  assert.equal(carrier.targetCatId, 'codex-astra');
  assert.equal(carrier.expectedSignal, `${f.requestId}#file-writeback-applied`);
  assert.equal(carrier.humanReceiptRef, f.accepted.acceptance.humanReceiptRef);
  assert.equal(carrier.writebackReceiptRef, f.accepted.receipt.receiptRef);
  assert.equal(carrier.writtenRevision, f.accepted.receipt.writtenRevision);
  assert.notEqual(carrier.returnRef, carrier.writebackReceiptRef);
  await f.dispatch.waitForAwakening(completions[0]!.id);
  assert.equal(f.starts.length, f.startsBeforeAcceptance + 1);
  assert.match(completions[0]!.content, /close_entrusted_work/);
  assert.match(completions[0]!.content, /不得.*写回/);
  assert.deepEqual(f.errors, []);
});

test('a subsequent text request B returns the same Task whose precise completion signal still names its admitted request A', async (t) => {
  const f = await appliedText(t, { continuation: true });
  assert.notEqual(f.requestId, f.rootRequest.record.requestId);
  assert.equal(f.request.record.progress.task!.taskId, f.rootRequest.record.progress.task!.taskId);
  const completions = completionMessages(f);
  assert.equal(completions.length, 1, 'legitimate subsequent same-file work must not remain permanently open');
  const carrier = completions[0]!.source!.meta!;
  assert.equal(carrier.requestId, f.requestId);
  assert.equal(carrier.closureRequestId, f.rootRequest.record.requestId);
  assert.equal(carrier.expectedSignal, `${f.rootRequest.record.requestId}#file-writeback-applied`);
  assert.equal(carrier.writebackReceiptRef, f.accepted.receipt.receiptRef);
  assert.equal(f.tasks.get(f.request.record.progress.task!.taskId)?.entrustedWork?.closure.state, 'open');
});

test('the authenticated original owner can read canonical acceptance and public writeback evidence after text is applied', async (t) => {
  const f = await appliedText(t);
  const response = await f.catRead();
  assert.equal(response.statusCode, 200, response.body);
  const view = JSON.parse(response.json().json);
  assert.deepEqual(view.acceptances, [f.accepted], 'owner closure must use actual acceptance/F063 evidence');
  assert.equal(view.acceptances[0].receipt.targetPath, undefined);
  assert.equal(view.acceptances[0].receipt.proof, undefined);
  assert.equal(view.acceptances[0].receipt.fingerprint, undefined);
});

test('after A is adopted, a fresh-byte same-file B can return the original still-open Task with A closure provenance', async (t) => {
  const f = await appliedText(t);
  const first = completionMessages(f)[0];
  assert.ok(first);
  const firstInvocation = await f.dispatch.waitForAwakening(first.id);
  await f.dispatch.releaseProvider(firstInvocation);
  const refreshed = await f.files.refresh({
    principal: f.human,
    reviewId: f.payload.source.reviewId,
    expectedRevision: f.payload.source.expectedReviewRevision,
    operationId: randomUUID(),
    expectedSourceRevision: f.accepted.receipt.writtenRevision,
  });
  assert.ok(refreshed.review.source.kind === 'text');
  assert.notEqual(refreshed.review.source.revision, f.payload.source.expectedSourceRevision);
  const originalTask = f.request.record.progress.task;
  assert.ok(originalTask);
  const later = await f.integration.requests.submit(
    {
      ...f.payload,
      operationId: randomUUID(),
      source: {
        ...f.payload.source,
        expectedReviewRevision: refreshed.review.revision,
        expectedSourceRevision: refreshed.review.source.revision,
      },
      taskContext: { kind: 'text', taskId: originalTask.taskId, expectedTaskRevision: originalTask.revision },
    },
    f.human,
  );
  assert.ok(later.delivery?.messageId);
  const invocation = await f.dispatch.waitForAwakening(later.delivery.messageId);
  const proposal = await f.integration.text.respond(
    {
      requestId: later.record.requestId,
      operationId: randomUUID(),
      expectedTaskRevision: originalTask.revision,
      expectedProposalRevision: 0,
      baseRevision: refreshed.review.source.revision,
      edits: [{ start: 4, end: 7, expectedText: 'new', replacement: 'better' }],
      response: 'Use better.',
    },
    f.cat,
  );
  await f.dispatch.releaseProvider(invocation);
  const adopted = await f.integration.results.accept(
    {
      ...f.command,
      requestId: later.record.requestId,
      candidateRef: proposal.proposal.proposalRef,
      acceptOperationId: randomUUID(),
      baseRevision: refreshed.review.source.revision,
    },
    f.human,
  );
  assert.equal(adopted.receipt.state, 'applied');
  const completion = completionMessages(f);
  assert.equal(completion.length, 2);
  const carrier = completion[1]?.source?.meta;
  assert.equal(carrier?.requestId, later.record.requestId);
  assert.equal(carrier?.closureRequestId, f.requestId);
  assert.equal(carrier?.taskId, originalTask.taskId);
  assert.equal(carrier?.expectedSignal, `${f.requestId}#file-writeback-applied`);
  assert.equal(carrier?.writebackReceiptRef, adopted.receipt.receiptRef);
  assert.equal(f.tasks.get(originalTask.taskId)?.entrustedWork?.closure.state, 'open');
});
