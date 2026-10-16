import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { scene, screenshots } from './f322-members-fixture.mjs';

async function assertVisibleAlert(error) {
  await error.waitFor({ state: 'attached' });
  const visible = await error.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return r.top >= 0 && r.bottom <= innerHeight && (hit === element || element.contains(hit));
  });
  assert.equal(visible, true, 'Save rejection must be visible without scrolling the long form');
  assert.equal(await error.getAttribute('role'), 'alert');
}

for (const width of [1024, 390])
  test(`classic creation exposes a rejected save and keeps the draft retryable (${width}px)`, async () => {
    const { context, page, state } = await scene(width, false, true);
    try {
      await page.setViewportSize({ width, height: 700 });
      await page.getByRole('button', { name: /添加成员/ }).click();
      const dialog = page.getByRole('dialog', { name: '添加成员' });
      await dialog.getByRole('button', { name: '墨墨', exact: true }).click();
      await dialog.locator('input[aria-label="Name"]').fill('隔离保存反馈');
      await dialog.locator('select[aria-label="用哪个号"]').selectOption('claude');
      await dialog.locator('input[aria-label="Model"]').fill('test-model');
      await dialog.locator('input[aria-label="Name"]').scrollIntoViewIfNeeded();
      const save = dialog.getByRole('button', { name: '保存', exact: true });
      await dialog.locator('input[aria-label="Name"]').fill('');
      await save.click();
      await assertVisibleAlert(dialog.getByText('请填写必填字段：名称', { exact: true }));
      assert.equal(state.writes.length, 0, 'Local validation does not send a create request');
      await dialog.locator('input[aria-label="Name"]').fill('隔离保存反馈');
      let rejected = 0;
      const rejectCreate = async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        rejected++;
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: '别名 "@重复" 已被其他成员使用' }),
        });
      };
      await page.route('**/api/cats', rejectCreate);
      await save.click();
      const error = dialog.getByText('别名 "@重复" 已被其他成员使用', { exact: true });
      await assertVisibleAlert(error);
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `classic-save-rejected-${width}.png`) });
      assert.equal(rejected, 1);
      assert.equal(await dialog.locator('input[aria-label="Name"]').inputValue(), '隔离保存反馈');
      assert.equal(await save.isEnabled(), true);
      await page.unroute('**/api/cats', rejectCreate);
      const retried = page.waitForResponse(
        (response) => response.url().endsWith('/api/cats') && response.request().method() === 'POST',
      );
      await save.click();
      const response = await retried;
      assert.equal(response.status(), 201, await response.text());
      await dialog.waitFor({ state: 'detached' });
      assert.equal(state.writes.filter((write) => write.method === 'POST' && write.path === '/api/cats').length, 1);
      assert.equal(state.cats.at(-1).name, '隔离保存反馈');
    } finally {
      await context.close();
    }
  });
