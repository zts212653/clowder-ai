import assert from 'node:assert/strict';

export async function measureWorkCardTitle(article) {
  return article.locator('.work-gallery-title').evaluate((title) => {
    const style = getComputedStyle(title);
    return {
      text: title.textContent,
      display: style.display,
      lineClamp: style.webkitLineClamp,
      lineHeight: style.lineHeight,
      height: title.getBoundingClientRect().height,
      paddingTop: style.paddingTop,
      paddingBottom: style.paddingBottom,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      overflow: style.overflow,
      scrollHeight: title.scrollHeight,
    };
  });
}

export async function measureWorkCardTrigger(article) {
  return article.locator('.work-gallery-actions > [aria-haspopup="menu"]').evaluate((button) => {
    const style = getComputedStyle(button);
    return {
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      expanded: button.getAttribute('aria-expanded'),
      tabIndex: button.tabIndex,
      focused: document.activeElement === button,
    };
  });
}

export async function assertWorkCardTitle(article) {
  const title = await measureWorkCardTitle(article);
  assert.ok(['-webkit-box', 'flow-root'].includes(title.display), 'full card keeps the two-line renderer');
  assert.equal(title.lineClamp, '2');
  assert.equal(title.lineHeight, '20px');
  assert.equal(title.height, 40);
  assert.equal(title.paddingTop, '0px', 'Home padding must not clip the second line');
  assert.equal(title.paddingBottom, '0px');
  assert.equal(title.fontSize, '13.5px');
  assert.equal(title.fontWeight, '600');
  assert.equal(title.overflow, 'hidden');
  const metadata = await article.locator('.work-gallery-footer > small').evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node);
      return { padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft] };
    }),
  );
  for (const row of metadata)
    assert.deepEqual(row.padding, ['0px', '0px', '0px', '0px'], 'full-card metadata must not inherit Home padding');
  title.metadata = metadata;
  return title;
}

/** Exercise the actual shared card and menu; opacity alone is not keyboard reachability. */
export async function assertWorkCardChrome(page, article) {
  await article.scrollIntoViewIfNeeded();
  const title = await assertWorkCardTitle(article);
  const trigger = article.locator('.work-gallery-actions > [aria-haspopup="menu"]');
  const desktop = await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches);
  await page.mouse.move(1, 1);
  await page.evaluate(() => document.activeElement?.blur());
  const rest = await measureWorkCardTrigger(article);
  assert.equal(rest.opacity, desktop ? '0' : '1');
  assert.equal(rest.tabIndex, 0, 'the trigger remains in the keyboard tab order');
  if (desktop) {
    assert.equal(rest.pointerEvents, 'none', 'the invisible trigger cannot intercept the cover');
    await article.hover();
    assert.equal((await measureWorkCardTrigger(article)).opacity, '1');
    await page.mouse.move(1, 1);
    await article.locator('.work-gallery-open').focus();
    for (let i = 0; i < 8 && !(await measureWorkCardTrigger(article)).focused; i++) await page.keyboard.press('Tab');
    const keyboard = await measureWorkCardTrigger(article);
    assert.equal(keyboard.focused, true, 'Tab reaches the shared menu');
    assert.equal(keyboard.opacity, '1');
    assert.equal(keyboard.pointerEvents, 'auto');
  }
  await trigger.click();
  const menu = article.getByRole('menu');
  await menu.waitFor({ state: 'visible' });
  await page.mouse.move(1, 1);
  await page.evaluate(() => document.activeElement?.blur());
  const open = await measureWorkCardTrigger(article);
  assert.equal(open.expanded, 'true');
  assert.equal(open.opacity, '1', 'an open menu retains its trigger without hover or focus');
  await menu.locator('button:not(:disabled),a[href]').first().focus();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  assert.equal((await measureWorkCardTrigger(article)).focused, true, 'Escape restores the trigger focus');
  await page.mouse.move(1, 1);
  await page.evaluate(() => document.activeElement?.blur());
  assert.equal((await measureWorkCardTrigger(article)).opacity, desktop ? '0' : '1');
  return { title, rest, open, desktop, tabReachable: true, escapeRestoresFocus: true };
}
