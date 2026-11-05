import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectiveContentScopeRef } from '../src/domains/video-studio/content-owner/collective-scope.js';
import { baseConstraint, digest, fixture, scope, text } from './collective-markdown.fixture.js';

test('independent Human constraints read identical owner bytes and one canonical review, with no Host identity in the projection', async (t) => {
  const f = await fixture(t);
  const a = await f.execute(baseConstraint);
  const b = await f.execute({ ...baseConstraint, humanId: 'human-bob', decisionRef: 'domain-allow:bob' });
  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'ok');
  if (a.status !== 'ok' || b.status !== 'ok') throw new Error('Expected admitted owner reads');
  assert.equal(a.value.text, text);
  assert.equal(b.value.text, text);
  assert.deepEqual(a.value.view, b.value.view);
  assert.equal(JSON.stringify(a).includes('real-local-owner'), false);
  const denied = await f.execute({ ...baseConstraint, sourceEventId: 'unrelated-source' });
  assert.equal(denied.status, 'error');
  assert.equal(JSON.stringify(denied).includes('shared quote'), false);
});

test('shared annotations use the actual Human, exact public discussion and F309 ledger receipt', async (t) => {
  const f = await fixture(t);
  const command = {
    kind: 'annotate',
    messageEventId: 'event-feedback',
    body: 'Please make this clearer.',
    quote: 'A unique shared quote.',
    location: { channelId: 'general', rootEventId: scope.sourceEventId },
    expectedReviewRevision: 1,
  };
  const constraint = {
    ...baseConstraint,
    action: 'annotate',
    humanId: 'human-bob',
    decisionRef: 'domain-allow:bob-annotation',
  } as const;
  const first = await f.execute(constraint, command, 'annotate-bob');
  assert.equal(first.status, 'ok', f.errors.map(String).join('\n'));
  if (first.status !== 'ok') throw new Error('Expected annotation');
  const source = f.reviews.getByContent('real-local-owner', scope.contentRef, collectiveContentScopeRef(scope));
  assert.equal(source?.annotations.length, 1);
  assert.deepEqual(source?.annotations[0]?.author, { kind: 'human', actorId: 'human-bob' });
  assert.equal(source?.annotations[0]?.collectiveMessage?.eventId, 'event-feedback');
  const replay = await f.execute(constraint, command, 'annotate-bob');
  assert.equal(replay.status, 'ok');
  assert.equal(f.reviews.get(source?.reviewId ?? '')?.annotations.length, 1);
  let allowed = false;
  const operation = {
    relayRef: 'relay-revoked',
    requestId: 'annotate-bob',
    constraint,
    payload: command,
    expiresAt: Date.now() + 10000,
  };
  const revoked = await f.port.execute(operation, {
    reauthorize: async () => {
      if (!allowed) throw new Error('revoked');
      return constraint;
    },
  });
  assert.equal(revoked.status, 'error');
  allowed = true;
});

test('owner read pages a large existing discussion inside the relay response limit', async (t) => {
  const f = await fixture(t);
  await f.execute(
    { ...baseConstraint, action: 'annotate' },
    {
      kind: 'annotate',
      messageEventId: 'event-feedback',
      body: 'Comment',
      quote: 'A unique shared quote.',
      location: { channelId: 'general', rootEventId: scope.sourceEventId },
      expectedReviewRevision: 1,
    },
    'seed-annotation',
  );
  const review = f.reviews.getByContent('real-local-owner', scope.contentRef, collectiveContentScopeRef(scope));
  const annotation = review?.annotations[0];
  if (!review || !annotation) throw new Error('Expected canonical seed annotation');
  f.reviews.mutate(
    {
      reviewId: review.reviewId,
      expectedRevision: review.revision,
      operationId: 'fixture-large-discussion',
      actor: { kind: 'human', actorId: 'human-alice' },
      now: new Date().toISOString(),
      kind: 'fixture',
      request: {},
    },
    (current) => ({
      ...current,
      revision: current.revision + 1,
      annotations: Array.from({ length: 30 }, (_, index) => ({
        ...annotation,
        id: `annotation-${index}`,
        body: '字'.repeat(8000),
        replies: Array.from({ length: 3 }, (_, reply) => ({
          id: `reply-${reply}`,
          body: '字'.repeat(8000),
          author: annotation.author,
          createdAt: annotation.createdAt,
          updatedAt: annotation.updatedAt,
        })),
      })),
    }),
  );
  const result = await f.execute(baseConstraint);
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') throw new Error('Expected bounded read');
  assert.ok(Buffer.byteLength(JSON.stringify(result.value)) <= 192 * 1024);
});

test('escaped Markdown is transferred exactly in bounded JSON pages tied to one owner snapshot', async (t) => {
  const f = await fixture(t);
  const large = '\u0001'.repeat(63000);
  const receipt = await f.owner.settle({
    contentRef: scope.contentRef,
    expectedOwnerRevision: 1,
    bytes: Buffer.from(large),
    actor: { kind: 'human', actorId: 'human-alice' },
    operationId: 'fixture-large-source',
    authorizeEffect: async () => {},
    operationContext: {
      kind: 'collective-artifact:apply',
      actorHumanId: 'human-alice',
      scopeRef: collectiveContentScopeRef(scope),
      custodyRevision: 1,
      dispositionId: 'fixture-large-source',
      requestDigest: digest,
    },
  });
  const constraint = { ...baseConstraint, ownerRevision: receipt.ownerRevision, blobDigest: receipt.blobDigest };
  let cursor = 0;
  let snapshot: string | undefined;
  let serialized = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await f.execute(
      constraint,
      { cursor, ...(snapshot ? { expectedSnapshot: snapshot } : {}) },
      `read-large-${cursor}`,
    );
    assert.equal(response.status, 'ok', JSON.stringify(response));
    if (response.status !== 'ok') throw new Error('Expected a content page');
    assert.ok(Buffer.byteLength(JSON.stringify(response.value)) <= 192 * 1024);
    assert.equal(response.value.encoding, 'json-text-chunk');
    assert.equal(typeof response.value.json, 'string');
    assert.equal(typeof response.value.snapshot, 'string');
    if (typeof response.value.json !== 'string' || typeof response.value.snapshot !== 'string')
      throw new Error('Missing JSON page');
    serialized += response.value.json;
    snapshot ??= response.value.snapshot;
    assert.equal(response.value.snapshot, snapshot);
    if (response.value.nextCursor === null) break;
    assert.equal(typeof response.value.nextCursor, 'number');
    cursor = Number(response.value.nextCursor);
  }
  assert.equal((JSON.parse(serialized) as { text: string }).text, large);
  const historical = await f.execute({ ...baseConstraint, catalogueOwnerRevision: 2 }, {}, 'read-historical-version');
  assert.equal(historical.status, 'ok');
  if (historical.status !== 'ok') throw new Error('Expected historical owner read');
  const historicalView = historical.value.view as { canWrite: boolean; historyReadOnly: boolean };
  assert.equal(historicalView.historyReadOnly, true);
  assert.equal(historicalView.canWrite, false);
  const stale = await f.execute(
    constraint,
    { cursor: 6000, expectedSnapshot: `sha256:${'0'.repeat(64)}` },
    'wrong-snapshot',
  );
  assert.deepEqual(stale, { status: 'error', error: { code: 'conflict' } });
});
