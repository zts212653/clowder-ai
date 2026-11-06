import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { scene, screenshots } from './f322-members-fixture.mjs';

const rejection = '别名 "@重复" 已被其他成员使用';

async function assertVisibleAlert(alert) {
  await alert.waitFor({ state: 'attached' });
  const visible = await alert.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return r.top >= 0 && r.bottom <= innerHeight && (hit === element || element.contains(hit));
  });
  assert.equal(visible, true, 'Save rejection must be visible without scrolling the long form');
  assert.equal(
    await alert.evaluate((element) => Boolean(element.closest('[data-testid="member-save-bar"]'))),
    true,
    'Save rejection stays in the save bar beside the add button',
  );
}

for (const [width, classic] of [
  [1024, true],
  [390, true],
  [390, false],
])
  test(`member creation exposes a rejected save and keeps the draft retryable (${width}px/${classic ? 'classic' : 'v2'})`, async () => {
    const { context, page, state } = await scene(width, false, classic);
    try {
      await page.setViewportSize({ width, height: 700 });
      await page.getByRole('button', { name: classic ? '+ 添加成员' : '添加成员', exact: true }).click();
      const editor = page.getByTestId('member-settings-page');
      await editor.waitFor();
      await editor.getByRole('button', { name: '墨墨', exact: true }).click();
      await editor.getByLabel('使用连接', { exact: true }).selectOption('claude');
      const name = editor.getByLabel('名字', { exact: true });
      const add = editor.getByRole('button', { name: '添加伙伴', exact: true });
      await name.fill('');
      assert.equal(await add.isDisabled(), true, 'An unnamed draft cannot be submitted');
      await name.fill('隔离保存反馈');
      await name.scrollIntoViewIfNeeded();
      let rejected = 0;
      const rejectCreate = async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        rejected++;
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: rejection }),
        });
      };
      await page.route('**/api/cats', rejectCreate);
      await add.click();
      await assertVisibleAlert(editor.getByRole('alert').filter({ hasText: rejection }));
      if (screenshots)
        await page.screenshot({
          path: path.join(screenshots, `member-create-rejected-${width}-${classic ? 'classic' : 'v2'}.png`),
        });
      assert.equal(rejected, 1);
      assert.equal(await name.inputValue(), '隔离保存反馈');
      assert.equal(await add.isEnabled(), true);
      await page.unroute('**/api/cats', rejectCreate);
      const retried = page.waitForResponse(
        (response) => response.url().endsWith('/api/cats') && response.request().method() === 'POST',
      );
      await add.click();
      const response = await retried;
      assert.equal(response.status(), 201, await response.text());
      await editor.waitFor({ state: 'detached' });
      assert.equal(state.writes.filter((write) => write.method === 'POST' && write.path === '/api/cats').length, 1);
      assert.equal(state.cats.at(-1).name, '隔离保存反馈');
    } finally {
      await context.close();
    }
  });
