import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startInstalledFeedbackFixture } from './fixtures/feedback-installed-harness.mts';

const format = (provider: 'github' | 'gitlab') => (provider === 'github' ? 'GitHub' : 'GitLab');
for (const provider of ['github', 'gitlab'] as const) {
  const name = format(provider);
  const fixture = await startInstalledFeedbackFixture(provider);
  const browser = await fixture.playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: provider === 'github' ? { width: 920, height: 730 } : { width: 420, height: 650 },
  });
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  let pluginSawToken = false;
  let writes = 0;
  let conflict = true;
  let pauseReturn = false;
  await page.route('**/api/plugins/*/feedback', async (route) => {
    pluginSawToken ||= /synthetic-token|invalid-synthetic-credential/.test(route.request().postData() ?? '');
    await route.continue();
  });
  await page.route('**/api/plugin-manager/plugins/official.feedback/contributions/configuration', async (route) => {
    writes++;
    if (conflict) await route.fulfill({ status: 409, json: { error: 'synthetic conflict' } });
    else await route.continue();
  });
  await page.route('**/api/plugin-ui', async (route) => {
    if (pauseReturn) await route.fulfill({ status: 503, body: '' });
    else await route.continue();
  });
  try {
    await page.goto(fixture.url);
    if (provider === 'gitlab') await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    await page.getByRole('button', { name: '问题反馈', exact: true }).click();
    const frame = page.locator('iframe[title="问题反馈"]');
    const panel = frame.contentFrame();
    const initialFrame = await frame.getAttribute('name');
    const description = '这条报告在配置访问令牌时应保留。'.repeat(12);
    await panel.getByLabel('描述', { exact: true }).fill(description);
    if (provider === 'gitlab') {
      const png = await page.evaluate(() => document.createElement('canvas').toDataURL('image/png').split(',')[1]);
      await panel.locator('input[type=file]').setInputFiles(
        Array.from({ length: 4 }, (_, i) => ({
          name: `screenshot-${i + 1}.png`,
          mimeType: 'image/png',
          buffer: Buffer.from(png, 'base64'),
        })),
      );
      await panel.locator('.picture img').nth(3).waitFor();
    }
    await panel.getByRole('button', { name: '直接反馈', exact: true }).click();
    const openConfig = panel.getByRole('button', { name: `配置 ${name} 访问令牌`, exact: true });
    const replaceConfig = panel.getByRole('button', { name: `更换 ${name} 访问令牌`, exact: true });
    const upload = panel.getByRole('button', { name: '确认上传', exact: true });
    const manual = panel.getByRole('link', { name: '手动创建', exact: true });
    const dialog = page.getByRole('dialog', { name: `配置 ${name} 访问令牌`, exact: true });
    const token = dialog.getByLabel(`${name} 访问令牌`, { exact: true });

    await openConfig.click();
    assert.equal(await token.getAttribute('type'), 'password');
    assert.equal(await panel.locator('input[type=password]').count(), 0);
    await page.keyboard.press('Escape');
    await openConfig.waitFor();
    assert.equal(await upload.isDisabled(), true);
    await panel.getByRole('checkbox').check();
    assert.equal(await manual.getAttribute('aria-disabled'), 'false');
    assert.equal(writes, 0);

    await openConfig.click();
    await token.waitFor();
    await page.screenshot({ path: join(fixture.artifactRoot, `token-dialog-${provider}.png`) });
    await token.fill('invalid-synthetic-credential');
    await dialog.getByRole('button', { name: '保存并继续' }).click();
    await dialog
      .getByRole('alert')
      .getByText(/配置已变化/)
      .waitFor();
    conflict = false;
    await dialog.getByRole('button', { name: '保存并继续' }).click();
    await replaceConfig.waitFor();
    assert.equal(await upload.isDisabled(), true);

    await replaceConfig.click();
    await token.fill('synthetic-token');
    pauseReturn = true;
    await dialog.getByRole('button', { name: '保存并继续' }).click();
    await dialog
      .getByRole('alert')
      .getByText(/令牌已保存/)
      .waitFor();
    assert.equal(await token.count(), 0);
    pauseReturn = false;
    await dialog.getByRole('button', { name: '重试返回报告' }).click();
    await dialog.waitFor({ state: 'detached' });
    await panel.getByRole('checkbox').waitFor({ state: 'visible' });
    assert.equal(await frame.getAttribute('name'), initialFrame);
    assert.equal(await replaceConfig.count(), 0);
    assert.ok((await panel.locator('.report-preview').innerText()).includes(description));
    assert.equal(await panel.locator('.picture img').count(), provider === 'gitlab' ? 4 : 0);
    assert.equal(await upload.isDisabled(), true);
    assert.equal(fixture.posts(), 0);
    assert.equal(writes, 3);

    await panel.getByRole('checkbox').check();
    await upload.click();
    await panel.getByText('✓ 反馈已提交，感谢你的帮助', { exact: true }).waitFor();
    assert.equal(fixture.posts(), 1);
    assert.equal(pluginSawToken, false);
    assert.deepEqual(errors, []);
    await writeFile(
      join(fixture.artifactRoot, `token-${provider}.json`),
      JSON.stringify(
        {
          provider,
          archiveSha256: fixture.ledger.archiveSha256,
          sameFrame: true,
          writes,
          posts: fixture.posts(),
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    await fixture.stop();
  }
}
