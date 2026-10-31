import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import * as testFixture from './workspace-content-review-service.fixture.js';

const { workspaceTextDigest, writeFile, principal, fixture, locator, join } = testFixture;
afterEach(testFixture.cleanupFixtureRoots);

// Review of #4643 (Sol, 2026-09-23): A (original) -> the person accepts and writes B -> someone else
// writes C before the automatic refresh runs. Refreshing "to whatever is current" bound the review to C,
// which the person never confirmed, and hid the external-drift banner.
describe('workspace review refresh fenced to an expected source revision', () => {
  it('does not move the review onto a revision other than the accepted one', async () => {
    const { root, reviews } = await fixture();
    const opened = await reviews.prepare({ principal, locator, operationId: 'open-notes' });
    const original = opened.review.source.revision;

    const accepted = '# Notes\n\nA unique source quote.\n\n- accepted line\n';
    await writeFile(join(root, 'notes.md'), accepted);
    await writeFile(join(root, 'notes.md'), `${accepted}- someone else's line\n`);

    const view = await reviews.refresh({
      principal,
      reviewId: opened.review.reviewId,
      expectedRevision: opened.review.revision,
      operationId: 'auto-refresh-after-accept',
      expectedSourceRevision: workspaceTextDigest(accepted),
    });
    assert.equal(view.review.source.revision, original);
    assert.equal(view.sourceState, 'changed');
  });

  it('moves the review when the current revision is exactly the accepted one', async () => {
    const { root, reviews } = await fixture();
    const opened = await reviews.prepare({ principal, locator, operationId: 'open-notes' });

    const accepted = '# Notes\n\nA unique source quote.\n\n- accepted line\n';
    await writeFile(join(root, 'notes.md'), accepted);

    const view = await reviews.refresh({
      principal,
      reviewId: opened.review.reviewId,
      expectedRevision: opened.review.revision,
      operationId: 'auto-refresh-after-accept',
      expectedSourceRevision: workspaceTextDigest(accepted),
    });
    assert.equal(view.review.source.revision, workspaceTextDigest(accepted));
    assert.equal(view.sourceState, 'current');
  });
});
