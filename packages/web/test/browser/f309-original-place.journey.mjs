import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { reviewItem, reviewView } from '../../src/components/shell/mailbox/__tests__/mailbox-review-fixtures.ts';

// Real MailboxButton -> exact-place navigation -> restoring chat store + F307 foreground bridge.
// The shell supplies a controlled owner read and route mount; no live backend or review renderer is claimed.
export function registerOriginalReviewNavigation({ openProof, closeProof, unifiedRead }) {
  test('F309 exact review keeps its owning conversation and history across original-place navigation', async () => {
    const reviewId = `review-${'a'.repeat(64)}`;
    const target = 'thread-other';
    const item = reviewItem();
    item.decisionRef = `f309.content_review:${reviewId}`;
    const entry = item.linkedNeedsMe[0];
    entry.ownerRead.envelope.visibility.ownerUserId = 'owner-1';
    entry.ownerRead.work.threadId = target;
    entry.ownerRead.preparedArtifact = {
      artifactRef: 'content:content-cover',
      artifactRevision: '1',
      completenessRef: 'receipt:cover',
      previewRef: `content-review:${reviewId}:round:1`,
      openInWorkspaceRef: `workspace:content-review:${target}:${reviewId}`,
    };
    entry.receipt.producer.subjectRef = reviewId;
    entry.receipt.producer.ownerRef = `content-review:${reviewId}`;
    entry.receipt.action.actionRef = `content-review:${reviewId}`;
    const view = reviewView();
    view.review.reviewId = reviewId;
    view.review.task.ownerUserId = 'owner-1';
    view.review.task.threadId = target;
    const results = [];
    for (const route of ['/thread/thread-return', '/', '/settings?from=thread-return', '/thread/thread-other']) {
      const proof = await openProof({
        route,
        reviewNavigation: true,
        unified: () => ({ body: unifiedRead({ items: [item], totalCount: 1, attentionCount: 1 }) }),
        ready: '待办，1 件',
        api: ({ url }) => (url.pathname === `/api/artifact-reviews/${reviewId}` ? { body: view } : null),
      });
      const { page } = proof;
      try {
        const historyBefore = await page.evaluate(() => history.length);
        const stateBefore = JSON.parse(await page.getByTestId('review-thread-state').textContent());
        await page.evaluate(() => {
          window.__f309DocumentProof = 'original-document';
        });
        await page.getByTestId('mailbox-button').click();
        await page.getByTestId('mailbox-open-original').click();
        await page.waitForURL(`**/thread/${target}`);
        await page.waitForFunction(
          (target) =>
            document.querySelector('[data-testid="conversation"]')?.getAttribute('data-path') === `/thread/${target}`,
          target,
        );
        assert.equal(await page.evaluate(() => window.__f309DocumentProof), 'original-document');
        const layout = await page.evaluate(() => JSON.parse(localStorage.getItem('cat-cafe:workbench-layout-v2')));
        const state = JSON.parse(await page.getByTestId('review-thread-state').textContent());
        assert.deepEqual(
          state,
          {
            threadId: target,
            foreground: `content-review:${reviewId}`,
            mode: 'dev',
            panelOpen: true,
            panelMode: 'workspace',
            activeSurfaceId: `content-review:${reviewId}`,
          },
          'destination state restoration must leave the requested review selected and visible',
        );
        assert.equal(layout.activeSurfaceId, `content-review:${reviewId}`);
        assert.deepEqual(layout.surfaces.find((s) => s.id === layout.activeSurfaceId).resultTargetRef, {
          owner: 'thread',
          key: target,
        });
        const alreadyHere = route === `/thread/${target}`;
        const historyAfter = await page.evaluate(() => history.length);
        assert.equal(
          historyAfter,
          historyBefore + (alreadyHere ? 0 : 1),
          'one click adds at most one source-directed history entry',
        );
        const evidenceRoot = process.env.F309_ORIGINAL_PLACE_EVIDENCE;
        if (evidenceRoot) {
          await mkdir(evidenceRoot, { recursive: true });
          await page.screenshot({ path: path.join(evidenceRoot, `route-${results.length}.png`) });
        }
        if (!alreadyHere) {
          await page.goBack();
          await page.waitForURL(new URL(route, page.url()).href);
          assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, route);
          if (route === '/' || route.startsWith('/thread/')) {
            await page.waitForFunction((threadId) => {
              const value = document.querySelector('[data-testid="review-thread-state"]')?.textContent;
              return value && JSON.parse(value).threadId === threadId;
            }, stateBefore.threadId);
            const returned = JSON.parse(await page.getByTestId('review-thread-state').textContent());
            assert.equal(
              returned.foreground,
              stateBefore.foreground,
              'opening the review must not change the outgoing thread',
            );
          }
        }
        results.push({ from: route, target, reviewId, historyBefore, historyAfter, backRestored: !alreadyHere });
      } finally {
        await closeProof(proof);
      }
    }
    if (process.env.F309_ORIGINAL_PLACE_EVIDENCE)
      await writeFile(
        path.join(process.env.F309_ORIGINAL_PLACE_EVIDENCE, 'results.json'),
        JSON.stringify(results, null, 2),
      );
  });
}
