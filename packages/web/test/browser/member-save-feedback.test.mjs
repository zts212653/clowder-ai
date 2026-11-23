import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { parseAcpCatalog } from '../../../api/dist/routes/runtime-model-catalog.js';
import { scene, screenshots } from './f322-members-fixture.mjs';

const rejection = '别名 "@重复" 已被其他成员使用';

for (const options of [[{ value: 'duplicate' }, { value: 'duplicate' }], []])
  test(`clearing an existing ACP model remains saveable (${options.length} choices)`, async () => {
    const { context, page, state } = await scene();
    try {
      const acp = { command: 'fixture-acp', startupArgs: [], transport: 'stdio' };
      Object.assign(state.cats[0], {
        clientId: 'acp',
        carrier: 'acp',
        configurationSource: 'native_tool',
        accountRef: '',
        acp,
      });
      const session = { configOptions: [{ id: 'model', currentValue: 'duplicate', options }] };
      const catalog = parseAcpCatalog(session, session);
      assert.equal(catalog.defaultModelStatus, 'unavailable');
      await page.route('**/api/cats/native-runtimes', (route) =>
        route.fulfill({
          json: {
            runtimes: [{ id: 'acp:fixture', label: 'Fixture ACP', clientId: 'acp', installed: true, models: [], acp }],
          },
        }),
      );
      await page.route('**/api/cats/runtime-models', (route) => route.fulfill({ json: catalog }));
      await page.reload();
      await page
        .getByRole('button', { name: /隔离测试甲/ })
        .first()
        .click();
      const editor = page.getByTestId('member-settings-page');
      const picker = editor.getByRole('group', { name: '模型', exact: true }).getByRole('combobox');
      await picker.click();
      await editor.getByRole('option', { name: /跟随 Fixture ACP/ }).click();
      await editor.getByText(/默认模型尚未确认/).waitFor();
      const save = editor.getByRole('button', { name: '保存', exact: true });
      assert.equal(await save.isEnabled(), true);
      if (screenshots)
        await page.screenshot({ path: path.join(screenshots, `clear-unconfirmed-model-${options.length}.png`) });
      await save.click();
      await editor.getByRole('status').filter({ hasText: '已保存' }).waitFor();
      const writes = state.writes.filter((write) => write.path === '/api/cats/fixture-a' && write.method === 'PATCH');
      assert.equal(writes.length, 1);
      assert.equal(writes[0].body.defaultModel, '');
      assert.equal(state.cats[0].defaultModel, '');
    } finally {
      await context.close();
    }
  });

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
