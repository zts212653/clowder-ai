import { afterEach, describe, it } from 'node:test';
import * as testFixture from './workspace-content-review-service.fixture.js';

const {
  WorkspaceContentReviewService,
  WorkspaceContentReviewStore,
  writeFile,
  principal,
  Database,
  fixture,
  locator,
  assert,
  join,
  sharp,
} = testFixture;
afterEach(testFixture.cleanupFixtureRoots);

describe('WorkspaceContentReviewService', () => {
  it('resolves up to 500 stale text anchors from one F063 snapshot with the view revision', async () => {
    const { root, source, reviews, store } = await fixture();
    try {
      const opened = await reviews.prepare({ principal, locator, operationId: 'open-batch-resolve' });
      await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: opened.review.revision,
        operationId: 'seed-batch-anchor',
        body: 'One anchor to clone into the bounded review fixture.',
        target: { kind: 'text_quote', quote: 'A unique source quote.' },
      });
      const seeded = store.get(opened.review.reviewId);
      if (!seeded?.annotations[0]) throw new Error('fixture must persist one text anchor');
      const anchor = seeded.annotations[0];
      store.mutate(
        {
          reviewId: seeded.reviewId,
          expectedRevision: seeded.revision,
          operationId: 'seed-499-more-anchors',
          actor: principal.actor,
          now: '2026-09-16T00:00:00.000Z',
          kind: 'seed',
          request: {},
        },
        (current) => ({
          ...current,
          revision: current.revision + 1,
          annotations: [
            ...current.annotations,
            ...Array.from({ length: 499 }, (_, index) => ({
              ...anchor,
              id: `batch-anchor-${index}`,
              operationId: `batch-operation-${index}`,
            })),
          ],
        }),
      );
      await writeFile(join(root, 'notes.md'), '# Notes\n\nA unique source quote.\n\nEdited after 500 anchors.\n');

      type BatchResult = { readonly source: { readonly revision: string } };
      type BatchResolver = { resolveTextQuotes: (input: unknown) => Promise<BatchResult> };
      const batchSource = source as unknown as BatchResolver;
      const originalResolve = batchSource.resolveTextQuotes.bind(batchSource);
      let calls = 0;
      let batchRevision = '';
      batchSource.resolveTextQuotes = async (input) => {
        calls += 1;
        const result = await originalResolve(input);
        batchRevision = result.source.revision;
        return result;
      };

      const view = await reviews.read({ principal, reviewId: opened.review.reviewId });
      assert.equal(calls, 1, 'a view must not fan out one owner read per stale annotation');
      assert.equal(view.annotationResolutions.length, 500);
      assert.equal(view.currentSource?.revision, batchRevision, 'the view must use the batch owner snapshot revision');
    } finally {
      store.close();
    }
  });

  it('keeps ordinary existing-ledger reopens out of durable aggregate snapshot storage', async () => {
    const { dbPath, reviews, store } = await fixture();
    try {
      const opened = await reviews.prepare({ principal, locator, operationId: 'create-for-reopen-storage' });
      await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: opened.review.revision,
        operationId: 'mutate-with-bounded-receipt',
        body: 'This mutation must not copy the aggregate into its operation receipt.',
        target: { kind: 'text_quote', quote: 'A unique source quote.' },
      });
      for (let index = 0; index < 101; index += 1)
        await reviews.prepare({ principal, locator, operationId: `ordinary-reopen-${index}` });

      const database = new Database(dbPath, { readonly: true });
      try {
        const receipts = database
          .prepare('SELECT COUNT(*) AS count FROM workspace_content_review_operation_receipts')
          .get() as { count: number };
        const snapshots = database
          .prepare('SELECT COUNT(*) AS count FROM workspace_content_review_operation_results')
          .get() as { count: number };
        assert.equal(receipts.count, 2, 'only mutations—not ordinary reopens—need bounded operation receipts');
        assert.equal(snapshots.count, 0, 'no newly-written operation row may copy the aggregate JSON');
      } finally {
        database.close();
      }
    } finally {
      store.close();
    }
  });

  it('rejects media anchors outside the owner immutable media dimensions', async () => {
    const { root, reviews, store } = await fixture();
    try {
      await writeFile(
        join(root, 'cover.png'),
        await sharp({ create: { width: 160, height: 100, channels: 3, background: '#eee4d5' } })
          .png()
          .toBuffer(),
      );
      const opened = await reviews.prepare({
        principal,
        locator: { worktreeId: 'worktree-a', path: 'cover.png' },
        operationId: 'open-bounded-cover',
      });
      await assert.rejects(
        reviews.annotate({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: opened.review.revision,
          operationId: 'outside-image-point',
          body: 'This must not persist.',
          target: { kind: 'media_anchor', anchor: { kind: 'image-point', x: 9_999, y: 9_999 } },
        }),
        /invalid_action/,
      );
    } finally {
      store.close();
    }
  });

  it('reopens the durable workspace ledger after an API restart without retaining source bytes', async () => {
    const { root, source, reviews, store } = await fixture();
    let restartedStore: WorkspaceContentReviewStore | null = null;
    try {
      const opened = await reviews.prepare({ principal, locator, operationId: 'open-for-restart' });
      await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: opened.review.revision,
        operationId: 'persist-before-restart',
        body: 'This annotation must survive the service restart.',
        target: { kind: 'text_quote', quote: 'A unique source quote.' },
      });
      store.close();
      restartedStore = new WorkspaceContentReviewStore(join(root, 'workspace-content-reviews.sqlite'));
      const restarted = new WorkspaceContentReviewService({
        store: restartedStore,
        source,
        now: () => '2026-09-16T00:00:01.000Z',
      });

      const readBack = await restarted.read({ principal, reviewId: opened.review.reviewId });
      assert.equal(readBack.sourceState, 'current');
      assert.equal(readBack.review.annotations[0]?.body, 'This annotation must survive the service restart.');
      assert.ok(JSON.stringify(readBack.review).includes('A unique source quote.'));
    } finally {
      restartedStore?.close();
    }
  });
});
