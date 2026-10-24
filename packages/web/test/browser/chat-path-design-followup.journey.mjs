import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertGitHubMetadataLines, readGitHubMetadataLines } from './chat-pr-metadata-reading.journey.mjs';

async function revealReadingTarget(page, target) {
  // A desktop route opens the sidebar; resizing retains it as the ordinary mobile drawer.
  const collapse = page.locator('[data-testid="sidebar-collapse"]:visible');
  if (await collapse.count()) await collapse.first().click();
  await target.scrollIntoViewIfNeeded();
  await page.waitForFunction(
    (element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return box.width > 0 && box.height > 0 && element.contains(hit);
    },
    await target.elementHandle(),
  );
  return target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { unobscured: element.contains(hit), hitTag: hit?.tagName };
  });
}

/** Native geometry for the original designer's narrow-column punctuation and PR metadata findings. */
export async function verifyReferenceTypography({ message, evidence, width }) {
  const affixes = [];
  for (const wrapper of await message.locator('[data-chat-reference-affix]').all()) {
    await wrapper.scrollIntoViewIfNeeded();
    await wrapper.locator('[data-chat-reference-kind]').waitFor();
    const measured = await wrapper.evaluate((element) => {
      const reference = element.querySelector('[data-chat-reference-kind]').getBoundingClientRect();
      const marks = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return { text: node.textContent, rects: [...range.getClientRects()].map((rect) => rect.toJSON()) };
        });
      return { text: element.textContent, reference: reference.toJSON(), marks };
    });
    for (const mark of measured.marks)
      for (const rect of mark.rects)
        assert.ok(
          rect.top < measured.reference.bottom && rect.bottom > measured.reference.top,
          `The immediate punctuation ${mark.text} stays on its reference line at ${width}px`,
        );
    affixes.push(measured);
  }
  assert.ok(affixes.length >= 2, 'The accepted sample exercises both bracketed commit and file punctuation');
  const pr = message.locator('[data-chat-reference-kind=github][data-chat-reference-layout=card]');
  await pr.scrollIntoViewIfNeeded();
  const metadata = await pr.locator('span[title]').evaluateAll((parts) =>
    parts.map((part) => {
      const range = document.createRange();
      range.selectNodeContents(part);
      return {
        text: part.textContent,
        title: part.getAttribute('title'),
        indexInGroup: parts.filter((candidate) => candidate.parentElement === part.parentElement).indexOf(part),
        whiteSpace: getComputedStyle(part).whiteSpace,
        rect: part.getBoundingClientRect().toJSON(),
        textRects: [...range.getClientRects()].map((rect) => rect.toJSON()),
      };
    }),
  );
  assert.ok(metadata.length >= 4, 'Repository, number and real PR statistics are measured');
  for (const item of metadata) {
    assert.equal(item.text, `${item.indexInGroup === 0 ? '' : ' · '}${item.title}`);
    assert.equal(item.whiteSpace, 'nowrap', 'The preceding separator and its following item share one reading unit');
    assert.ok(item.textRects.length > 0);
    for (const rect of item.textRects)
      assert.ok(
        rect.top < item.rect.bottom && rect.bottom > item.rect.top,
        'The separator cannot wrap onto a line apart from its following content',
      );
  }
  const visibleMetadata = await readGitHubMetadataLines(pr);
  assertGitHubMetadataLines(visibleMetadata);
  await pr.screenshot({ path: path.join(evidence, `pr-metadata-${width}.png`), animations: 'disabled' });
  await writeFile(
    path.join(evidence, `typography-${width}.json`),
    JSON.stringify({ width, affixes, metadata, visibleMetadata }, null, 2),
  );
}

/** A separate persisted message adds the missing standalone-image case without changing the accepted prose. */
export async function captureStandaloneImage({ page, base, source, evidence }) {
  const sizes = [];
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`${base}/thread/${source.thread.id}?shell=v2`);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    const message = page.locator(`[data-message-id="${source.imageMessage.id}"]`).first();
    await message.scrollIntoViewIfNeeded();
    const card = message.locator('[data-chat-reference-kind=file][data-chat-reference-layout=card]');
    await card.locator('img').waitFor();
    await page.waitForFunction(
      (image) => image.complete && image.naturalWidth > 0,
      await card.locator('img').elementHandle(),
    );
    const visibility = await revealReadingTarget(page, card);
    const actual = await card.evaluate((element) => ({
      card: element.getBoundingClientRect().toJSON(),
      image: element.querySelector('img').getBoundingClientRect().toJSON(),
      readingWidth: element.closest('p').getBoundingClientRect().width,
      targetWidth: parseFloat(getComputedStyle(element).width),
      naturalWidth: element.querySelector('img').naturalWidth,
    }));
    assert.ok(
      Math.abs(actual.card.width - Math.min(300, actual.readingWidth)) <= 2,
      'Image card fits its 300px design width within the reading column',
    );
    assert.ok(Math.abs(actual.image.height - 150) <= 2, 'The real image preview is 150px high');
    assert.ok(actual.naturalWidth > 0);
    assert.equal(
      visibility.unobscured,
      true,
      'The original image card is not covered by the sidebar or another surface',
    );
    await page.screenshot({
      path: path.join(evidence, `standalone-image-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await card.screenshot({ path: path.join(evidence, `standalone-image-${width}-card.png`), animations: 'disabled' });
    sizes.push({ width, actual, visibility });
  }
  await writeFile(
    path.join(evidence, 'standalone-image-proof.json'),
    JSON.stringify({ thread: source.thread.id, message: source.imageMessage.id, path: source.cover, sizes }, null, 2),
  );
  const long = page.locator(`[data-message-id="${source.longMessage.id}"]`).first();
  await long.scrollIntoViewIfNeeded();
  await long.locator('[data-chat-reference-kind=file]').waitFor();
  const wrapper = long.locator('[data-chat-reference-affix]');
  const visibility = await revealReadingTarget(page, wrapper);
  const bounds = await wrapper.evaluate((element) => ({
    wrapper: element.getBoundingClientRect().toJSON(),
    paragraph: element.closest('p').getBoundingClientRect().toJSON(),
    contentWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  assert.ok(bounds.contentWidth <= bounds.clientWidth + 1, 'Even a long chip leaves room for its attached punctuation');
  assert.ok(
    bounds.wrapper.right <= bounds.paragraph.right + 1,
    'The punctuation group stays inside the reading column',
  );
  assert.equal(visibility.unobscured, true, 'The long reference is readable in the actual mobile page');
  await long.screenshot({ path: path.join(evidence, 'long-chip-punctuation-390.png'), animations: 'disabled' });
  await writeFile(
    path.join(evidence, 'long-chip-punctuation-proof.json'),
    JSON.stringify({ ...bounds, visibility }, null, 2),
  );
}
