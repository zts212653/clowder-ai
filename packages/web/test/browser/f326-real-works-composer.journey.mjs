import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

export function readAuthorDraft(page, threadId) {
  return page.evaluate((id) => {
    const drafts = JSON.parse(localStorage.getItem('cat-cafe:thread-context-attachment-drafts') || '[]');
    return drafts.find(([key]) => key === id)?.[1] || [];
  }, threadId);
}

/** Only this private author journey's known, unsent RSI probes; never erase an unfamiliar draft. */
export async function cleanAuthorDraft({ page, threadId, reference, allowedAnchors }) {
  const before = await readAuthorDraft(page, threadId);
  const own = before.filter((item) => item.kind === 'media' && item.source.contentRef === reference.contentRef);
  for (const item of own) {
    assert.equal(item.source.kind, 'publication');
    assert.equal(item.source.ownerRevision, reference.ownerRevision);
    assert.equal(item.title, 'RSI 愿景');
    for (const place of item.selections) {
      assert.ok(!place.instruction, 'Never remove human-authored words');
      assert.ok(
        allowedAnchors.some((anchor) => isDeepStrictEqual(anchor, place.selection)),
        'Unfamiliar selections are retained for investigation',
      );
    }
  }
  const removed = [];
  for (const item of own) {
    for (const place of item.selections) {
      // The attachment is single-work; stable IDs name the exact original composer selection.
      const actual = page.locator(`[data-context-kind="media"] [data-selection-id="${place.id}"]`);
      await actual.getByRole('button', { name: /^移除选区 / }).click();
      await actual.waitFor({ state: 'detached' });
      removed.push({ attachmentId: item.id, selectionId: place.id });
    }
  }
  assert.deepEqual(
    await readAuthorDraft(page, threadId),
    before.filter((item) => !own.includes(item)),
  );
  return { removed, unrelatedPreserved: before.length - own.length, viaOriginalComposer: true };
}
