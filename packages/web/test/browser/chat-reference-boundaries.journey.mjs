import assert from 'node:assert/strict';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function verifySplitFileGroup({ message, evidence }) {
  const report = message.locator('[data-chat-reference-kind=file]').filter({ hasText: 'report.docx' });
  const group = report.locator('..');
  await group.scrollIntoViewIfNeeded();
  const geometry = await group.evaluate((element) => ({
    viewport: innerWidth,
    width: element.getBoundingClientRect().width,
    columns: getComputedStyle(element).gridTemplateColumns,
    cards: [...element.querySelectorAll('[data-chat-reference-kind=file]')].map((card) => {
      const name = card.querySelector('[data-chat-file-name]');
      const meta = card.querySelector('[data-chat-file-metadata]');
      const range = document.createRange();
      const core = meta.textContent.split(' · ').slice(0, 3).join(' · ');
      const walker = document.createTreeWalker(meta, NodeFilter.SHOW_TEXT);
      let remaining = core.length;
      range.setStart(meta, 0);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (remaining <= node.textContent.length) {
          range.setEnd(node, remaining);
          break;
        }
        remaining -= node.textContent.length;
      }
      const text = range.getBoundingClientRect();
      return {
        name: name.textContent,
        nameWidth: name.clientWidth,
        fullNameWidth: name.scrollWidth,
        metadata: meta.textContent,
        metadataWidth: meta.clientWidth,
        core,
        coreRight: text.right,
        metadataRight: meta.getBoundingClientRect().right,
        top: card.getBoundingClientRect().top,
      };
    }),
  }));
  assert.equal(geometry.viewport, 1440, 'Exercise a desktop split view, not the mobile media query');
  assert.ok(geometry.width < 300, `Exercise the actual narrow reading column: ${geometry.width}`);
  assert.equal(geometry.cards.length, 2);
  assert.ok(geometry.cards[1].top > geometry.cards[0].top, 'Narrow message groups become one column');
  for (const card of geometry.cards) {
    assert.ok(card.nameWidth + 1 >= card.fullNameWidth, `The complete filename remains readable: ${card.name}`);
    // Date is supplementary; type, page/sheet count and byte size must fit before any truncation.
    assert.ok(card.coreRight <= card.metadataRight + 1, `Core file metadata remains readable: ${card.metadata}`);
  }
  await writeFile(path.join(evidence, 'split-file-group.json'), JSON.stringify(geometry, null, 2));
  await group.screenshot({ path: path.join(evidence, 'split-file-group.png'), animations: 'disabled' });
}

export async function verifyReferenceBoundaries({ page, source, evidence, language, desktop }) {
  await page.mouse.move(2, 2);
  await page.keyboard.press('Escape');
  const regression = page.locator(`[data-message-id="${source.regression.id}"]`).first();
  await regression.scrollIntoViewIfNeeded();
  await regression.locator('[data-chat-reference-kind=file]').waitFor();
  const text = await regression.innerText();
  for (const word of source.ordinary) assert.ok(text.includes(word), `Ordinary prose stays literal: ${word}`);
  assert.equal(await regression.locator('[data-chat-reference-kind=missing]').count(), 0);
  assert.equal(await regression.locator('[data-chat-reference-kind=file]').count(), 1);
  assert.ok(!text.includes('[wt:'), 'Historical internal tags remain hidden');
  assert.ok(text.includes('docs/removed-root.md'), 'An unknown historical root remains non-navigating text');
  const codeParagraph = regression
    .locator('p')
    .filter({ has: page.locator('code') })
    .first();
  assert.equal(
    await codeParagraph.evaluate((element) => getComputedStyle(element).display),
    'block',
    'Unverified code spans keep normal paragraph flow',
  );
  assert.equal(await codeParagraph.getAttribute('data-chat-reference-group'), null);
  const unverified = regression.locator('p').filter({ hasText: 'unverified.option' });
  assert.equal(await unverified.locator('br').count(), 1, 'Unknown references retain their original line break');
  const words = await unverified.locator('code').all();
  assert.ok((await words[1].boundingBox()).y > (await words[0].boundingBox()).y);
  await regression.screenshot({ path: path.join(evidence, 'ordinary-and-legacy.png'), animations: 'disabled' });

  const message = page.locator(`[data-message-id="${source.message.id}"]`).first();
  const menus = page.getByRole('group', { name: language === 'en' ? 'File actions' : '文件操作', exact: true });
  for (const kind of ['github', 'missing']) {
    const reference = message.locator(`[data-chat-reference-kind=${kind}]`).first();
    const control = kind === 'missing' ? reference : reference.locator('button').first();
    await control.scrollIntoViewIfNeeded();
    await control.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    assert.ok(
      await control.evaluate((element) => element === document.activeElement && element.matches(':focus-visible')),
    );
    const tooltip = page.getByRole('tooltip');
    await tooltip.waitFor();
    await menus.waitFor({ state: 'hidden' });
    const label = await control.getAttribute('aria-label');
    assert.ok(label && label.length > 10, 'The accessible name includes full metadata');
    if (kind === 'github') {
      const full = await control.getAttribute('aria-label');
      assert.ok((await tooltip.innerText()).startsWith(full));
    } else {
      assert.match(await tooltip.innerText(), language === 'en' ? /no longer here/ : /不在了/);
      await page.keyboard.press('Enter');
      assert.ok(await tooltip.isVisible(), 'Missing file activation only explains the status');
    }
    await page.screenshot({ path: path.join(evidence, `${kind}-keyboard-tooltip.png`), fullPage: true });
    await page.keyboard.press('Escape');
    await tooltip.waitFor({ state: 'hidden' });
  }
  const directory = message.locator('[data-chat-reference-kind=file]').filter({
    has: page.locator('[data-chat-file-name]').filter({ hasText: /^docs$/ }),
  });
  assert.equal(await directory.count(), 1);
  const canonical = await realpath(path.join(source.root, 'docs'));
  const advertised = await directory.getAttribute('title');
  assert.equal(await realpath(advertised), canonical, 'The canonical display path selects the original directory');
  await writeFile(
    path.join(evidence, 'directory-coordinate.json'),
    JSON.stringify({ fixture: source.root, canonical, advertised }, null, 2),
  );
  await directory.hover();
  const menu = menus;
  await menu.waitFor();
  const before = desktop.length;
  const sent = page.waitForResponse(
    (response) =>
      response.url().includes('/api/workspace/file/actions/reveal?') && response.request().method() === 'POST',
  );
  await menu
    .getByRole('button', { name: language === 'en' ? 'Show in Finder' : '在 Finder 中显示', exact: true })
    .click();
  await sent;
  assert.equal(desktop.length, before + 1);
  assert.ok(desktop.at(-1).url.includes('path=docs'));
  await page.keyboard.press('Escape');
}

export async function verifyMultilineFileGroup({ page, source, evidence }) {
  const message = page.locator(`[data-message-id="${source.multiline.id}"]`).first();
  await message.locator('p').first().scrollIntoViewIfNeeded();
  const group = message.locator('[data-chat-reference-group=grid]');
  await group.waitFor();
  await group.scrollIntoViewIfNeeded();
  assert.equal(await group.locator(':scope > br').count(), 0);
  assert.equal(await group.locator(':scope > *').count(), 3, 'Only verified file cards occupy grid cells');
  const measure = () =>
    group.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      columns: getComputedStyle(element).gridTemplateColumns,
      cards: [...element.children].map((card) => {
        const box = card.getBoundingClientRect();
        return { name: card.querySelector('[data-chat-file-name]').textContent, x: box.x, y: box.y };
      }),
    }));
  const divider = page.getByRole('separator', { name: '右侧面板分隔条', exact: true });
  const resize = async (x) => {
    const box = await divider.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.mouse.move(2, 2);
    await page.keyboard.press('Escape');
  };
  const before = await measure();
  await writeFile(path.join(evidence, 'multiline-grid.json'), JSON.stringify({ before }, null, 2));
  // Opening the PR changes view has its own split width; explicitly set the narrow case.
  const chat = await page.locator('[data-chat-container]').boundingBox();
  await resize(chat.x + 310);
  await page.waitForFunction((element) => element.getBoundingClientRect().width < 300, await group.elementHandle());
  const narrow = await measure();
  await writeFile(path.join(evidence, 'multiline-grid.json'), JSON.stringify({ before, narrow }, null, 2));
  assert.ok(narrow.width < 300);
  assert.ok(narrow.cards[1].y > narrow.cards[0].y && narrow.cards[2].y > narrow.cards[1].y);
  await group.screenshot({ path: path.join(evidence, 'multiline-grid-narrow.png'), animations: 'disabled' });
  await resize(1160);
  await group.scrollIntoViewIfNeeded();
  await page.waitForFunction((element) => element.getBoundingClientRect().width >= 680, await group.elementHandle());
  const wide = await measure();
  assert.ok(wide.width >= 680, `Exercise the three-column reading width: ${wide.width}`);
  assert.ok(wide.cards.every((card) => Math.abs(card.y - wide.cards[0].y) < 2));
  assert.ok(wide.cards[0].x < wide.cards[1].x && wide.cards[1].x < wide.cards[2].x);
  await writeFile(path.join(evidence, 'multiline-grid.json'), JSON.stringify({ before, narrow, wide }, null, 2));
  await group.screenshot({ path: path.join(evidence, 'multiline-grid.png'), animations: 'disabled' });
}
