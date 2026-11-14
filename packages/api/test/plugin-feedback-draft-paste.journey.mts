import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startInstalledFeedbackFixture } from './fixtures/feedback-installed-harness.mts';

const fixture = await startInstalledFeedbackFixture();
const browser = await fixture.playwright.chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1200, height: 980 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await context.newPage();
try {
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  let failSave = false;
  await page.route(
    '**/api/plugins/*/feedback',
    async (route: {
      request(): { postDataJSON(): { op?: string } };
      fulfill(input: object): Promise<void>;
      continue(): Promise<void>;
    }) => {
      if (failSave && route.request().postDataJSON()?.op === 'save')
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'fixture-save-unavailable' }),
        });
      else await route.continue();
    },
  );
  await page.goto(fixture.url);
  const open = async () => {
    await page.getByRole('button', { name: '问题反馈', exact: true }).click();
    await panel.locator('[data-save-status], [data-publish], .success').first().waitFor({ state: 'attached' });
    await panel.locator('button:enabled').first().waitFor();
  };
  const close = () => page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
  const panel = page.frameLocator('iframe[title="问题反馈"]');
  await open();
  await panel.getByLabel('描述').fill('输入后立即关闭，不手动保存');
  await close();
  await page.locator('dialog').waitFor({ state: 'detached' });
  await open();
  assert.equal(await panel.getByLabel('描述').inputValue(), '输入后立即关闭，不手动保存');

  await panel.getByText('分析与投递设置', { exact: true }).click();
  await panel.getByLabel('相关项目目录', { exact: true }).fill(fixture.ledger.dataRoot);
  await panel.getByLabel('分析成员', { exact: true }).selectOption('configured');
  await close();
  await page.locator('dialog').waitFor({ state: 'detached' });
  await open();
  await panel.getByText('分析与投递设置', { exact: true }).click();
  assert.equal(await panel.getByLabel('相关项目目录', { exact: true }).inputValue(), fixture.ledger.dataRoot);
  assert.equal(await panel.getByLabel('分析成员', { exact: true }).inputValue(), 'configured');

  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    canvas.getContext('2d')!.fillRect(0, 0, 32, 32);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await panel.getByLabel('描述').focus();
  await page.keyboard.press('ControlOrMeta+V');
  await panel.locator('.picture img').waitFor();
  assert.equal(await panel.getByLabel('描述').inputValue(), '输入后立即关闭，不手动保存');
  await panel
    .locator('input[type=file]')
    .setInputFiles({ name: 'local.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await panel.locator('.picture img').nth(1).waitFor();
  await panel.getByLabel('描述').fill('粘贴与本地图片一起保留');
  await close();
  await page.locator('dialog').waitFor({ state: 'detached' });
  await page.reload();
  await open();
  assert.equal(await panel.getByLabel('描述').inputValue(), '粘贴与本地图片一起保留');
  assert.equal(await panel.locator('.picture img').count(), 2);
  await page.screenshot({ path: join(fixture.artifactRoot, 'restored-draft.png'), fullPage: true });

  await panel.getByLabel('描述').fill('Escape 前的最后输入');
  await page.keyboard.press('Escape');
  await page.locator('dialog').waitFor({ state: 'detached' });
  await open();
  assert.equal(await panel.getByLabel('描述').inputValue(), 'Escape 前的最后输入');

  failSave = true;
  await panel.getByLabel('描述').fill('保存失败时保留窗口和输入');
  await close();
  await panel.getByRole('alert').filter({ hasText: 'fixture-save-unavailable' }).waitFor();
  assert.equal(await panel.getByLabel('描述').inputValue(), '保存失败时保留窗口和输入');
  await page.screenshot({ path: join(fixture.artifactRoot, 'save-failure.png'), fullPage: true });
  failSave = false;
  await close();
  await page.locator('dialog').waitFor({ state: 'detached' });
  await open();
  assert.equal(await panel.getByLabel('描述').inputValue(), '保存失败时保留窗口和输入');

  const frame = page.frames().find((value: { name(): string }) => value.name())!;
  await frame.evaluate(
    `window.decodeImage=createImageBitmap;window.createImageBitmap=async file=>{await new Promise(resolve=>window.finishDecode=resolve);return window.decodeImage(file)}`,
  );
  await panel.getByLabel('描述').focus();
  await page.keyboard.press('ControlOrMeta+V');
  await panel.locator('#feedback-body:disabled').waitFor();
  await close();
  assert.equal(await page.locator('iframe').count(), 1);
  await frame.evaluate('window.finishDecode()');
  await page.locator('dialog').waitFor({ state: 'detached' });
  await open();
  assert.equal(await panel.locator('.picture img').count(), 3);

  await panel.getByRole('button', { name: '直接反馈', exact: true }).click();
  await panel.getByRole('button', { name: '编辑正文', exact: true }).click();
  await panel.getByLabel('报告正文', { exact: true }).fill('检查报告时的修改也要保存');
  await panel.locator('[data-save-status]').filter({ hasText: '草稿已保存到反馈记录' }).waitFor();
  await close();
  await page.locator('dialog').waitFor({ state: 'detached' });
  await open();
  await panel.getByLabel('报告正文预览').waitFor();
  assert.equal(await panel.getByLabel('报告正文预览').innerText(), '检查报告时的修改也要保存');
  await panel.locator('header').getByRole('button', { name: '新建反馈', exact: true }).click();
  assert.equal(await panel.getByLabel('描述').inputValue(), '');
  await close();
  await page.locator('dialog').waitFor({ state: 'detached' });
  await open();
  assert.equal(await panel.getByLabel('描述').inputValue(), '');
  await panel.locator('header').getByRole('button', { name: '反馈记录', exact: true }).click();
  await panel.locator('.history-item').waitFor();
  assert.equal(await panel.locator('.history-item').count(), 1);
  await panel.getByRole('button', { name: '继续投递', exact: true }).click();
  const sentImage = await panel.locator('.picture img').last().getAttribute('src');
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: '确认上传', exact: true }).click();
  await panel.getByRole('heading', { name: '✓ 反馈已提交，感谢你的帮助', exact: true }).waitFor();
  assert.equal(fixture.posts(), 1);
  assert.ok(fixture.uploadedBytes().equals(Buffer.from(sentImage.split(',')[1], 'base64')));
  await page.screenshot({ path: join(fixture.artifactRoot, 'submitted.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(
    join(fixture.artifactRoot, 'draft-paste-receipt.json'),
    JSON.stringify(
      {
        archiveSha256: fixture.ledger.archiveSha256,
        checks: [
          'immediate X save and resume',
          'analysis member and project scope persist when only settings change',
          'real clipboard PNG paste',
          'local file selection',
          'refresh recovery with both images',
          'Escape save',
          'save failure keeps editor open and retry persists',
          'close waits for image normalization',
          'review edits persist',
          'explicit new remains blank and history is retained',
          'pasted image submission and verified bytes through isolated Issue fixture',
        ],
        externalIssuePosts: fixture.posts(),
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
  process.stdout.write('PASS: installed feedback draft / clipboard / close journey\n');
} catch (error) {
  await page.screenshot({ path: join(fixture.artifactRoot, 'failure.png'), fullPage: true });
  await writeFile(
    join(fixture.artifactRoot, 'failure-dom.json'),
    JSON.stringify(
      {
        error: String(error),
        frames: await Promise.all(
          page
            .frames()
            .map(
              async (frame: { evaluate(action: () => string): Promise<string> }) =>
                await frame.evaluate(() => document.body.innerText),
            ),
        ),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
  await fixture.stop();
}
