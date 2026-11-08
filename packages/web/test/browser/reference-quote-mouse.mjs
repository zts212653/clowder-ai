import assert from 'node:assert/strict';

/** Compute caret geometry, then use only real mouse input to create the selection. */
export async function mouseSelectReference(page, source, mode) {
  await page.mouse.click(40, 30);
  await source.scrollIntoViewIfNeeded();
  const github = mode.startsWith('github');
  const reference = source.locator(`[data-chat-reference-kind=${github ? 'github' : 'file'}]`).first();
  await reference.hover();
  if (!github) await reference.getByRole('menu').waitFor();
  if (mode === 'label-feedback') {
    await reference.getByRole('menuitem', { name: '复制路径', exact: true }).click();
    await reference.locator('output').waitFor();
  }
  const geometry = await source.evaluate((element, kind) => {
    const label = element.querySelector(
      kind.startsWith('github')
        ? '[data-chat-reference-kind=github] span[data-quote-source-text]'
        : '[data-chat-file-name]',
    );
    if (!label) throw new Error('Missing actual reference label');
    function texts(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const found = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (
          node.textContent.trim() &&
          !node.parentElement.closest('[role=menu],[aria-hidden=true],output,[role=alert]')
        )
          found.push(node);
      }
      return found;
    }
    const labelNodes = texts(label),
      bodyNodes = texts(element);
    const first = kind.startsWith('label') ? labelNodes[0] : bodyNodes[0];
    const last = kind.endsWith('sentence') ? bodyNodes.at(-1) : labelNodes.at(-1);
    function edge(node, end) {
      const range = document.createRange();
      range.setStart(node, end ? node.textContent.length - 1 : 0);
      range.setEnd(node, end ? node.textContent.length : 1);
      const rect = range.getBoundingClientRect();
      return { x: end ? rect.right + 0.2 : rect.left + 0.2, y: rect.top + rect.height / 2 };
    }
    return { start: edge(first, false), end: edge(last, true), before: element.innerText };
  }, mode);
  await page.mouse.move(geometry.start.x, geometry.start.y);
  await page.mouse.down();
  await page.mouse.move(geometry.end.x, geometry.end.y, { steps: 24 });
  await page.mouse.up();
  const proof = await source.evaluate((element) => ({
    selected: window.getSelection()?.toString(),
    rendered: element.closest('[data-context-quote-source]').innerText,
    menusAfter: element.querySelectorAll('[role=menu]').length,
    noticesAfter: element.querySelectorAll('output').length,
  }));
  assert.ok(proof.selected?.trim(), JSON.stringify({ mode, geometry, proof }));
  assert.equal(proof.menusAfter, 0, 'text selection dismisses the preview and suppresses hover during drag');
  assert.equal(proof.noticesAfter, 0, 'copy feedback must not become part of the message selection');
  return { mode, geometry, ...proof };
}
