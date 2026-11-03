import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const evidence = fileURLToPath(new URL('../../../../artifacts/superagent-preview/', import.meta.url));
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
const apiRequests = new Set();
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('request', (request) => {
  if (request.url().includes('/api/')) apiRequests.add(request.url());
});
await page.goto('http://127.0.0.1:5214/dev/superagent-preview?shell=v2', {
  waitUntil: 'domcontentloaded',
  timeout: 90_000,
});
await page.getByRole('heading', { name: '我的助手', exact: true }).waitFor();
await page.getByRole('link', { name: /我的助手/ }).waitFor();
await page.screenshot({ path: `${evidence}/desktop.png`, fullPage: true });
console.log(JSON.stringify({ firstRender: (await page.locator('body').innerText()).slice(0, 3500), pageErrors }));
assert.deepEqual(pageErrors, []);
await page.getByRole('button', { name: '监听范围', exact: true }).click();
const scope = page.getByRole('dialog');
await scope.getByRole('checkbox').nth(0).uncheck();
await scope.getByRole('checkbox').nth(1).uncheck();
assert.equal(await scope.getByRole('button', { name: '保存并监听' }).isDisabled(), true);
await scope.getByRole('checkbox').nth(0).check();
await scope.getByRole('checkbox').nth(1).check();
await page.screenshot({ path: `${evidence}/scope-desktop.png`, fullPage: true });
await page.keyboard.press('Escape');
assert.equal(await scope.isVisible(), false);
await page.getByRole('button', { name: '样例：原话题收到反馈' }).click();
assert.equal(await page.getByRole('button', { name: /^修复导出失败/ }).count(), 1);
assert.equal(await page.getByRole('button', { name: /^准备发布说明/ }).count(), 1);
await page.getByRole('button', { name: '稳定性优先', exact: true }).click();
assert.equal(await page.getByRole('region', { name: '发布优先级决定' }).count(), 0);
await page.getByRole('button', { name: '样例：工作完成' }).click();
await page.getByRole('button', { name: '查看原处交付' }).click();
assert.equal(await page.getByRole('region', { name: '原话题样例' }).count(), 1);
await page.screenshot({ path: `${evidence}/delivery.png`, fullPage: true });
await page.getByLabel('体验场景').selectOption('active');
await page.getByRole('button', { name: '暂停', exact: true }).click();
assert.equal(await page.getByRole('textbox', { name: '回复我的助手' }).isDisabled(), true);
await page.screenshot({ path: `${evidence}/paused.png`, fullPage: true });
await page.getByLabel('体验场景').selectOption('error');
await page.getByRole('button', { name: '重试连接' }).click();
assert.equal(await page.getByRole('textbox', { name: '回复我的助手' }).isEnabled(), true);
await page.getByLabel('体验场景').selectOption('uninstalled');
assert.equal(await page.getByRole('link', { name: /我的助手/ }).count(), 0);
await page.getByRole('button', { name: '安装并设置' }).click();
await scope.getByRole('button', { name: '启用监听' }).click();
assert.equal(await page.getByRole('link', { name: /我的助手/ }).count(), 1);
await page.setViewportSize({ width: 390, height: 844 });
await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.getByRole('button', { name: '稳定性优先', exact: true }).waitFor();
await page.waitForFunction(() => {
  const button = [...document.querySelectorAll('button')].find(
    (element) => element.textContent.trim() === '稳定性优先',
  );
  const form = document.querySelector('form');
  if (!button || !form) return false;
  const bounds = button.getBoundingClientRect();
  return bounds.y >= 0 && bounds.bottom <= form.getBoundingClientRect().top;
});
await page.screenshot({ path: `${evidence}/mobile.png`, fullPage: true });
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
await page.getByRole('button', { name: '监听范围', exact: true }).click();
assert.equal(await scope.evaluate((element) => element.getBoundingClientRect().width <= innerWidth), true);
await page.screenshot({ path: `${evidence}/scope-mobile.png`, fullPage: true });
await page.keyboard.press('Escape');
assert.deepEqual(pageErrors, []);
assert.equal(apiRequests.size, 0);
await writeFile(
  `${evidence}/probe.json`,
  JSON.stringify(
    {
      kind: 'synthetic-design-preview',
      pageErrors,
      apiRequests: [...apiRequests],
      verified: [
        'native-sidebar-v2',
        'scope-empty-and-escape',
        'feedback-keeps-two-items',
        'decision-and-delivery',
        'pause-and-repair',
        'install-setup',
        '390px',
      ],
      notVerified: [
        'real-plugin-install',
        'real-events',
        'semantic-intake',
        'real-member-execution',
        'restart-recovery',
        'macOS',
        'classic-shell',
      ],
    },
    null,
    2,
  ),
);
await browser.close();
console.log(`Synthetic design probe passed. Evidence: ${evidence}`);
