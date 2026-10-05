import { afterEach, describe, it } from 'node:test';
import * as testFixture from './workspace-content-review-service.fixture.js';

const { workspaceTextDigest, writeFile, principal, fixture, locator, assert, join, sharp } = testFixture;
afterEach(testFixture.cleanupFixtureRoots);

describe('WorkspaceContentReviewService', () => {
  it('marks text annotations honestly after a source revision changes, then requires explicit refresh', async () => {
    const { root, reviews, store } = await fixture();
    try {
      const opened = await reviews.prepare({ principal, locator, operationId: 'open-notes' });
      await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: 1,
        operationId: 'comment-one',
        body: 'Keep this point.',
        target: { kind: 'text_quote', quote: 'A unique source quote.' },
      });
      await writeFile(join(root, 'notes.md'), '# Notes\n\nA unique source quote.\n\nNew surrounding context.\n');

      const stale = await reviews.read({ principal, reviewId: opened.review.reviewId });
      assert.equal(stale.sourceState, 'changed');
      assert.equal(stale.canWrite, false);
      assert.equal(stale.annotationResolutions[0]?.status, 'orphaned');

      const refreshed = await reviews.refresh({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: stale.review.revision,
        operationId: 'refresh-source',
      });
      assert.equal(refreshed.sourceState, 'current');
      assert.equal(refreshed.canWrite, true);
      assert.equal(refreshed.review.source.revision, refreshed.currentSource?.revision);

      const retried = await reviews.refresh({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: stale.review.revision,
        operationId: 'refresh-source',
      });
      assert.equal(
        retried.review.revision,
        refreshed.review.revision,
        'a retried refresh must replay instead of conflicting',
      );
    } finally {
      store.close();
    }
  });

  it('persists raw source quote evidence without applying comment-body trimming', async () => {
    const { root, reviews, store } = await fixture();
    const quote = ' target ';
    const sourceText = `${'P'.repeat(100)}${quote}${'S'.repeat(100)}`;
    try {
      await writeFile(join(root, 'notes.md'), sourceText);
      const opened = await reviews.prepare({ principal, locator, operationId: 'open-raw-quote' });
      const annotated = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: opened.review.revision,
        operationId: 'raw-quote-annotation',
        body: 'Keep the source quote exactly as selected.',
        target: { kind: 'text_quote', quote },
      });
      const anchor = annotated.review.annotations[0]?.anchor;
      if (!anchor || anchor.kind !== 'text_quote') throw new Error('fixture must create a text quote anchor');
      assert.equal(anchor.quote, quote);
      assert.equal(anchor.quoteDigest, workspaceTextDigest(quote));

      await writeFile(join(root, 'notes.md'), `${sourceText} changed beyond the anchor context window`);
      const stale = await reviews.read({ principal, reviewId: opened.review.reviewId });
      assert.equal(stale.sourceState, 'changed');
      assert.equal(stale.annotationResolutions[0]?.status, 'moved');
    } finally {
      store.close();
    }
  });

  it('keeps ordinary PNG annotations outside the Task review aggregate and orphans them on a new source revision', async () => {
    const { root, reviews, store } = await fixture();
    try {
      const original = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#eee4d5' } })
        .png()
        .toBuffer();
      await writeFile(join(root, 'cover.png'), original);
      const mediaLocator = { worktreeId: 'worktree-a', path: 'cover.png' };
      const opened = await reviews.prepare({ principal, locator: mediaLocator, operationId: 'open-cover' });
      assert.equal(opened.review.source.kind, 'media');
      assert.equal(opened.review.task, undefined);

      const annotated = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: opened.review.revision,
        operationId: 'pin-cover',
        body: 'Move this point slightly left.',
        target: { kind: 'media_anchor', anchor: { kind: 'image-point', x: 32, y: 48 } },
      });
      assert.equal(annotated.review.annotations.length, 1);

      const replacement = await sharp({ create: { width: 320, height: 200, channels: 3, background: '#a0563d' } })
        .png()
        .toBuffer();
      await writeFile(join(root, 'cover.png'), replacement);
      const stale = await reviews.read({ principal, reviewId: opened.review.reviewId });
      assert.equal(stale.sourceState, 'changed');
      assert.equal(stale.annotationResolutions[0]?.status, 'orphaned');
      assert.equal(stale.canWrite, false);

      const refreshed = await reviews.refresh({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: stale.review.revision,
        operationId: 'refresh-cover',
      });
      const historical = refreshed.review.sourceHistory?.find(
        (source) => source.revision === opened.review.source.revision,
      );
      assert.equal(historical?.kind, 'media');
      if (historical?.kind === 'media') assert.deepEqual(historical.media, { kind: 'image', width: 160, height: 100 });
      assert.equal(refreshed.review.source.kind, 'media');
      if (refreshed.review.source.kind === 'media') {
        assert.deepEqual(refreshed.review.source.media, { kind: 'image', width: 320, height: 200 });
      }
    } finally {
      store.close();
    }
  });

  it('records a no-op refresh so an unknown write retry cannot later advance to a new source revision', async () => {
    const { root, reviews, store } = await fixture();
    try {
      const opened = await reviews.prepare({ principal, locator, operationId: 'open-noop-refresh' });
      const first = await reviews.refresh({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: opened.review.revision,
        operationId: 'unknown-refresh-result',
      });
      assert.equal(first.review.revision, 1);
      await writeFile(join(root, 'notes.md'), '# Notes\n\nA replacement source quote.\n');

      const retry = await reviews.refresh({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: opened.review.revision,
        operationId: 'unknown-refresh-result',
      });
      assert.equal(retry.review.revision, 1);
      assert.equal(retry.review.source.revision, opened.review.source.revision);
    } finally {
      store.close();
    }
  });

  it('replays a prepare operation after an unknown response instead of rebinding it to a changed source', async () => {
    const { root, reviews, store } = await fixture();
    try {
      const opened = await reviews.prepare({ principal, locator, operationId: 'unknown-prepare-result' });
      await writeFile(join(root, 'notes.md'), '# Notes\n\nA replacement source quote.\n');

      const retry = await reviews.prepare({ principal, locator, operationId: 'unknown-prepare-result' });
      assert.equal(retry.review.reviewId, opened.review.reviewId);
      assert.equal(retry.review.source.revision, opened.review.source.revision);
      assert.equal(retry.sourceState, 'changed');
    } finally {
      store.close();
    }
  });

  it('treats an existing-ledger reopen as a read when its response is lost and retried', async () => {
    const { root, reviews, store } = await fixture();
    try {
      const opened = await reviews.prepare({ principal, locator, operationId: 'create-ledger-before-reopen' });
      const firstOpen = await reviews.prepare({ principal, locator, operationId: 'lost-existing-reopen' });
      await writeFile(join(root, 'notes.md'), '# Notes\n\nA replacement source quote.\n');

      const retry = await reviews.prepare({ principal, locator, operationId: 'lost-existing-reopen' });
      assert.equal(retry.review.reviewId, firstOpen.review.reviewId);
      assert.equal(retry.review.source.revision, opened.review.source.revision);
      assert.equal(retry.sourceState, 'changed');
    } finally {
      store.close();
    }
  });
});
