import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type TestContext, test } from 'node:test';
import { modificationMessageRequestId } from '../src/domains/collaborative-content/modification/journal.js';
import { signEditToken } from '../src/domains/workspace/workspace-edit.js';
import { firstFileFixture } from './helpers/content-modification-first-file-fixture.js';
import { mediaMessageFixture } from './helpers/media-message-fixture.js';

async function fixture(t: TestContext, kind: 'md' | 'ts' | 'png' | 'mp4' = 'md') {
  const f =
    kind === 'md' || kind === 'ts'
      ? await firstFileFixture(t, kind === 'md' ? 'guide.md' : 'guide.ts')
      : await mediaMessageFixture(t, kind === 'png' ? 'image/png' : 'video/mp4');
  const message = 'message' in f ? f.message : f.send();
  const auth = 'auth' in f ? f.auth : f.actor;
  const target = f.cat.actor.actorId;
  const takeover = (extra: Record<string, unknown> = {}) =>
    f.app.inject({
      method: 'POST',
      url: '/api/callbacks/content-modification/take-over',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { sourceMessageId: message.id, operationId: randomUUID(), ...extra },
    });
  const fileStore = 'fileStore' in f ? f.fileStore : f.filesStore;
  const reviewId = 'reviewId' in f ? f.reviewId : '';
  const taskCount = f.tasks.listByThread(f.thread.id).length;
  return { ...f, fileStore, reviewId, taskCount, message, auth, target, takeover };
}

for (const kind of ['md', 'ts', 'png', 'mp4'] as const) {
  test(`delivered ${kind}: callback takes over without changing delivery or settling the Human`, async (t) => {
    const f = await fixture(t, kind);
    const before = structuredClone(f.messages.getById(f.message.id));
    const count = f.tasks.listByThread(f.thread.id).length;
    const result = await f.takeover();
    assert.equal(result.statusCode, 200, result.body);
    const record = result.json().record;
    assert.equal(
      result.json().stage,
      'queued',
      JSON.stringify({
        issue: record.issue,
        events: f.events,
        errors:
          'errors' in f
            ? f.errors.map((e) =>
                e instanceof AggregateError
                  ? [e.message, ...e.errors.map((nested: Error) => nested.stack)]
                  : e instanceof Error
                    ? e.stack
                    : e,
              )
            : [],
      }),
    );
    assert.equal(record.progress.sourceMessageId, f.message.id);
    assert.equal(record.progress.sourceKind, 'human_message');
    assert.equal(record.payload.intent.body, f.message.content);
    assert.equal(record.payload.targetCatId, f.target);
    assert.equal(record.payload.threadId, f.thread.id);
    assert.equal(f.messages.getById(f.message.id)?.deliveryStatus, undefined);
    assert.deepEqual(f.messages.getById(f.message.id), before);
    const repeat = await f.takeover();
    assert.equal(repeat.statusCode, 200, repeat.body);
    assert.equal(repeat.json().record.requestId, record.requestId);
    assert.equal(f.tasks.listByThread(f.thread.id).length, count + (kind === 'md' || kind === 'ts' ? 1 : 0));
    if (kind === 'md' || kind === 'ts') {
      const read = await f.integration.text.read(record.requestId, f.cat);
      const quote = kind === 'md' ? 'First unique paragraph.' : 'Hello first file';
      const start = read.source.text.indexOf(quote);
      assert.ok(start >= 0);
      const returned = await f.integration.text.respond(
        {
          requestId: record.requestId,
          operationId: randomUUID(),
          expectedTaskRevision: read.taskRevision,
          expectedProposalRevision: 0,
          baseRevision: read.source.source.revision,
          edits: [{ start, end: start + quote.length, expectedText: quote, replacement: `${quote} Updated.` }],
          response: 'Updated the queued Human quotation.',
        },
        f.cat,
      );
      assert.equal(
        await readFile(returned.candidatePath, 'utf8'),
        read.source.text.replace(quote, `${quote} Updated.`),
      );
      const candidate = await f.integration.text.candidate(record.requestId, returned.proposal.proposalRef, f.human);
      const accepted = await f.integration.writer.accept(
        {
          acceptOperationId: randomUUID(),
          requestId: record.requestId,
          candidateRef: returned.proposal.proposalRef,
          locator: candidate.source.locator,
          baseRevision: candidate.source.revision,
          bytes: candidate.bytes,
        },
        { userId: 'operator', editSessionToken: signEditToken(candidate.source.locator.worktreeId) },
      );
      assert.equal(accepted.state, 'applied');
      assert.notEqual(f.tasks.get(record.progress.task.taskId)?.status, 'done');
    } else if ('candidate' in f) {
      await f.candidate(record.requestId);
    }
    assert.equal(f.messages.getById(f.message.id)?.deliveryStatus, undefined);
    assert.deepEqual(f.messages.getById(f.message.id), before);
  });
}

for (const boundary of ['owner', 'thread', 'mention', 'whisper', 'recall', 'deleted', 'canceled', 'queued'] as const) {
  test(`delivered source ${boundary}: authority still fences takeover`, async (t) => {
    const f = await fixture(t);
    if (boundary === 'owner') f.message.userId = 'someone-else';
    if (boundary === 'thread') f.message.threadId = 'another-thread';
    if (boundary === 'mention') f.message.mentions = [];
    if (boundary === 'whisper') {
      f.message.visibility = 'whisper';
      f.message.whisperTo = [];
    }
    if (boundary === 'recall') f.message.recall = { version: 1, exposure: 'seen', recalledAt: Date.now() };
    if (boundary === 'deleted') f.messages.softDelete(f.message.id, 'operator');
    if (boundary === 'canceled') f.message.deliveryStatus = 'canceled';
    if (boundary === 'queued') f.message.deliveryStatus = 'queued';
    const result = await f.takeover();
    assert.equal(result.statusCode, 404, result.body);
    assert.equal(f.fileStore.get(f.reviewId), null);
    assert.equal(f.tasks.listByThread(f.thread.id).length, f.taskCount);
  });
}

test('source canceled during quote mapping is rejected before canonical review creation', async (t) => {
  const f = await fixture(t);
  const resolve = f.source.resolveRenderedTextSelections.bind(f.source);
  f.source.resolveRenderedTextSelections = async (input) => {
    const result = await resolve(input);
    f.message.deliveryStatus = 'canceled';
    return result;
  };
  const result = await f.takeover();
  assert.equal(result.statusCode, 404, result.body);
  assert.equal(f.fileStore.get(f.reviewId), null);
  assert.equal(f.tasks.listByThread(f.thread.id).length, f.taskCount);
});

test('undelivered source is unavailable even to an authenticated callback', async (t) => {
  const f = await fixture(t);
  f.message.deliveryStatus = 'queued';
  const result = await f.takeover();
  assert.equal(result.statusCode, 404, result.body);
  assert.equal(f.store.requests.get(modificationMessageRequestId('operator', f.message.id), 'operator'), null);
  assert.equal(f.fileStore.get(f.reviewId), null);
});

for (const boundary of ['owner', 'thread', 'recall', 'deleted', 'canceled', 'queued'] as const) {
  test(`committed request ${boundary}: journal does not replace current source authority`, async (t) => {
    const f = await fixture(t);
    const admitted = await f.takeover();
    assert.equal(admitted.statusCode, 200, admitted.body);
    if (boundary === 'owner') f.message.userId = 'someone-else';
    if (boundary === 'thread') f.message.threadId = 'another-thread';
    if (boundary === 'recall') f.message.recall = { version: 1, exposure: 'seen', recalledAt: Date.now() };
    if (boundary === 'deleted') f.messages.softDelete(f.message.id, 'operator');
    if (boundary === 'canceled') f.message.deliveryStatus = 'canceled';
    if (boundary === 'queued') f.message.deliveryStatus = 'queued';
    const replay = await f.takeover();
    assert.equal(replay.statusCode, 404, replay.body);
    await assert.rejects(f.integration.text.read(admitted.json().record.requestId, f.cat), /access_denied/);
  });
}
