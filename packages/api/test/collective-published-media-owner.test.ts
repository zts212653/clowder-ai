import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { readRetainedWorkspaceReview } from '../src/domains/collaborative-content/workspace-review/workspace-review-retained-source.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { mediaValue, publishedCollectiveFixture } from './collective-published-media.fixture.js';

// Constraints in this owner slice are authorizer fixtures, not proof of two authenticated Human sessions.
for (const mime of ['image/png', 'video/mp4'])
  test(`explicit sharing reads retained ${mime} for independent authorized subjects without leaking private origin`, async (t) => {
    const f = await publishedCollectiveFixture(t, mime);
    assert.equal((await f.execute('alice')).status, 'error', 'A Service tuple alone cannot admit private media');
    const share = await f.share();
    assert.equal(share.contentRef, f.asset.contentRef);
    assert.equal(share.blobDigest, f.asset.blobDigest);
    assert.equal('sourcePublication' in share, false);
    const alice = mediaValue(await f.execute('alice'));
    const bob = mediaValue(await f.execute('bob'));
    assert.equal(alice.blobDigest, bob.blobDigest);
    assert.deepEqual(alice.media, f.asset.media);
    assert.equal(JSON.stringify([alice, bob]).includes('thread-cover'), false);
    assert.equal(JSON.stringify([alice, bob]).includes('/uploads'), false);
    assert.equal(JSON.stringify([alice, bob]).includes('operator'), false);
    assert.deepEqual(
      await f.media.bytes(f.asset.contentRef, 1, { userId: 'operator', actor: { kind: 'human', actorId: 'operator' } }),
      f.bytes,
    );
    assert.equal((await f.owner.listOutbox(f.asset.contentRef)).length, 1);
    f.reopen();
    assert.equal(mediaValue(await f.execute('bob')).view.review.reviewId, bob.view.review.reviewId);
    f.revoked.add('alice');
    assert.equal((await f.execute('alice')).status, 'error');
    assert.equal((await f.execute('bob')).status, 'ok');
    for (const drift of [
      { collectiveId: 'other' },
      { sourceEventId: 'other' },
      { custodyRevision: 2 },
      { blobDigest: `sha256:${'0'.repeat(64)}` },
    ])
      assert.equal((await f.execute('bob', 'read', {}, 'forged', f.asset, drift)).status, 'error');
    const source = f.messages.get(f.asset.sourcePublication.sourceRef.split(':').at(-1) ?? '');
    assert.ok(source);
    source.recall = { recalledAt: 9999, recalledBy: 'operator' };
    assert.equal((await f.execute('bob')).status, 'error');
  });

test('public catalogue labels and raw local/upload pointers do not turn into an admitted media object', async (t) => {
  const f = await publishedCollectiveFixture(t);
  for (const contentRef of ['/uploads/cover.png', `${f.root}/uploads/cover.png`, 'f063:cover'])
    await assert.rejects(f.share({ ...f.asset, contentRef }));
  await f.share();
  for (const action of ['propose', 'preview', 'apply', 'cancel', 'reject'] as const)
    assert.deepEqual(await f.execute('alice', action), { status: 'error', error: { code: 'unsupported_operation' } });
  await assert.rejects(
    f.media.read(f.asset.contentRef, 1, { userId: 'bob', actor: { kind: 'human', actorId: 'bob' } }),
    /access_denied/,
  );
  const otherScope = { ...f.scope, collectiveId: 'other' };
  await f.share(f.asset, otherScope);
  const first = mediaValue(await f.execute('alice'));
  const second = mediaValue(await f.execute('alice', 'read', {}, 'other-world', f.asset, { collectiveId: 'other' }));
  assert.notEqual(first.view.review.reviewId, second.view.review.reviewId);
});

test('the original private review and retained-source services cannot consume a Collective media ledger', async (t) => {
  const f = await publishedCollectiveFixture(t);
  await f.share();
  const view = mediaValue(await f.execute('alice'));
  const review = f.reviews.get(view.view.review.reviewId);
  assert.ok(review);
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => {
      throw new Error('A Collective source must never reach a private file resolver');
    },
  });
  const privateReviews = new WorkspaceContentReviewService({ store: f.reviews, source });
  for (const userId of ['operator', 'alice']) {
    const principal = { userId, actor: { kind: 'human' as const, actorId: userId } };
    await assert.rejects(privateReviews.read({ reviewId: review.reviewId, principal }), /access_denied/);
    await assert.rejects(readRetainedWorkspaceReview({ source }, principal, review), /access_denied/);
  }
});

test('an actually retained JPEG cannot borrow the PNG catalogue label to pass the media allowlist', async (t) => {
  const f = await publishedCollectiveFixture(t, 'image/jpeg');
  assert.equal(f.asset.mediaType, 'image/jpeg');
  await assert.rejects(f.share(), /unsupported_content/);
  assert.deepEqual(await f.execute('alice'), { status: 'error', error: { code: 'access_denied' } });
});

for (const action of ['read', 'annotate'] as const)
  test(`a revoke during the original owner probe denies ${action} before content disclosure or a ledger write`, async (t) => {
    const f = await publishedCollectiveFixture(t);
    await f.share();
    const describe = f.media.describe.bind(f.media);
    f.media.describe = async (...args) => {
      const result = await describe(...args);
      f.revoked.add('alice');
      return result;
    };
    const payload =
      action === 'annotate'
        ? {
            kind: 'media-review',
            expectedReviewRevision: 1,
            action: { kind: 'annotate', body: 'should never commit', anchor: { kind: 'image-point', x: 1, y: 1 } },
          }
        : {};
    assert.deepEqual(await f.execute('alice', action, payload, 'revoked-during-probe'), {
      status: 'error',
      error: { code: 'access_denied' },
    });
    const retained = mediaValue(await f.execute('bob'));
    assert.equal(retained.view.review.revision, 1);
    assert.equal(retained.view.review.annotations.length, 0);
  });
