import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { origin } from './fixtures/f322-chat-real-page-build.mjs';
import { createThreadDeleteProof } from './fixtures/thread-delete-proof.mjs';

const evidence = process.env.THREAD_MENU_EVIDENCE_DIR ?? path.join(tmpdir(), 'cat-cafe-evidence', 'sidebar-menu');
let proof;
before(
  async () => {
    proof = await createThreadDeleteProof(evidence);
    Array.from({ length: 30 }, (_, index) => proof.store.create(proof.owner, `菜单定位验收会话 ${index + 1}`));
  },
  { timeout: 180_000 },
);
after(async () => proof?.close());

[
  { shell: 'classic', language: 'zh', width: 1228, label: '复制 Thread ID', copied: '已复制' },
  { shell: 'v2', language: 'zh', width: 360, label: '复制 Thread ID', copied: '已复制' },
  { shell: 'v2', language: 'en', width: 1228, label: 'Copy Thread ID', copied: 'Copied' },
].forEach((scenario) => {
  test(`copies the full thread ID through the real menu (${scenario.shell}, ${scenario.language})`, async (t) => {
    const context = await proof.browser.newContext({ viewport: { width: scenario.width, height: 700 } });
    t.after(() => context.close());
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await context.addInitScript(({ shell, language }) => {
      localStorage.setItem('cat-cafe:shell-presentation', shell);
      localStorage.setItem('cat-cafe:shell-language', language);
    }, scenario);
    const thread = proof.store.create(proof.owner, '复制 ID 的当前会话');
    const other = proof.store.create(proof.owner, '复制 ID 的另一会话');
    const page = await proof.openPage(context, `/thread/${thread.id}`);
    if (scenario.width === 360) await page.evaluate(() => window.__threadDeleteTheme('dark'));
    const list = page.getByTestId('sidebar-thread-list');
    for (const id of [thread.id, other.id]) {
      const row = list.locator(`[data-thread-id="${id}"]`);
      await row.getByRole('button', { name: '更多操作', exact: true }).click();
      const menu = page.getByRole('menu', { name: '对话操作', exact: true });
      const copy = menu.getByRole('menuitem', { name: scenario.label, exact: true });
      await copy.focus();
      await page.keyboard.press('Enter');
      await copy.getByText(scenario.copied, { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), id);
      assert.equal(new URL(page.url()).pathname, `/thread/${thread.id}`);
      await assertVisibleMenu(menu);
      await page.screenshot({
        path: path.join(
          evidence,
          `copy-id-${scenario.shell}-${scenario.language}-${id === thread.id ? 'active' : 'inactive'}.png`,
        ),
      });
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      assert.equal(
        await row
          .getByRole('button', { name: '更多操作', exact: true })
          .evaluate((element) => element === document.activeElement),
        true,
      );
    }
    assert.deepEqual(proof.errors, []);
  });
});

[
  { name: 'bottom-v2', shell: 'v2', width: 1228, height: 700, bottom: true },
  { name: 'bottom-classic', shell: 'classic', width: 1228, height: 700, bottom: true },
  { name: 'narrow-dark', shell: 'v2', width: 360, height: 700, bottom: true },
  { name: 'top-v2', shell: 'v2', width: 1228, height: 700, bottom: false },
].forEach((scenario) => {
  test(
    `${scenario.name}: conversation menus are immediately visible without scrolling the sidebar`,
    { timeout: 90_000 },
    async (t) => {
      const context = await proof.browser.newContext({ viewport: { width: scenario.width, height: scenario.height } });
      t.after(() => context.close());
      await context.addInitScript(
        (shell) => localStorage.setItem('cat-cafe:shell-presentation', shell),
        scenario.shell,
      );
      const page = await proof.openPage(context);
      if (scenario.name === 'narrow-dark') await page.evaluate(() => window.__threadDeleteTheme('dark'));
      const list = page.getByTestId('sidebar-thread-list');
      await list.evaluate((element, bottom) => {
        element.scrollTop = bottom ? element.scrollHeight : 0;
      }, scenario.bottom);
      const rows = list.locator('[data-thread-id]');
      const row = scenario.bottom ? rows.last() : rows.first();
      await row.hover();
      const trigger = row.getByRole('button', { name: '更多操作', exact: true });
      const scrollBefore = await list.evaluate((element) => element.scrollTop);
      await trigger.click();
      const menu = page.getByRole('menu', { name: '对话操作', exact: true });
      await menu.waitFor();
      const visibility = await assertVisibleMenu(menu);
      await page.screenshot({ path: path.join(evidence, `${scenario.name}.png`) });
      writeFileSync(path.join(evidence, `${scenario.name}.json`), JSON.stringify(visibility, null, 2));
      const anchor = await trigger.boundingBox();
      assert.ok(scenario.bottom ? visibility.bottom <= anchor.y - 4 : visibility.top >= anchor.y + anchor.height + 4);
      assert.equal(
        await list.evaluate((element) => element.scrollTop),
        scrollBefore,
        'opening must not scroll the conversation list',
      );
      await page.keyboard.press('End');
      assert.equal(await page.locator(':focus').innerText(), '删除对话');
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.locator(':focus').innerText(), '对话设置');

      const exportItem = menu.getByRole('menuitem', { name: '导出对话', exact: true });
      await exportItem.focus();
      await page.keyboard.press('ArrowRight');
      const formats = page.getByRole('menu', { name: '导出格式', exact: true });
      await assertVisibleMenu(formats);
      await page.screenshot({ path: path.join(evidence, `${scenario.name}-export.png`) });
      await page.keyboard.press('Escape');
      await formats.waitFor({ state: 'detached' });
      assert.equal(await exportItem.evaluate((element) => element === document.activeElement), true);
      assert.equal(await menu.count(), 1);
      await exportItem.click();
      await page.route('**/api/export/thread/*', (route) =>
        route.fulfill({ contentType: 'text/markdown', body: '# isolated export' }),
      );
      const download = page.waitForEvent('download');
      await formats.getByRole('menuitem').filter({ hasText: 'Markdown' }).click();
      assert.ok((await download).suggestedFilename().endsWith('.md'));
      await menu.waitFor({ state: 'detached' });
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');

      await trigger.focus();
      await page.keyboard.press('ArrowDown');
      await menu.waitFor();
      assert.equal(await page.locator(':focus').innerText(), '对话设置');
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
      await trigger.click();
      await page.keyboard.press('Tab');
      await menu.waitFor({ state: 'detached' });
      await trigger.click();
      await list.evaluate((element) => {
        element.scrollTop += element.scrollTop ? -20 : 20;
      });
      await menu.waitFor({ state: 'detached' });
      await trigger.click();
      await page.getByRole('main').click({ position: { x: 10, y: 160 } });
      await menu.waitFor({ state: 'detached' });
      if (scenario.name === 'bottom-v2') {
        await trigger.click();
        await page.setViewportSize({ width: 900, height: 900 });
        await menu.waitFor({ state: 'detached' });
        await page.setViewportSize({ width: 900, height: 300 });
        await list.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await list.locator('[data-thread-id]').last().getByRole('button', { name: '更多操作', exact: true }).click();
        await menu.waitFor();
        const box = await menu.boundingBox();
        assert.ok(box.y >= 8 && box.y + box.height <= 292);
        assert.equal(await menu.evaluate((element) => element.scrollHeight > element.clientHeight), true);
        const shortScrollBefore = await list.evaluate((element) => element.scrollTop);
        await page.keyboard.press('End');
        assert.equal(await page.locator(':focus').innerText(), '删除对话');
        assert.equal(await list.evaluate((element) => element.scrollTop), shortScrollBefore);
        await page.screenshot({ path: path.join(evidence, 'short-window.png') });
        await menu.getByRole('menuitem', { name: '删除对话', exact: true }).click();
        await page.getByRole('dialog', { name: '确认删除对话' }).waitFor();
        await page.getByRole('button', { name: '取消', exact: true }).click();
      }
      assert.deepEqual(proof.errors, []);
    },
  );
});

test('scroll and Tab respect the menu anchor and leave the whole menu hierarchy', { timeout: 90_000 }, async (t) => {
  const context = await proof.browser.newContext({ viewport: { width: 1228, height: 700 } });
  t.after(() => context.close());
  await context.addInitScript(() => localStorage.setItem('cat-cafe:shell-presentation', 'v2'));
  const page = await proof.openPage(context);
  const list = page.getByTestId('sidebar-thread-list');
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const row = list.locator('[data-thread-id]').last();
  const trigger = row.getByRole('button', { name: '更多操作', exact: true });
  const menu = page.getByRole('menu', { name: '对话操作', exact: true });
  const formats = page.getByRole('menu', { name: '导出格式', exact: true });
  const main = page.getByRole('main');
  await main.evaluate((element) => {
    const content = document.createElement('div');
    content.style.height = '2000px';
    element.append(content);
  });
  await trigger.click();
  assert.equal(
    await menu
      .getByRole('menuitem')
      .first()
      .evaluate((element) => element === document.activeElement),
    true,
  );
  const anchor = await trigger.boundingBox();
  await main.hover();
  await page.mouse.wheel(0, 120);
  await page.waitForFunction(() => document.querySelector('main').scrollTop > 0);
  assert.deepEqual(await trigger.boundingBox(), anchor);
  assert.equal(await menu.count(), 1, 'unrelated scrolling must leave the anchored menu open');
  assert.equal(
    await menu
      .getByRole('menuitem')
      .first()
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await menu.getByRole('menuitem', { name: '导出对话', exact: true }).click();
  await main.hover();
  const previousScroll = await main.evaluate((element) => element.scrollTop);
  await page.mouse.wheel(0, 120);
  await page.waitForFunction((previous) => document.querySelector('main').scrollTop > previous, previousScroll);
  await assertVisibleMenu(formats);
  assert.equal(
    await formats
      .getByRole('menuitem')
      .first()
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await list.evaluate((element) => {
    element.scrollTop -= 20;
  });
  await menu.waitFor({ state: 'detached' });
  assert.equal(await formats.count(), 0);
  assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);

  for (const child of [false, true]) {
    for (const key of ['Tab', 'Shift+Tab']) {
      await trigger.click();
      if (child) await menu.getByRole('menuitem', { name: '导出对话', exact: true }).click();
      await page.keyboard.press(key);
      await menu.waitFor({ state: 'detached' });
      assert.equal(await formats.count(), 0);
      const destination = key === 'Tab' ? page.getByTestId('trash-bin-toggle') : row.getByRole('link');
      assert.equal(await destination.evaluate((element) => element === document.activeElement), true);
    }
  }
  await trigger.click();
  const pageControl = main.getByRole('button', { name: '个人设置', exact: true });
  await pageControl.focus();
  await list.evaluate((element) => {
    element.scrollTop -= 20;
  });
  await menu.waitFor({ state: 'detached' });
  assert.equal(await pageControl.evaluate((element) => element === document.activeElement), true);

  await page.setViewportSize({ width: 900, height: 300 });
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await trigger.click();
  const exportItem = menu.getByRole('menuitem', { name: '导出对话', exact: true });
  await exportItem.click();
  await formats.waitFor();
  const sidebarScroll = await list.evaluate((element) => element.scrollTop);
  await menu.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await formats.waitFor({ state: 'detached' });
  assert.equal(await menu.count(), 1, 'scrolling the parent menu closes only its anchored child');
  assert.equal(await exportItem.evaluate((element) => element === document.activeElement), true);
  assert.equal(await list.evaluate((element) => element.scrollTop), sidebarScroll);
  assert.deepEqual(proof.errors, []);
});

async function assertVisibleMenu(menu) {
  await menu.waitFor();
  const visibility = await menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const items = [...element.querySelectorAll('[role="menuitem"]')].map((item) => {
      const box = item.getBoundingClientRect();
      return {
        text: item.textContent,
        hit: item.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)),
      };
    });
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      viewportHeight: innerHeight,
      viewportWidth: innerWidth,
      items,
    };
  });
  assert.ok(visibility.top >= 8 && visibility.bottom <= visibility.viewportHeight - 8, JSON.stringify(visibility));
  assert.ok(visibility.left >= 8 && visibility.right <= visibility.viewportWidth - 8, JSON.stringify(visibility));
  assert.ok(
    visibility.items.every((item) => item.hit),
    'every menu action must be directly clickable',
  );
  return visibility;
}
