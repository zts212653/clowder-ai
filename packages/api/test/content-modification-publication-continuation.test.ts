import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { mediaPublicationFixture as fixture } from './helpers/media-publication-fixture.js';

for (const mode of ['append', 'augment'] as const) {
  test(`one Human ${mode} publication automatically resumes the original Task and annotation responses`, async (t) => {
    const f = await fixture(t);
    const publication = f.publish(mode);
    await f.recover();
    assert.equal(
      f.carriers().length,
      1,
      `publication must create one durable platform continuation without Human resend: ${f.errors.map(String).join('; ')}`,
    );
    const carrier = f.carriers()[0]!;
    assert.equal(carrier.source?.meta?.sourceMessageId, f.humanMessage.id);
    assert.equal(carrier.source?.meta?.requestId, f.request.record.requestId);
    assert.equal(carrier.source?.meta?.taskId, f.request.record.progress.task?.taskId);
    assert.equal(carrier.source?.meta?.publicationMessageId, publication.id);
    assert.equal(carrier.visibility, 'whisper');
    assert.deepEqual(carrier.whisperTo, [createCatId('codex-astra')]);
    const childId = await f.dispatch.waitForAwakening(carrier.id);
    assert.notEqual(childId, f.child.invocationId, 'continuation has its own actual child');
    const auth = f.dispatch.credentials.get(childId);
    assert.ok(auth);
    const execution = (await f.integration.requests.read(f.request.record.requestId, f.human)).execution;
    assert.equal(execution?.state, 'running');
    assert.equal(execution?.invocationId, childId);
    assert.notEqual(execution?.invocationId, f.child.invocationId, 'old finished child must not cover new execution');
    const reviewId = f.request.record.progress.review!.reviewId;
    const read = await f.app.inject({
      method: 'POST',
      url: '/api/callbacks/artifact-review/read',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { reviewId, view: 'annotations' },
    });
    assert.equal(read.statusCode, 200, read.body);
    const view = await f.reviews.readCurrent(reviewId, f.cat);
    const round = view.review.rounds.at(-1)!;
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/callbacks/artifact-review/respond',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        requestId: f.request.record.requestId,
        reviewId,
        expectedRevision: view.review.revision,
        expectedTaskRevision: view.authority.taskRevision,
        expectedOwnerRevision: round.asset.ownerRevision,
        expectedLedgerRevision: round.ledgerRevision,
        operationId: randomUUID(),
        artifactRef: f.image.urlPath,
        expectedArtifactRevision: String(publication.timestamp),
        responses: round.annotations.map((annotation) => ({
          annotationId: annotation.id,
          disposition: 'addressed',
          explanation: '依据原圈选交回生成图。',
        })),
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    await f.recover();
    assert.equal(f.carriers().length, 1, 'candidate completion must not wake itself again');
    assert.equal(
      f.messages
        .getByThread(f.thread.id, 100, 'operator')
        .filter((message) => message.userId === 'operator' && message.catId === null && !message.source).length,
      1,
    );
  });
}

test('native upload copied before message persistence is recovered through the original request sweep', async (t) => {
  const f = await fixture(t);
  await f.recover();
  assert.equal(f.carriers().length, 1, 'durable native output must bridge upload-to-message loss');
  const messageId = f.carriers()[0]?.source?.meta?.publicationMessageId;
  assert.ok(messageId);
  assert.ok(f.messages.getById(messageId)?.extra?.rich?.blocks.some((block) => block.id === f.image.richBlock.id));
  await f.recover();
  assert.equal(f.carriers().length, 1);
});

test('publication return stays durable across an outbox-to-Queue failure and replay', async (t) => {
  const f = await fixture(t);
  f.publish('append');
  const deliver = f.dispatch.delivery.deliver.bind(f.dispatch.delivery);
  f.dispatch.delivery.deliver = async (input) => {
    if (input.source.meta?.kind === 'resume_media_publication') throw new Error('fixture_queue_unavailable');
    return deliver(input);
  };
  await f.recover();
  assert.equal(
    f.store.returns.pending().filter((intent) => String(intent.kind) === 'resume_media_publication').length,
    1,
  );
  assert.equal(f.carriers().length, 0);
  f.dispatch.delivery.deliver = deliver;
  await f.recover();
  await f.recover();
  assert.equal(f.carriers().length, 1, 'same binding must have one Queue winner');
});
