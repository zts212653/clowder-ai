import { afterEach, describe, it } from 'node:test';
import * as testFixture from './workspace-content-review-service.fixture.js';

const {
  WorkspaceContentReviewService,
  WorkspaceContentSourceService,
  workspaceContentReviewSchema,
  appendWorkspaceSourceHistory,
  WorkspaceContentReviewStore,
  toWorkspaceReviewSource,
  workspaceReviewIdentity,
  writeFile,
  principal,
  mkdtemp,
  fixture,
  locator,
  assert,
  roots,
  join,
  tmpdir,
} = testFixture;
afterEach(testFixture.cleanupFixtureRoots);

describe('WorkspaceContentReviewService', () => {
  it('retains the current source and every referenced source snapshot when bounded history is saturated', () => {
    const source = (index: number) => ({
      kind: 'media' as const,
      locator,
      revision: `sha256:${index.toString(16).padStart(64, '0')}`,
      mime: 'image/png' as const,
      byteLength: 12,
      media: { kind: 'image' as const, width: 160, height: 100 },
    });
    const history = Array.from({ length: 512 }, (_, index) => source(index + 1));
    const protectedSource = history[0];
    if (!protectedSource) throw new Error('fixture must contain the protected source');
    const review = workspaceContentReviewSchema.parse({
      version: 1 as const,
      reviewId: 'history-review',
      ownerUserId: 'operator',
      contentRef: 'workspace-content:history',
      source: protectedSource,
      sourceHistory: history,
      revision: 2,
      annotations: history.slice(0, 256).map((snapshot, index) => ({
        id: `protected-annotation-${index}`,
        anchor: {
          baseRevision: snapshot.revision,
          anchor: { kind: 'image-point' as const, x: index % 160, y: index % 100 },
        },
        body: `protect annotation source ${index}`,
        author: principal.actor,
        createdAt: '2026-09-18T00:00:00.000Z',
        updatedAt: '2026-09-18T00:00:00.000Z',
        state: 'open' as const,
      })),
      visualMarks: history.slice(256).map((snapshot, index) => ({
        drawing: {
          id: `protected-mark-${index}`,
          kind: 'rectangle' as const,
          x: index % 112,
          y: index % 52,
          width: 48,
          height: 30,
          color: '#d04a3a' as const,
          strokeWidth: 4 as const,
        },
        baseRevision: snapshot.revision,
        author: principal.actor,
        createdAt: '2026-09-18T00:00:00.000Z',
        state: 'active' as const,
      })),
      createdAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:00:00.000Z',
    });
    const current = source(513);
    const next = appendWorkspaceSourceHistory(review, current);

    assert.equal(next.length, 513);
    for (const snapshot of [...history, current]) assert.ok(next.some((item) => item.revision === snapshot.revision));
    assert.doesNotThrow(() => workspaceContentReviewSchema.parse({ ...review, source: current, sourceHistory: next }));
  });

  it('projects a legacy scoped locator through F063 canonical identity without rewriting the aggregate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f309-workspace-review-legacy-locator-'));
    roots.push(root);
    await writeFile(join(root, 'notes.md'), '# Notes\n\nA unique source quote.\n');
    const legacyLocator = { worktreeId: 'a1b2c3_worktree-a', path: 'notes.md' };
    const canonicalWorktreeId = 'worktree-a';
    const source = new WorkspaceContentSourceService({
      ownerUserId: 'operator',
      resolveWorktreeRoot: async (worktreeId) => {
        if (worktreeId !== legacyLocator.worktreeId) throw new Error('unknown worktree');
        return { root, canonicalWorktreeId };
      },
    });
    const description = await source.describe({ principal: { userId: 'operator' }, locator: legacyLocator });
    const legacySource = {
      ...toWorkspaceReviewSource(description),
      locator: { ...legacyLocator },
    };
    const store = new WorkspaceContentReviewStore(join(root, 'workspace-content-reviews.sqlite'));
    const reviewId = workspaceReviewIdentity(principal.userId, description.contentRef);
    try {
      store.create(
        {
          version: 1,
          reviewId,
          ownerUserId: principal.userId,
          contentRef: description.contentRef,
          source: legacySource,
          sourceHistory: [legacySource],
          revision: 1,
          annotations: [],
          createdAt: '2026-09-17T00:00:00.000Z',
          updatedAt: '2026-09-17T00:00:00.000Z',
        },
        {
          operationId: 'legacy-source-fixture',
          actor: principal.actor,
          now: '2026-09-17T00:00:00.000Z',
          kind: 'prepare',
          request: { locator: legacyLocator },
        },
      );
      const before = store.get(reviewId);
      const reviews = new WorkspaceContentReviewService({ store, source });
      const view = await reviews.read({ principal, reviewId });

      assert.equal(view.sourceState, 'current');
      assert.deepEqual(view.currentSource?.locator, { worktreeId: canonicalWorktreeId, path: 'notes.md' });
      assert.deepEqual(store.get(reviewId), before, 'read must not silently migrate a durable review');
    } finally {
      store.close();
    }
  });

  it('persists the owner-canonical worktree locator for a new review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f309-workspace-review-canonical-locator-'));
    roots.push(root);
    await writeFile(join(root, 'notes.md'), '# Notes\n\nA unique source quote.\n');
    const discoveryLocator = { worktreeId: 'a1b2c3_worktree-a', path: 'notes.md' };
    const source = new WorkspaceContentSourceService({
      ownerUserId: 'operator',
      resolveWorktreeRoot: async (worktreeId) => {
        if (worktreeId !== discoveryLocator.worktreeId) throw new Error('unknown worktree');
        return { root, canonicalWorktreeId: 'worktree-a' };
      },
    });
    const store = new WorkspaceContentReviewStore(join(root, 'workspace-content-reviews.sqlite'));
    const reviews = new WorkspaceContentReviewService({ store, source });
    try {
      const opened = await reviews.prepare({
        principal,
        locator: discoveryLocator,
        operationId: 'canonical-locator-prepare',
      });
      assert.deepEqual(opened.review.source.locator, { worktreeId: 'worktree-a', path: 'notes.md' });
    } finally {
      store.close();
    }
  });

  it('persists task-free text annotation lineage with CAS and operation replay', async () => {
    const { reviews, store } = await fixture();
    try {
      const opened = await reviews.prepare({ principal, locator, operationId: 'open-notes' });
      assert.equal(opened.review.task, undefined, 'ordinary files must not acquire a Task aggregate');

      const first = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: opened.review.revision,
        operationId: 'comment-one',
        body: 'Please clarify this sentence.',
        target: { kind: 'text_quote', quote: 'A unique source quote.' },
      });
      assert.equal(first.review.annotations.length, 1);
      assert.equal(first.review.revision, 2);

      const replay = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: opened.review.revision,
        operationId: 'comment-one',
        body: 'Please clarify this sentence.',
        target: { kind: 'text_quote', quote: 'A unique source quote.' },
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.review.revision, 2);

      await assert.rejects(
        reviews.annotate({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: opened.review.revision,
          operationId: 'stale-write',
          body: 'Must not overwrite a newer annotation.',
          target: { kind: 'text_quote', quote: 'A unique source quote.' },
        }),
        /revision_conflict/,
      );
    } finally {
      store.close();
    }
  });
});
