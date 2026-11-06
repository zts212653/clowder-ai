import assert from 'node:assert/strict';

export function menuTrigger(page, menu) {
  return menu === 'tabs'
    ? page.getByTestId('v2-more-tabs')
    : menu === 'workspace'
      ? page.getByTestId('v2-workspace-chrome').locator('summary').last()
      : page.getByTestId('content-file-toolbar').locator('button[aria-haspopup="menu"]');
}

export function menuPanel(trigger) {
  return trigger.page().locator('[data-v2-workspace-menu]:visible, [role="menu"][popover]:popover-open');
}

export async function assertMenuClosed(trigger) {
  const state = await trigger.evaluate((node) =>
    node.tagName === 'SUMMARY' ? String(node.closest('details').open) : node.getAttribute('aria-expanded'),
  );
  assert.equal(state, 'false');
  assert.equal(await menuPanel(trigger).count(), 0);
}

/** Tabs own pane geometry; the common file-action owner owns viewport geometry. */
export async function assertPopupVisible(trigger) {
  const popup = menuPanel(trigger);
  await popup.waitFor({ timeout: 1000 });
  const result = await popup.evaluate((panel) => {
    const r = panel.getBoundingClientRect();
    const host = document.querySelector('[data-testid="workspace-menu-host"]').getBoundingClientRect();
    return {
      rect: r.toJSON(),
      host: host.toJSON(),
      file: panel.getAttribute('role') === 'menu',
      viewport: { width: innerWidth, height: innerHeight },
      hits: [
        [r.left + 4, r.top + 4],
        [r.right - 4, r.bottom - 4],
      ].map(([x, y]) => panel.contains(document.elementFromPoint(x, y))),
    };
  });
  const left = result.file ? 0 : Math.max(0, result.host.left);
  const right = result.file ? result.viewport.width : Math.min(result.viewport.width, result.host.right);
  assert.ok(
    result.rect.left >= left && result.rect.right <= right,
    `menu horizontally reachable: ${JSON.stringify(result)}`,
  );
  assert.ok(
    result.rect.top >= 0 && result.rect.bottom <= result.viewport.height,
    `menu vertically reachable: ${JSON.stringify(result)}`,
  );
  assert.deepEqual(result.hits, [true, true], 'panel escapes ancestor clipping and remains hit-testable');
  return result;
}
