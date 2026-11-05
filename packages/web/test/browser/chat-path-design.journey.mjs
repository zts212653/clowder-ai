import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureStandaloneImage, verifyReferenceTypography } from './chat-path-design-followup.journey.mjs';

export async function captureChatPathDesign({ page, base, fixture, language, evidence }) {
  const source = fixture.runtime.design;
  const reference = await page.context().newPage();
  let expected;
  try {
    await reference.setViewportSize({ width: 1440, height: 1000 });
    await reference.goto(`http://127.0.0.1:${fixture.apiPort}/api/chat-path-design/proposal`);
    await reference.waitForFunction(() =>
      [...document.images].every((image) => image.complete && image.naturalWidth > 0),
    );
    expected = await reference.evaluate(() => {
      const measure = (element) => {
        const b = element.getBoundingClientRect(),
          s = getComputedStyle(element);
        return {
          width: b.width,
          height: b.height,
          fontSize: parseFloat(s.fontSize),
          radius: parseFloat(s.borderRadius),
        };
      };
      return {
        chip: measure(document.querySelector('.fc')),
        file: measure(document.querySelector('.card')),
        pr: measure(document.querySelector('.card.pr')),
        image: measure(document.querySelector('.card.img img')),
        thumbnail: measure(document.querySelector('.fc .thumb')),
      };
    });
    await reference.locator('.split').screenshot({ path: path.join(evidence, 'accepted-chat-and-workspace.png') });
  } finally {
    await reference.close();
  }
  const sizes = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    if (width === 1440) await page.goto(`${base}/thread/${source.thread.id}?shell=v2`);
    else {
      // Continue from the real file opened below; a reload would race restored Workspace foreground.
      const viewer = page.locator('[data-testid="workspace-file-viewer"]:visible');
      await viewer.getByRole('button', { name: /^‹ / }).click();
      await viewer.waitFor({ state: 'hidden' });
    }
    const message = page.locator(`[data-message-id="${source.message.id}"]`).first();
    await message.waitFor();
    await message.scrollIntoViewIfNeeded();
    await message.locator('p').first().scrollIntoViewIfNeeded();
    await message.locator('[data-chat-reference-kind=commit]').waitFor();
    await message.locator('[data-chat-reference-kind=file][data-chat-reference-layout=card]').waitFor();
    const pr = message.locator('[data-chat-reference-kind=github][data-chat-reference-layout=card]');
    await pr.getByText('#5961', { exact: false }).waitFor();
    await pr.locator('[data-chat-reference-state=merged]').waitFor();
    if (width === 1440) {
      const collapse = page.getByRole('button', {
        name: language === 'en' ? 'Collapse sidebar' : '收起侧栏',
        exact: true,
      });
      if (await collapse.isVisible()) await collapse.click();
    }
    await message.scrollIntoViewIfNeeded();
    const actual = await message.evaluate((element) => {
      const measure = (node) => {
        const b = node.getBoundingClientRect(),
          s = getComputedStyle(node);
        return {
          width: b.width,
          height: b.height,
          fontSize: parseFloat(s.fontSize),
          radius: parseFloat(s.borderRadius),
        };
      };
      return {
        chip: measure(element.querySelector('[data-chat-reference-kind=commit]')),
        file: measure(element.querySelector('[data-chat-reference-kind=file][data-chat-reference-layout=card]')),
        pr: measure(element.querySelector('[data-chat-reference-kind=github]')),
        thumbnail: measure(
          element.querySelector('[data-chat-reference-kind=file][data-chat-reference-layout=inline] img'),
        ),
        readingWidth: element.querySelector('p').getBoundingClientRect().width,
      };
    });
    for (const key of ['width', 'height', 'fontSize', 'radius'])
      assert.ok(Math.abs(actual.chip[key] - expected.chip[key]) <= 2, `Chip ${key} matches accepted CSS within 2px`);
    for (const key of ['width', 'height'])
      assert.ok(
        Math.abs(actual.thumbnail[key] - expected.thumbnail[key]) <= 2,
        `Thumbnail ${key} matches accepted CSS within 2px`,
      );
    assert.ok(
      Math.abs(actual.file.width - Math.min(expected.file.width, actual.readingWidth)) <= 2,
      'File card uses accepted width within the reading column',
    );
    assert.ok(
      Math.abs(actual.file.height - expected.file.height) <= 2,
      'File card height matches the literal accepted CSS',
    );
    assert.ok(
      Math.abs(actual.pr.width - Math.min(expected.pr.width, actual.readingWidth)) <= 2,
      'PR card uses accepted width within the reading column',
    );
    if (language === 'zh' && width === 1440)
      assert.ok(
        Math.abs(actual.pr.height - expected.pr.height) <= 2,
        'The original sample PR height matches the accepted HTML',
      );
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await verifyReferenceTypography({ message, evidence, width });
    await message.screenshot({ path: path.join(evidence, `accepted-example-${language}-${width}-message.png`) });
    await page.screenshot({
      path: path.join(evidence, `accepted-example-${language}-${width}-chat.png`),
      fullPage: true,
    });
    if (width === 1440) {
      await message.locator('[data-chat-reference-kind=file][data-chat-reference-layout=card] > button').click();
      const viewer = page.locator('[data-testid="workspace-file-viewer"]:visible');
      await viewer.getByRole('heading').first().waitFor();
      const divider = page.getByRole('separator', { name: '右侧面板分隔条', exact: true });
      const dividerBox = await divider.boundingBox();
      await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(812, dividerBox.height / 2, { steps: 8 });
      await page.mouse.up();
      await message.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(evidence, `accepted-example-${language}-${width}-workspace.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
    sizes.push({ width, expected, actual });
    await writeFile(
      path.join(evidence, 'accepted-example-proof.json'),
      JSON.stringify(
        {
          source: {
            thread: source.thread.id,
            message: source.message.id,
            commit: source.commit,
            filesCopiedFrom: source.sourceHead,
          },
          sizes,
          boundary:
            'Original cat message host and original Workspace; mobile returns through the original Chat control after the desktop file entry. No injected markup or substituted view. Reference geometry is measured from the unchanged accepted HTML.',
        },
        null,
        2,
      ),
    );
  }
  await captureStandaloneImage({ page, base, source, evidence });
}
