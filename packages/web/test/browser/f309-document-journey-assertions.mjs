import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { assertFitsViewport, measureContrast } from './f309-ordinary-workspace-journey-chat-progress.mjs';

export async function assertDocumentGroupFocus(page, fixture, text = 'First unique paragraph.') {
  const original = fixture.message.contentBlocks.find(
    (block) =>
      block.type === 'context_attachment' && block.attachment.kind === 'quote' && block.attachment.text === text,
  );
  assert.ok(original);
  await page.locator(`[data-file-quote-mark=${JSON.stringify(original.attachment.id)}]`).click();
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-file-quote-key'));
  assert.equal(focused, `${fixture.owner.thread.id}:${fixture.message.id}:${original.attachment.id}`);
  // Expanding the list changes the paper's position without necessarily resizing it.
  await page.waitForFunction(
    ({ id, text }) => {
      const paper = document.querySelector('[data-testid="workspace-content-review-text"]');
      const nodes = [...paper.querySelectorAll('[data-source-line]')];
      const beside = (mark, words) => {
        const node = nodes.find((node) => node.textContent.trim() === words);
        return mark && node && Math.abs(mark.getBoundingClientRect().top - node.getBoundingClientRect().top) < 8;
      };
      const published = [...document.querySelectorAll('[data-file-quote-mark]')].find(
        (mark) => mark.dataset.fileQuoteMark === id,
      );
      return (
        beside(published, text) &&
        [...document.querySelectorAll('[data-pending-file-quote]')].every((mark) =>
          beside(mark, mark.textContent === '1' ? 'Second unique paragraph.' : 'First unique paragraph.'),
        )
      );
    },
    { id: original.attachment.id, text },
  );
}

export async function assertPublishedDocumentQuotes(page, fixture) {
  const cat = page.locator(`[data-message-id="${fixture.catMessage.id}"]`);
  assert.match(await cat.innerText(), /正文和引用都应保留/);
  assert.equal(await cat.getByTestId('context-attachment-cat-source').count(), 1);
  const queued = page.locator(`[data-message-id="${fixture.queuedCatMessage.id}"]`);
  await queued.waitFor({ state: 'visible' });
  assert.match(await queued.innerText(), /已发布的猫引用仍在等接手/);
  assert.equal(fixture.owner.messages.getById(fixture.queuedCatMessage.id).deliveryStatus, 'queued');
  return cat;
}

export async function assertCandidateTextContrast(result, slug, contrast) {
  for (const label of await result.locator('[data-text-edit] p, [data-text-edit] pre').all()) {
    const ratio = await measureContrast(label, 'text-on-fill');
    const words = await label.innerText();
    contrast.values[`${slug} candidate ${words}`] = Number(ratio.toFixed(2));
    assert.ok(ratio >= 4.5, `candidate label "${words}" is ${ratio.toFixed(2)}:1`);
  }
}

export async function assertDocumentOutcomeVisible(page, result, words) {
  const outcome = result.getByText(words, { exact: true });
  await outcome.waitFor();
  const observation = await outcome.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const clips = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) continue;
      const clip = parent.getBoundingClientRect();
      clips.push({ top: clip.top, bottom: clip.bottom });
    }
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      top: rect.top,
      bottom: rect.bottom,
      clips,
      visible:
        rect.top >= 0 &&
        rect.bottom <= innerHeight &&
        clips.every((clip) => rect.top >= clip.top && rect.bottom <= clip.bottom),
      reachable: hit === element || element.contains(hit),
    };
  });
  assert.ok(
    observation.visible && observation.reachable,
    `decision outcome is visible without another scroll: ${JSON.stringify(observation)}`,
  );
  assert.ok((await measureContrast(outcome, 'text-on-fill')) >= 4.5);
  const header = page
    .getByTestId('workspace-content-review-surface')
    .getByRole('button', { name: '返回来源', exact: true });
  const bounds = await header.boundingBox();
  assert.ok(
    bounds && bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize().height,
    'outcome focus preserves the file return header',
  );
}

export async function recordDocumentJourney(path, page, fixture, candidateRef) {
  await writeFile(
    path,
    `${JSON.stringify(
      {
        cwd: process.cwd(),
        appUrl: page.url(),
        ownerUrl: fixture.owner.api,
        sourceMessageId: fixture.message.id,
        authorCatId: fixture.catMessage.catId,
        requestId: fixture.record.requestId,
        taskId: fixture.taskId,
        candidateRef,
        boundaries: [
          'isolated human-session issuer',
          'seeded human source message',
          'seeded queued cat custody; production GET decides publication',
          'deterministic non-LLM provider',
          'unrelated shell config and thread catalog',
          'message push transport excluded; production history is explicitly reloaded',
        ],
        actualModelInvocation: false,
        alphaAcceptance: false,
      },
      null,
      2,
    )}\n`,
  );
}

export async function assertDocumentReceipt(page, fixture, state, screenshotPath) {
  const message = fixture.owner.messages
    .getByThread(fixture.owner.thread.id, 200)
    .find((item) => item.extra?.contentModificationReceiptV1?.state === state);
  assert.ok(message, `the owner persisted its ${state} receipt`);
  assert.equal(message.userId, fixture.owner.thread.createdBy);
  assert.deepEqual(message.from, { kind: 'system', service: 'content-modification' });
  assert.equal(message.extra.contentModificationReceiptV1.sourceMessageId, fixture.message.id);
  // This isolated owner has no Socket.IO delivery fixture. The GET history remains the production route.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const row = page.locator(`[data-message-id="${message.id}"] [data-state="receipt_${state}"]`);
  await row.waitFor();
  // Reload restores the mobile file pane above Chat. Use its actual fold control before inspecting the receipt.
  if (page.viewportSize().width < 768) {
    await page.getByTestId('workspace-shell-fold').click();
    await page.getByTestId('f307-experience-workbench').waitFor({ state: 'hidden' });
  }
  await row.scrollIntoViewIfNeeded();
  await assertHitTarget(page, row.getByRole('button'));
  assert.ok((await measureContrast(row.locator('output > span').first(), 'text-on-fill')) >= 4.5);
  await row.screenshot({ path: screenshotPath });
}

export async function assertHitTarget(page, button) {
  await button.scrollIntoViewIfNeeded();
  await assertFitsViewport(page, button);
  assert.ok(
    await button.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === element || element.contains(hit);
    }),
    'the visible decision remains reachable, not covered by another panel',
  );
}

export { probeDocumentReceiptClick } from './f309-document-receipt-stability.mjs';
