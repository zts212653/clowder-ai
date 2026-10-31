import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { signEditToken } from '../src/domains/workspace/workspace-edit.js';
import { cancellationFixture } from './helpers/content-modification-cancellation-fixture.js';

test('real callback candidate and human dispositions reach chat catch-up once without empty acknowledgement turns', async (t) => {
  const f = await cancellationFixture(t);
  const request = await f.integration.requests.submit(f.payload, f.human);
  assert.ok(request.delivery?.messageId);
  const originalInvocation = await f.dispatch.waitForAwakening(request.delivery.messageId);
  const source = await f.integration.text.read(f.requestId, f.cat);
  const originalStarts = f.starts.length;
  const respond = (expectedProposalRevision: number, replacement: string) =>
    f.app.inject({
      method: 'POST',
      url: '/api/callbacks/content-modification/respond',
      headers: { 'x-invocation-id': f.actor.invocationId, 'x-callback-token': f.actor.callbackToken },
      payload: {
        requestId: f.requestId,
        operationId: randomUUID(),
        expectedTaskRevision: request.record.progress.task!.revision,
        expectedProposalRevision,
        baseRevision: source.source.source.revision,
        edits: [{ start: 4, end: 7, expectedText: 'old', replacement }],
        response: `Use ${replacement}.`,
      },
    });

  const first = await respond(0, 'new');
  assert.equal(first.statusCode, 200, first.body);
  const firstCandidateRef = first.json().proposalRef as string;
  assert.deepEqual(receiptStates(f), ['candidate']);
  assert.equal(f.receiptEvents.length, 1, 'new durable receipt requests one live history catch-up');
  assert.equal(f.starts.length, originalStarts, 'candidate is display-only');

  const rejected = await f.app.inject({
    method: 'POST',
    url: `/api/content-modifications/${f.requestId}/reject`,
    headers: { 'x-cat-cafe-user': 'operator' },
    payload: { candidateRef: firstCandidateRef },
  });
  assert.equal(rejected.statusCode, 200, rejected.body);
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/content-modifications/${f.requestId}/reject`,
        headers: { 'x-cat-cafe-user': 'operator' },
        payload: { candidateRef: firstCandidateRef },
      })
    ).statusCode,
    200,
  );
  assert.deepEqual(receiptStates(f), ['candidate', 'rejected']);
  assert.equal(f.receiptEvents.length, 2, 'replayed rejection neither appends nor rebroadcasts');
  assert.equal(f.starts.length, originalStarts, 'rejection is display-only');

  const second = await respond(1, 'better');
  assert.equal(second.statusCode, 200, second.body);
  await f.dispatch.releaseProvider(originalInvocation);
  const applied = await f.app.inject({
    method: 'POST',
    url: `/api/content-modifications/${f.requestId}/accept`,
    headers: { 'x-cat-cafe-user': 'operator' },
    payload: {
      requestId: f.requestId,
      candidateRef: second.json().proposalRef,
      acceptOperationId: randomUUID(),
      baseRevision: source.source.source.revision,
      locator: f.payload.source.locator,
      editSessionToken: signEditToken('work'),
    },
  });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json().receipt.state, 'applied');
  assert.deepEqual(receiptStates(f), ['candidate', 'rejected', 'candidate', 'applied']);
  assert.equal(f.receiptEvents.length, 4);
  const completion = f.messages
    .getByThreadIncludingQueued(f.thread.id)
    .find((m) => m.source?.meta?.kind === 'text_writeback_completion');
  assert.ok(completion);
  await f.dispatch.waitForAwakening(completion.id);
  assert.equal(
    f.starts.length,
    originalStarts + 1,
    'applied returns the exact still-open Task owner for verification, not an empty acknowledgement',
  );
  assert.equal(
    f.messages
      .getByThreadIncludingQueued(f.thread.id)
      .filter((m) => m.source?.meta?.kind === 'text_writeback_completion').length,
    1,
  );
  assert.deepEqual(f.errors, []);

  for (const message of receiptMessages(f)) {
    assert.deepEqual(message.mentions, []);
    assert.equal(message.extra?.targetCats, undefined);
    assert.equal(message.replyTo, request.record.progress.sourceMessageId);
  }
});

test('restart recovery repairs a lost chat append from canonical receipts without duplicating messages or effects', async (t) => {
  const f = await cancellationFixture(t);
  const candidateProjection = f.integration.receipts.projectCandidate.bind(f.integration.receipts);
  const rejectionProjection = f.integration.receipts.projectRejection.bind(f.integration.receipts);
  const writebackProjection = f.integration.receipts.projectWriteback.bind(f.integration.receipts);
  f.integration.receipts.projectCandidate = async () => undefined;
  f.integration.receipts.projectRejection = async () => undefined;
  f.integration.receipts.projectWriteback = async () => undefined;

  const request = await f.integration.requests.submit(f.payload, f.human);
  const source = await f.integration.text.read(f.requestId, f.cat);
  const respond = (expectedProposalRevision: number, replacement: string) =>
    f.app.inject({
      method: 'POST',
      url: '/api/callbacks/content-modification/respond',
      headers: { 'x-invocation-id': f.actor.invocationId, 'x-callback-token': f.actor.callbackToken },
      payload: {
        requestId: f.requestId,
        operationId: randomUUID(),
        expectedTaskRevision: request.record.progress.task!.revision,
        expectedProposalRevision,
        baseRevision: source.source.source.revision,
        edits: [{ start: 4, end: 7, expectedText: 'old', replacement }],
        response: `Use ${replacement}.`,
      },
    });
  const first = await respond(0, 'new');
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/content-modifications/${f.requestId}/reject`,
        headers: { 'x-cat-cafe-user': 'operator' },
        payload: { candidateRef: first.json().proposalRef },
      })
    ).statusCode,
    200,
  );
  const second = await respond(1, 'better');
  assert.equal(second.statusCode, 200, second.body);
  const accepted = await f.app.inject({
    method: 'POST',
    url: `/api/content-modifications/${f.requestId}/accept`,
    headers: { 'x-cat-cafe-user': 'operator' },
    payload: {
      requestId: f.requestId,
      candidateRef: second.json().proposalRef,
      acceptOperationId: randomUUID(),
      baseRevision: source.source.source.revision,
      locator: f.payload.source.locator,
      editSessionToken: signEditToken('work'),
    },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.deepEqual(receiptStates(f), []);

  f.integration.receipts.projectCandidate = candidateProjection;
  f.integration.receipts.projectRejection = rejectionProjection;
  f.integration.receipts.projectWriteback = writebackProjection;
  await f.integration.receipts.recover();
  assert.deepEqual(receiptStates(f), ['candidate', 'rejected', 'candidate', 'applied']);
  assert.equal(f.receiptEvents.length, 4);
  await f.integration.receipts.recover();
  assert.deepEqual(receiptStates(f), ['candidate', 'rejected', 'candidate', 'applied']);
  assert.equal(f.receiptEvents.length, 4);
  assert.deepEqual(f.errors, []);
});

test('a real writeback conflict wakes the still-open owner once and never retries the file effect', async (t) => {
  const f = await cancellationFixture(t);
  const request = await f.integration.requests.submit(f.payload, f.human);
  const source = await f.integration.text.read(f.requestId, f.cat);
  const returned = await f.integration.text.respond(
    {
      requestId: f.requestId,
      operationId: randomUUID(),
      expectedTaskRevision: request.record.progress.task!.revision,
      expectedProposalRevision: 0,
      baseRevision: source.source.source.revision,
      edits: [{ start: 4, end: 7, expectedText: 'old', replacement: 'new' }],
      response: 'Use new.',
    },
    f.cat,
  );
  await f.dispatch.close();
  const originalStarts = f.starts.length;
  const path = join(f.root, 'guide.md');
  await writeFile(path, 'A Human changed this file first.');
  const command = {
    requestId: f.requestId,
    candidateRef: returned.proposal.proposalRef,
    acceptOperationId: randomUUID(),
    baseRevision: source.source.source.revision,
    locator: f.payload.source.locator,
    editSessionToken: signEditToken('work'),
  };
  const first = await f.integration.results.accept(command, f.human);
  assert.equal(first.receipt.state, 'conflict');
  assert.equal(await readFile(path, 'utf8'), 'A Human changed this file first.');
  assert.equal(f.starts.length, originalStarts + 1);
  const receipt = receiptMessages(f).at(-1)?.extra?.contentModificationReceiptV1;
  assert.equal(receipt?.state, 'conflict');
  assert.equal(receipt?.followUp.kind, 'cat_woken');
  const wakeId =
    receipt?.followUp.kind === 'cat_woken' ? receipt.followUp.executionRef?.match(/^message:(.+)#/)?.[1] : null;
  const wake = wakeId ? f.messages.getById(wakeId) : null;
  assert.ok(wake);
  assert.equal(wake.source?.connector, 'content-modification-result');
  assert.match(wake.content, /不得自动重试写回/);

  assert.equal((await f.integration.results.accept(command, f.human)).receipt.state, 'conflict');
  assert.equal(f.starts.length, originalStarts + 1, 'same receipt owns at most one follow-up execution');
  assert.equal(await readFile(path, 'utf8'), 'A Human changed this file first.');
});

function receiptMessages(f: Awaited<ReturnType<typeof cancellationFixture>>) {
  return f.messages
    .getByThread(f.thread.id)
    .filter((message) => message.extra?.systemKind === 'content_modification_receipt');
}

function receiptStates(f: Awaited<ReturnType<typeof cancellationFixture>>) {
  return receiptMessages(f).map((message) => message.extra?.contentModificationReceiptV1?.state);
}
