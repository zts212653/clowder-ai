import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { scene, screenshots } from './f322-members-fixture.mjs';

test('template add keeps the account required in both languages, focuses it and makes no POST until selected', async () => {
  for (const language of ['zh', 'en']) {
    const { context, page, state } = await scene(390);
    try {
      await page.getByTestId('member-list-page').waitFor();
      await page.evaluate((lang) => window.f322MemberFixture.writeLanguage(lang), language);
      await page.getByRole('button', { name: language === 'zh' ? '添加成员' : 'Add member', exact: true }).click();
      await page.locator('.member-template').filter({ hasText: '墨墨' }).click();
      const account = page.getByLabel('Account', { exact: true });
      assert.equal(await account.inputValue(), '');
      const alert = page
        .getByRole('alert')
        .filter({ hasText: language === 'zh' ? '还差 1 项才能添加：账号。' : '1 more field needed to add: Account.' });
      await alert.waitFor();
      await page.locator('[data-trajectory-origin-scroll]').evaluate((node) => {
        node.scrollTop = 0;
      });
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `alpha-required-${language}.png`) });
      await page.getByRole('button', { name: language === 'zh' ? '添加' : 'Add', exact: true }).click();
      assert.equal(state.writes.length, 0);
      assert.equal(await account.getAttribute('aria-invalid'), 'true');
      await page.waitForFunction(() => {
        const account = document.querySelector('[aria-label="Account"]'),
          rect = account.getBoundingClientRect();
        return document.activeElement === account && rect.top >= 0 && rect.bottom <= innerHeight;
      });
      const alertBox = await alert.boundingBox();
      const accountBox = await account.boundingBox();
      assert.ok(alertBox && alertBox.y >= 0 && alertBox.y + alertBox.height < page.viewportSize().height - 70);
      assert.ok(
        accountBox && alertBox.y + alertBox.height <= accountBox.y,
        'required hint does not cover the focused account',
      );
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `alpha-account-focus-${language}.png`) });
      await account.selectOption('claude');
      await page.locator('input[aria-label="Model"]').fill('explicit-model');
      assert.equal(await account.getAttribute('aria-invalid'), null);
      await page.getByRole('button', { name: language === 'zh' ? '添加' : 'Add', exact: true }).click();
      await page.getByTestId('member-detail-page').waitFor({ state: 'detached' });
      const posts = state.writes.filter((write) => write.path === '/api/cats' && write.method === 'POST');
      assert.equal(posts.length, 1);
      assert.equal(posts[0].body.accountRef, 'claude');
      assert.equal(posts[0].body.defaultModel, 'explicit-model');
    } finally {
      await context.close();
    }
  }
});

test('saved context capability stays attached to its strategy through draft, discard, save and read-back', async () => {
  const { context, page, state } = await scene(390);
  try {
    await page.getByTestId('member-list-page').waitFor();
    await page.evaluate(() => window.f322MemberFixture.writeLanguage('en'));
    await page.getByRole('button', { name: /测试甲.*fixture-a/ }).click();
    const section = page.locator('#member-context');
    await section.getByTestId('member-context-status').filter({ hasText: 'Available' }).waitFor();
    assert.equal(await section.locator('input[type="range"]').first().getAttribute('aria-label'), '提醒线');
    assert.equal(await section.locator('input[type="range"]').last().getAttribute('aria-label'), '记录线');
    assert((await section.innerText()).includes('no reminder, no hand-off'));
    const strategy = section.locator('select');
    await strategy.selectOption('hybrid');
    const status = section.getByTestId('member-context-status');
    assert((await status.innerText()).includes('This strategy has not been saved'));
    assert.equal((await status.innerText()).includes('Available'), false);
    assert.equal(state.writes.length, 0);
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    assert.equal(await strategy.inputValue(), 'compress');
    assert((await status.innerText()).includes('Available'));
    await strategy.selectOption('hybrid');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.member-save-bar [role="status"]').filter({ hasText: 'Saved' }).waitFor();
    await page.getByRole('button', { name: '‹ Members', exact: true }).click();
    await page.getByTestId('member-detail-page').waitFor({ state: 'detached' });
    assert.deepEqual(
      state.writes.map((write) => write.path),
      ['/api/config/session-strategy/fixture-a', '/api/cats/fixture-a'],
    );
    await page.getByRole('button', { name: /测试甲.*fixture-a/ }).click();
    const savedStatus = page.getByTestId('member-context-status');
    await savedStatus.filter({ hasText: 'Will not run' }).waitFor();
    assert((await savedStatus.innerText()).includes('Compress, then hand off'));
    assert.equal((await savedStatus.innerText()).includes('Available'), false);
    await savedStatus.scrollIntoViewIfNeeded();
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'alpha-context-readback.png') });
    await page.getByRole('button', { name: '‹ Members', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: /测试甲.*fixture-a/ }).click();
    await page.getByTestId('member-context-status').filter({ hasText: 'Will not run' }).waitFor();
  } finally {
    await context.close();
  }
});

test('API key account uses a localized complete CLI request hint without translating its URL', async () => {
  const accounts = [
    {
      id: 'claude',
      name: 'Test endpoint',
      displayName: 'Test endpoint',
      clientId: 'anthropic',
      authType: 'api_key',
      kind: 'api_key',
      builtin: false,
      models: ['native-model'],
      baseUrl: 'https://endpoint.example/v1',
    },
  ];
  const { context, page } = await scene(390, false, false, false, { accounts });
  try {
    await page.getByTestId('member-list-page').waitFor();
    await page.evaluate(() => window.f322MemberFixture.writeLanguage('en'));
    await page.getByRole('button', { name: /测试甲.*fixture-a/ }).click();
    const hint = page.getByText('claude CLI request: https://endpoint.example/v1/messages', { exact: true });
    await hint.waitFor();
    assert.equal((await page.getByTestId('member-detail-page').innerText()).includes('CLI 实际调用'), false);
    assert.equal(await page.getByLabel('Model', { exact: true }).getAttribute('placeholder'), 'Model ID');
    await hint.scrollIntoViewIfNeeded();
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'alpha-cli-english.png') });
  } finally {
    await context.close();
  }
});
