import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startInstalledFeedbackFixture } from './fixtures/feedback-installed-harness.mts';

const fixture = await startInstalledFeedbackFixture();
const browser = await fixture.playwright.chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 2 });
const browserErrors: string[] = [];
page.on('pageerror', (error: Error) => browserErrors.push(error.message));
const cases: object[] = [];
try {
  await page.goto(fixture.url);
  await page.getByRole('button', { name: '问题反馈', exact: true }).click();
  const panel = page.frameLocator('iframe[title="问题反馈"]');
  await panel.getByLabel('描述', { exact: true }).waitFor();
  const description = '长描述与四张图片都应完整保留。'.repeat(30);
  await panel.getByLabel('描述', { exact: true }).fill(description);
  const png = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 40;
      const paint = canvas.getContext('2d')!;
      paint.fillStyle = '#d1a27b';
      paint.fillRect(0, 0, 64, 40);
      return canvas.toDataURL().split(',')[1];
    }),
    'base64',
  );
  for (const images of [0, 1, 4]) {
    while ((await panel.locator('.picture img').count()) < images) {
      await panel.locator('input[type=file]').setInputFiles({
        name: `screenshot-${await panel.locator('.picture img').count()}.png`,
        mimeType: 'image/png',
        buffer: png,
      });
      await panel.locator('input[type=file]:not(:disabled)').waitFor();
    }
    for (const viewport of [
      { width: 1366, height: 768 },
      { width: 720, height: 640 },
      { width: 800, height: 640 },
      { width: 1280, height: 800 },
      { width: 1440, height: 900 },
      { width: 560, height: 700 },
      { width: 420, height: 700 },
      { width: 683, height: 384 },
    ]) {
      await page.setViewportSize(viewport);
      for (const theme of ['light', 'dark']) {
        await page.evaluate((value: string) => (document.documentElement.dataset.theme = value), theme);
        await panel.locator(`html[data-theme=${theme}]`).waitFor({ state: 'attached' });
        // Keep the browser's light OS default; the Host can independently choose dark.
        const frame = page.frames().find((value: { name(): string }) => value.name())!;
        const metrics = await frame.evaluate(() => {
          const content = document.querySelector('.content')!;
          const footer = document.querySelector('footer')!;
          return {
            contentHeight: content.clientHeight,
            contentScrollHeight: content.scrollHeight,
            overflowY: content.scrollHeight - content.clientHeight,
            documentOverflowX: document.documentElement.scrollWidth - innerWidth,
            roleOnFirstPage: Boolean(document.querySelector('#analysis-member')),
            footerVisible: footer.getBoundingClientRect().bottom <= innerHeight,
            background: getComputedStyle(document.documentElement).backgroundColor,
            foreground: getComputedStyle(document.body).color,
            prefersDark: matchMedia('(prefers-color-scheme:dark)').matches,
          };
        });
        const iconBackground = await page
          .locator('#rail [data-plugin-icon]')
          .evaluate((element: Element) => getComputedStyle(element).backgroundColor);
        const hostScheme = await page
          .locator('iframe')
          .evaluate((element: Element) => getComputedStyle(element).colorScheme);
        cases.push({ theme, viewport, images, ...metrics, iconBackground, hostScheme });
        await writeFile(join(fixture.artifactRoot, 'compact-progress.json'), JSON.stringify(cases, null, 2));
        assert.equal(
          metrics.background,
          theme === 'dark' ? 'rgb(33, 31, 27)' : 'rgb(252, 247, 240)',
          'panel follows Host with an independent OS preference',
        );
        assert.equal(metrics.documentOverflowX, 0);
        assert.equal(metrics.footerVisible, true);
        if (viewport.width >= 720)
          assert.equal(metrics.overflowY, 0, `desktop ${viewport.width}x${viewport.height}/${images}/${theme}`);
        if ((viewport.width === 1366 || viewport.width === 720 || viewport.width === 420) && images === 4)
          await page.screenshot({
            path: join(fixture.artifactRoot, `edit-${viewport.width}-${theme}-four-images.png`),
            fullPage: true,
          });
      }
    }
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await panel.getByLabel('描述', { exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(
    await panel.locator('input[type=file]').evaluate((element: Element) => element === document.activeElement),
    true,
    'upload is keyboard reachable',
  );
  await panel.getByRole('button', { name: '生成分析报告', exact: true }).click();
  await panel.getByLabel('分析成员', { exact: true }).selectOption('configured');
  await panel.getByLabel('相关项目目录', { exact: true }).fill(fixture.ledger.dataRoot);
  await page.screenshot({ path: join(fixture.artifactRoot, 'analysis-settings.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
  await page.locator('dialog').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '问题反馈', exact: true }).click();
  await panel.locator('#feedback-body:not(:disabled)').waitFor();
  assert.equal(await panel.getByLabel('描述', { exact: true }).inputValue(), description);
  assert.equal(await panel.locator('.picture img').count(), 4);
  await panel.getByRole('button', { name: '生成分析报告', exact: true }).click();
  assert.equal(await panel.getByLabel('分析成员', { exact: true }).inputValue(), 'configured');
  assert.equal(await panel.getByLabel('相关项目目录', { exact: true }).inputValue(), fixture.ledger.dataRoot);
  await panel.getByRole('button', { name: '准备分析材料', exact: true }).click();
  await panel.getByRole('button', { name: '开始分析', exact: true }).waitFor();
  await panel.getByRole('button', { name: '更改分析设置', exact: true }).click();
  await panel.getByRole('button', { name: '跳过分析', exact: true }).click();
  await panel.getByLabel('报告正文预览').waitFor();
  assert.equal(
    await panel.getByRole('checkbox', { name: '我已检查完整报告和所有图片' }).evaluate((element: Element) => {
      const box = element.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight;
    }),
    true,
    'consent is visible beside submission actions',
  );
  assert.equal(
    await panel.getByText(/^目标：/).evaluate((element: Element) => {
      const box = element.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight;
    }),
    true,
    'destination is visible before the report',
  );
  assert.equal(
    (await panel.getByLabel('Issue 标题', { exact: true }).inputValue()).startsWith('bug: '),
    true,
    'description supplies the initial title',
  );
  await page.screenshot({ path: join(fixture.artifactRoot, 'review.png'), fullPage: true });
  await writeFile(
    join(fixture.artifactRoot, 'compact-receipt.json'),
    JSON.stringify(
      {
        archiveSha256: fixture.ledger.archiveSha256,
        cases,
        browserErrors,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(browserErrors, []);
  assert.ok(
    cases.every((value) => !(value as { roleOnFirstPage: boolean }).roleOnFirstPage),
    'analysis role belongs to the analysis step',
  );
  assert.ok(
    cases.every((value) => (value as { iconBackground: string }).iconBackground === 'rgba(0, 0, 0, 0)'),
    'rail icon must have a transparent background',
  );
} finally {
  await browser.close();
  await fixture.stop();
}
