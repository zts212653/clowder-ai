import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { CliRawArchive } from '../src/domains/cats/services/session/CliRawArchive.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { mediaPublicationFixture as fixture } from './helpers/media-publication-fixture.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function candidate(
  f: Fixture,
  invocationId: string,
  artifactRef = f.image.urlPath,
  extraPayload: Record<string, unknown> = {},
) {
  const credentials = f.dispatch.credentials.get(invocationId);
  assert.ok(credentials);
  const publication = f.messages.getById(String(f.carriers()[0]?.source?.meta?.publicationMessageId));
  assert.ok(publication);
  const review = f.store.get(f.request.record.progress.review!.reviewId)!;
  const round = review.rounds.at(-1)!;
  return f.app.inject({
    method: 'POST',
    url: '/api/callbacks/artifact-review/respond',
    headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
    payload: {
      requestId: f.request.record.requestId,
      reviewId: review.reviewId,
      expectedRevision: review.revision,
      expectedTaskRevision: review.task.observedRevision,
      expectedOwnerRevision: round.asset.ownerRevision,
      expectedLedgerRevision: round.ledgerRevision,
      artifactRef,
      expectedArtifactRevision: String(publication.timestamp),
      operationId: randomUUID(),
      responses: round.annotations.map((annotation) => ({
        annotationId: annotation.id,
        disposition: 'addressed',
        explanation: '按原批注交回。',
      })),
      ...extraPayload,
    },
  });
}

for (const boundary of ['recalled-source', 'changed-source', 'corrupt-upload', 'cancelled-request'] as const) {
  test(`native publication ${boundary} cannot dispatch a continuation`, async (t) => {
    const f = await fixture(t);
    f.publish('append');
    if (boundary === 'recalled-source') f.humanMessage._tombstone = true;
    if (boundary === 'changed-source') f.humanMessage.content += ' changed';
    if (boundary === 'corrupt-upload') await writeFile(f.image.absPath, 'changed bytes');
    if (boundary === 'cancelled-request') await f.integration.requests.cancel(f.request.record.requestId, f.human);
    await f.recover();
    assert.equal(f.carriers().length, 0);
  });
}

test('an already returned candidate does not trigger another native publication continuation', async (t) => {
  const f = await fixture(t);
  f.publish('append');
  await f.candidate(f.request.record.requestId);
  await f.recover();
  assert.equal(f.carriers().length, 0);
});

test('cancellation during routing preflight prevents the platform return from actually sending', async (t) => {
  const f = await fixture(t);
  f.publish('append');
  const authorize = f.targets.authorizeDelivery.bind(f.targets);
  f.targets.authorizeDelivery = async (intent) => {
    if (intent.kind === 'resume_media_publication')
      await f.integration.requests.cancel(f.request.record.requestId, f.human);
    return authorize(intent);
  };
  await f.recover();
  assert.ok(f.store.requests.get(f.request.record.requestId, 'operator')?.control);
  assert.equal(f.carriers().length, 0);
});

test('concurrent recovery and a fresh outbox reader retain one exact publication binding', async (t) => {
  const f = await fixture(t);
  f.publish('append');
  await Promise.all([f.recover(), f.recover(), f.recover()]);
  assert.equal(f.carriers().length, 1);
  const reopened = new ArtifactReviewStore(join(f.root, 'collaborative-content', 'artifact-reviews.sqlite'));
  try {
    assert.deepEqual(
      reopened.returns.publicationForRequest(f.request.record.requestId),
      f.store.returns.publicationForRequest(f.request.record.requestId),
    );
  } finally {
    reopened.close();
  }
});

test('recovery augments a persisted producer message instead of copying its publication', async (t) => {
  const f = await fixture(t);
  const bare = f.publish('bare');
  await f.recover();
  assert.equal(f.carriers().length, 1);
  assert.equal(f.carriers()[0]?.source?.meta?.publicationMessageId, bare.id);
  assert.ok(f.messages.getById(bare.id)?.extra?.rich?.blocks.some((block) => block.id === f.image.richBlock.id));
});

test('two publication messages for the same proven native image remain one continuation', async (t) => {
  const f = await fixture(t);
  const first = f.publish('append');
  const second = f.publish('append');
  assert.notEqual(first.id, second.id);
  await f.recover();
  assert.equal(f.carriers().length, 1, f.errors.map(String).join('; '));
  const carrier = f.carriers()[0]!;
  assert.ok([first.id, second.id].includes(String(carrier.source?.meta?.publicationMessageId)));
  const childId = await f.dispatch.waitForAwakening(carrier.id);
  const result = await candidate(f, childId);
  assert.equal(result.statusCode, 200, result.body);
  await f.recover();
  assert.equal(f.carriers().length, 1);
});

test('a reference image beside the proven native output does not make its generation ambiguous', async (t) => {
  const f = await fixture(t);
  f.image.richBlock.items = [{ url: '/uploads/review-input.png' }, ...f.image.richBlock.items];
  const publication = f.publish('append');
  await f.recover();
  assert.equal(f.carriers().length, 1, f.errors.map(String).join('; '));
  const carrier = f.carriers()[0]!;
  assert.equal(carrier.source?.meta?.publicationMessageId, publication.id);
  assert.equal(carrier.source?.meta?.artifactRef, f.image.urlPath);
  const childId = await f.dispatch.waitForAwakening(carrier.id);
  const referenceResponse = await candidate(f, childId, '/uploads/review-input.png');
  assert.notEqual(referenceResponse.statusCode, 200, 'gallery reference does not acquire native output authority');
  const result = await candidate(f, childId);
  assert.equal(result.statusCode, 200, result.body);
});

test('a callback cannot supply the server-derived publication selector', async (t) => {
  const f = await fixture(t);
  f.publish('append');
  await f.recover();
  const childId = await f.dispatch.waitForAwakening(f.carriers()[0]!.id);
  const before = f.store.get(f.request.record.progress.review!.reviewId)!.revision;
  const result = await candidate(f, childId, f.image.urlPath, { publicationSource: { messageId: 'borrowed-message' } });
  assert.equal(result.statusCode, 400, result.body);
  assert.equal(f.store.get(f.request.record.progress.review!.reviewId)!.revision, before);
  assert.equal(f.store.pendingVersion(f.request.record.progress.review!.reviewId), null);
});

test('accepted exact publication survives owner failure without read-authorized execution after its child ends', async (t) => {
  const f = await fixture(t);
  const first = f.publish('append');
  const second = f.publish('append');
  await f.recover();
  const childId = await f.dispatch.waitForAwakening(f.carriers()[0]!.id);
  const reviewId = f.request.record.progress.review!.reviewId;
  const publish = f.media.publishVersion.bind(f.media);
  f.media.publishVersion = async () => {
    throw new Error('fixture_owner_unavailable');
  };
  const failed = await candidate(f, childId);
  assert.equal(failed.statusCode, 500, failed.body);
  const pending = f.store.pendingVersion(reviewId);
  assert.ok(pending);
  assert.ok(typeof pending.payload === 'object' && pending.payload !== null && 'publicationSource' in pending.payload);
  f.dispatch.turns.transitionTerminal(childId, {
    status: 'succeeded',
    terminalReason: 'fixture_response_lost',
    endedAt: Date.now(),
  });
  f.media.publishVersion = publish;
  const recovered = await f.reviews.read(reviewId, f.human);
  assert.equal(recovered.review.rounds.at(-1)?.asset.ownerRevision, 1);
  assert.deepEqual(f.store.pendingVersion(reviewId), pending);
  const source = pending.payload.publicationSource as { messageId: string };
  assert.ok([first.id, second.id].includes(source.messageId));
  assert.equal(f.carriers().length, 1);
});

for (const boundary of ['old-child', 'withdrawn-return-source', 'other-image', 'cancelled-request'] as const) {
  test(`publication candidate ${boundary} cannot borrow the current continuation`, async (t) => {
    const f = await fixture(t);
    f.publish('append');
    await f.recover();
    assert.equal(f.carriers().length, 1, f.errors.map(String).join('; '));
    const carrier = f.carriers()[0]!;
    const childId = await f.dispatch.waitForAwakening(carrier.id);
    const before = f.store.get(f.request.record.progress.review!.reviewId)!.revision;
    if (boundary === 'withdrawn-return-source') f.messages.getById(carrier.id)!._tombstone = true;
    if (boundary === 'cancelled-request') await f.integration.requests.cancel(f.request.record.requestId, f.human);
    const result = await candidate(
      f,
      boundary === 'old-child' ? f.child.invocationId : childId,
      boundary === 'other-image' ? '/uploads/review-input.png' : f.image.urlPath,
    );
    assert.notEqual(result.statusCode, 200, result.body);
    assert.equal(f.store.get(f.request.record.progress.review!.reviewId)!.revision, before);
    assert.equal(f.store.pendingVersion(f.request.record.progress.review!.reviewId), null);
  });
}

test('cancellation selects the new running child and refuses the old finished child', async (t) => {
  const f = await fixture(t);
  f.publish('append');
  await f.recover();
  const carrier = f.carriers()[0]!;
  const childId = await f.dispatch.waitForAwakening(carrier.id);
  const child = f.dispatch.turns.get(childId)!;
  await f.integration.requests.cancel(f.request.record.requestId, f.human);
  await assert.rejects(
    f.integration.runtimeControls.confirm(
      f.request.record.requestId,
      { kind: 'stop_execution', invocationId: f.child.invocationId, executionId: f.child.parentInvocationId },
      f.human,
    ),
  );
  const receipt = await f.integration.runtimeControls.confirm(
    f.request.record.requestId,
    { kind: 'stop_execution', invocationId: childId, executionId: child.parentInvocationId },
    f.human,
  );
  assert.deepEqual(receipt.target, {
    kind: 'stop_execution',
    invocationId: childId,
    executionId: child.parentInvocationId,
  });
  assert.equal(
    (await f.integration.requests.read(f.request.record.requestId, f.human)).execution?.invocationId,
    childId,
  );
});

test('delivered multi-recipient Human remains independent of the exact derived continuation', async (t) => {
  const f = await fixture(t, true);
  await f.markOriginalHandled();
  f.publish('append');
  await f.recover();
  assert.equal(f.carriers().length, 1, f.errors.map(String).join('; '));
  const childId = await f.dispatch.waitForAwakening(f.carriers()[0]!.id);
  const control = await f.integration.requests.controlForCat(f.request.record.requestId, {
    ...f.cat,
    invocationId: childId,
  });
  assert.equal(control.stage, 'active');
  const response = await candidate(f, childId);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(f.messages.getById(f.humanMessage.id)?.deliveryStatus, undefined);
  assert.equal(Object.hasOwn(f.messages.getById(f.humanMessage.id)!, 'queueCustody'), false);
});

for (const boundary of ['no-current-child', 'withdrawn-return-source'] as const) {
  test(`same-owner control projection stays independent of ${boundary}`, async (t) => {
    const f = await fixture(t, true);
    await f.markOriginalHandled();
    f.publish('append');
    await f.recover();
    const carrier = f.carriers()[0]!;
    const childId = await f.dispatch.waitForAwakening(carrier.id);
    if (boundary === 'withdrawn-return-source') f.messages.getById(carrier.id)!._tombstone = true;
    const control = await f.integration.requests.controlForCat(
      f.request.record.requestId,
      boundary === 'no-current-child' ? f.cat : { ...f.cat, invocationId: childId },
    );
    assert.equal(control.stage, 'active', 'Business control reads do not adopt an input or grant callback execution');
  });
}

test('multiple native images report their ambiguity once without selecting or waking a candidate', async (t) => {
  const f = await fixture(t);
  const sourcePath = join(f.nativeRoot, 'codex', 'generated_images', 'native-publication-session', 'second-image.png');
  const bytes = await readFile(f.sourcePath);
  await writeFile(sourcePath, bytes);
  await new CliRawArchive({ archiveDir: join(f.nativeRoot, 'raw') }).append(f.child.invocationId, {
    transport: 'codex_app_server',
    direction: 'inbound',
    envelope: {
      method: 'item/completed',
      params: {
        threadId: 'native-publication-session',
        turnId: 'native-producing-turn',
        item: {
          type: 'imageGeneration',
          id: 'second-image',
          status: 'completed',
          failure: null,
          savedPath: sourcePath,
          result: bytes.toString('base64'),
        },
      },
    },
  });
  f.publish('append');
  await f.recover();
  await f.recover();
  assert.equal(f.carriers().length, 0);
  const notices = f.messages
    .getByThread(f.thread.id, 100, 'operator')
    .filter((message) => message.source?.meta?.kind === 'generated_media_ambiguity');
  assert.equal(notices.length, 1, 'owner must see the ambiguity instead of a silent refusal');
  assert.equal(notices[0]?.source?.meta?.requestId, f.request.record.requestId);
  assert.equal(notices[0]?.visibility, 'whisper');
  assert.deepEqual(notices[0]?.mentions, []);
});
