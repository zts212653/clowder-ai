import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { catalog, scene, screenshots } from './f322-members-fixture.mjs';

test('v2 host: filters, keyboard sorting, detail, failed save, discard and exact return', async () => {
  const { context, page, state } = await scene();
  try {
    await page.getByTestId('member-list-page').waitFor();
    await page.getByRole('button', { name: '已停用 1', exact: true }).click();
    assert.equal(await page.locator('tr[data-cat-id]').count(), 1);
    await page.getByRole('button', { name: '全部 3', exact: true }).click();
    await page.getByLabel('排序测试甲').press('ArrowDown');
    await page.waitForFunction(
      () => document.querySelector('tr[data-cat-id]')?.getAttribute('data-cat-id') === 'fixture-b',
    );
    assert.deepEqual(state.order, ['fixture-b', 'fixture-a', 'fixture-c']);
    await page.getByRole('button', { name: /测试甲.*fixture-a/ }).click();
    await page.getByTestId('member-detail-page').waitFor();
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'detail-light.png') });
    await page.locator('input[aria-label="Name"]').fill('修改后的名字');
    await page.getByRole('region', { name: '保存成员设置' }).waitFor();
    assert.equal(
      await page.locator('.member-save-bar').evaluate((bar) => {
        const r = bar.getBoundingClientRect();
        const field = document.querySelector('.member-editor-layout').getBoundingClientRect();
        return Math.abs(r.left - field.left) < 1 && r.bottom <= innerHeight;
      }),
      true,
    );
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'detail-unsaved-light.png') });
    state.rejectSave = true;
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '没有权限' }).waitFor();
    assert.equal(await page.locator('input[aria-label="Name"]').inputValue(), '修改后的名字');
    await page.getByRole('button', { name: '‹ 成员', exact: true }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.locator('input[aria-label="Name"]').inputValue(), '修改后的名字');
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
    assert.equal(await page.locator('input[aria-label="Name"]').inputValue(), '隔离测试甲');
    await page.getByRole('button', { name: '‹ 成员', exact: true }).click();
    assert.equal(await page.locator('tr[data-cat-id]').count(), 3);
    await page.waitForFunction(
      () => document.activeElement?.closest('tr')?.getAttribute('data-cat-id') === 'fixture-a',
    );
    assert.equal(await page.locator('button.member-name:focus').count(), 1);
    await page.getByRole('button', { name: /测试甲.*fixture-a/ }).click();
    await page.locator('input[aria-label="Name"]').fill('保存后的名字');
    state.rejectSave = false;
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '‹ 成员', exact: true }).click();
    await page.getByTestId('member-detail-page').waitFor({ state: 'detached' });
    assert.equal(state.cats.find((cat) => cat.id === 'fixture-a').name, '保存后的名字');
  } finally {
    await context.close();
  }
});
test('protected identity stays locked; deletion uses the original confirmation on disposable members only', async () => {
  const { context, page, state } = await scene(1440, false, false, true);
  try {
    await page.getByTestId('member-list-page').waitFor();
    assert.equal(await page.getByRole('button', { name: '删除成员', exact: true }).count(), 0);
    await page.getByRole('button', { name: /隔离Pro.*gpt-pro/ }).click();
    await page.getByText('受保护成员不能删除。', { exact: true }).waitFor();
    assert.equal(await page.locator('input[aria-label="Model"]').count(), 0);
    assert.equal(await page.locator('#member-advanced').count(), 0);
    assert.equal(await page.getByRole('button', { name: '删除成员', exact: true }).count(), 0);
    await page.locator('input[aria-label="Nickname"]').fill('隔离Pro新昵称');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '‹ 成员', exact: true }).click();
    await page.getByTestId('member-detail-page').waitFor({ state: 'detached' });
    const patch = state.writes.find((write) => write.path === '/api/cats/gpt-pro').body;
    for (const field of state.cats.find((cat) => cat.id === 'gpt-pro').identityProtection.lockedFields)
      assert.equal(field in patch, false, field);
    await page.getByRole('button', { name: /测试乙.*fixture-b/ }).click();
    await page.getByRole('button', { name: '删除成员', exact: true }).click();
    await page
      .getByText(
        `确认删除成员「${state.cats.find((cat) => cat.id === 'fixture-b').displayName}」吗？此操作不可撤销。`,
        {
          exact: true,
        },
      )
      .waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(
      state.cats.some((cat) => cat.id === 'fixture-b'),
      true,
    );
    await page.getByRole('button', { name: '删除成员', exact: true }).click();
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByTestId('member-detail-page').waitFor({ state: 'detached' });
    assert.equal(
      state.cats.some((cat) => cat.id === 'fixture-b'),
      false,
    );
    assert.equal(state.writes.filter((write) => write.method === 'DELETE').length, 1);
  } finally {
    await context.close();
  }
});
test('language and a selected custom theme preserve the dirty draft, focus and return path', async () => {
  const { context, page, state } = await scene();
  try {
    await page.getByTestId('member-list-page').waitFor();
    await page.getByRole('button', { name: /测试甲.*fixture-a/ }).click();
    await page.locator('input[aria-label="Name"]').fill('未保存的草稿');
    await page.locator('input[aria-label="Name"]').focus();
    await page.evaluate(() => {
      window.f322MemberFixture.writeLanguage('en');
      window.f322MemberFixture.selectCustomTheme();
    });
    await page.getByRole('button', { name: 'Save', exact: true }).waitFor();
    assert.equal(await page.locator('input[aria-label="Name"]').inputValue(), '未保存的草稿');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Name');
    assert.equal(await page.evaluate(() => localStorage.getItem('cat-cafe:shell-language')), 'en');
    assert.equal(state.writes.length, 0);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'detail-custom-english.png') });
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await page.getByRole('button', { name: '‹ Members', exact: true }).click();
    await page.getByRole('button', { name: /测试乙.*fixture-b/ }).click();
    await page.getByRole('button', { name: 'Delete member', exact: true }).click();
    await page
      .getByText(
        `Delete member “${state.cats.find((cat) => cat.id === 'fixture-b').displayName}”? This cannot be undone.`,
        {
          exact: true,
        },
      )
      .waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(state.writes.length, 0);
    await page.getByRole('button', { name: '‹ Members', exact: true }).click();
    await page.getByRole('button', { name: 'Add member', exact: true }).click();
    await page.locator('.member-template').filter({ hasText: '墨墨' }).click();
    await page.locator('input[aria-label="Name"]').fill('隔离新增成员');
    await page.getByLabel('Account', { exact: true }).selectOption('claude');
    await page.locator('input[aria-label="Model"]').fill('explicit-test-model');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByTestId('member-detail-page').waitFor({ state: 'detached' });
    const request = state.writes.find((write) => write.path === '/api/cats' && write.method === 'POST');
    assert.equal(request.body.name, '隔离新增成员');
    assert.equal(request.body.defaultModel, 'explicit-test-model');
    assert.equal(request.body.avatar, '/avatars/family/kimi.png');
    assert(request.body.mentionPatterns.length > 0);
  } finally {
    await context.close();
  }
});
test('English at 240px keeps full member names and confines overflow to the table', async () => {
  const { context, page, state } = await scene(240);
  try {
    await page.getByTestId('member-list-page').waitFor();
    state.cats[0].nickname = 'Christopher A Very Long Member Name';
    await page.evaluate(() => window.f322MemberFixture.writeLanguage('en'));
    await page.reload();
    await page.getByTestId('member-list-page').waitFor();
    const panelFits = () =>
      page.evaluate(() => {
        const panel = document.querySelector('[data-trajectory-origin-scroll]');
        return panel.scrollWidth <= panel.clientWidth;
      });
    assert.equal(await panelFits(), true, 'member list expands its host');
    await page.getByRole('button', { name: /Christopher.*fixture-a/ }).click();
    await page.getByTestId('member-detail-page').waitFor();
    assert.equal(await page.locator('.member-page-heading h2').textContent(), state.cats[0].nickname);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'detail-240-before-draft-english.png') });
    if (!(await panelFits()))
      console.log(
        'narrow member overflow',
        await page.evaluate(() => {
          const panel = document.querySelector('[data-trajectory-origin-scroll]');
          const edge = panel.getBoundingClientRect().right;
          return {
            client: panel.clientWidth,
            scroll: panel.scrollWidth,
            nodes: Array.from(document.querySelectorAll('.member-detail-page *, .member-editor-page *'))
              .map((node) => ({
                tag: node.tagName,
                css: node.className,
                text: node.textContent.slice(0, 60),
                right: node.getBoundingClientRect().right,
              }))
              .filter((node) => node.right > edge + 1)
              .slice(0, 24),
          };
        }),
      );
    assert.equal(await panelFits(), true, 'member detail expands its host');
    await page.locator('input[aria-label="Name"]').fill('A narrow dirty draft');
    assert.equal(
      await page.locator('.member-save-bar').evaluate((bar) => {
        const bounds = bar.getBoundingClientRect();
        return Array.from(bar.children).every((child) => {
          const box = child.getBoundingClientRect();
          return box.left >= bounds.left && box.right <= bounds.right;
        });
      }),
      true,
      'save controls escape the narrow bar',
    );
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'detail-240-english.png') });
    await page.locator('#member-voice').scrollIntoViewIfNeeded();
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'detail-240-voice-english.png') });
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await page.getByRole('button', { name: '‹ Members', exact: true }).click();
    await page.getByRole('button', { name: 'Add member', exact: true }).click();
    await page.getByTestId('member-detail-page').waitFor();
    assert.equal(await panelFits(), true, 'member add expands its host');
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'add-240-english.png') });
  } finally {
    await context.close();
  }
});
test('wide, narrow, dark and classic production surfaces; every approved avatar loads', async () => {
  for (const [width, dark, classic] of [
    [1440, false, false],
    [390, true, false],
    [1440, false, true],
  ]) {
    const { context, page } = await scene(width, dark, classic);
    try {
      if (classic) {
        await page.locator('[data-guide-id="cats.first-member"]').waitFor();
        assert.equal(await page.getByTestId('member-list-page').count(), 0);
      } else {
        await page.getByTestId('member-list-page').waitFor();
        if (screenshots)
          await page.screenshot({ path: path.join(screenshots, `members-${width}-${dark ? 'dark' : 'light'}.png`) });
        await page.getByRole('button', { name: '添加成员', exact: true }).click();
        await page.getByTestId('member-detail-page').waitFor();
        await page.locator('.member-template').filter({ hasText: '墨墨' }).click();
        assert.equal(await page.locator('input[aria-label="Name"]').inputValue(), '梵花猫');
        assert.equal(await page.locator('input[aria-label="Model"]').inputValue(), '');
        assert.equal(await page.locator('.member-avatar-option').count(), catalog.length);
        await page.waitForFunction(() =>
          Array.from(document.querySelectorAll('.member-avatar-option img')).every(
            (img) => img.complete && img.naturalWidth > 0 && !img.src.startsWith('data:'),
          ),
        );
        if (screenshots)
          await page.screenshot({ path: path.join(screenshots, `add-${width}-${dark ? 'dark' : 'light'}.png`) });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
    } finally {
      await context.close();
    }
  }
});

// Real table layout catches intrinsic button widths painting across cell borders.
test('long member text stays in its column and reveals full text on hover and focus', async () => {
  const { context, page, state } = await scene();
  try {
    Object.assign(state.cats[2], {
      defaultModel: 'gemini-4-argon-high-with-a-long-native-model-name',
      accountRef: state.accounts[0].id,
      mentionPatterns: ['@a-very-long-member-handle-that-must-not-cover-the-switch'],
    });
    state.accounts[0].displayName = 'A very long OAuth account name that must stay inside its column';
    await page.reload();
    const row = page.locator('tr[data-cat-id="fixture-c"]');
    await row.waitFor();
    for (const selector of ['.member-runtime-summary', '.member-cell-text', '.member-aliases']) {
      const trigger = row.locator(selector).first();
      const bounds = await trigger.evaluate((el) => ({
        right: el.getBoundingClientRect().right,
        cellRight: el.closest('td').getBoundingClientRect().right,
        clipped: el.scrollWidth > el.clientWidth,
      }));
      assert.ok(bounds.right <= bounds.cellRight, `${selector} must stay inside its cell`);
      assert.equal(bounds.clipped, true, `${selector} actually exercises truncation`);
      await trigger.hover();
      const tip = page.getByRole('tooltip');
      await tip.waitFor();
      assert.equal(await tip.innerText(), await trigger.textContent());
      await page.mouse.move(0, 0);
      await page.keyboard.press('Tab');
      await trigger.focus();
      await tip.waitFor();
      assert.equal(await tip.innerText(), await trigger.textContent());
      await page.keyboard.press('Escape');
    }
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'long-member-columns.png') });
  } finally {
    await context.close();
  }
});
