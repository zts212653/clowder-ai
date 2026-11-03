import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../../artifacts/superagent-live', import.meta.url));
const origin = 'http://127.0.0.1:5220';
const api = 'http://127.0.0.1:3219';
const sources = JSON.parse(await readFile(`${root}/sample-sources.json`, 'utf8'));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  storageState: `${root}/browser-state.json`,
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(`${origin}/settings?s=plugins&plugin=official.superagent&shell=v2`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await page.getByLabel('允许处理的工作', { exact: true }).waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: /安装插件/ }).click();
  const upload = page.waitForResponse(
    (response) => response.url().endsWith('/install/upload') && response.request().method() === 'POST',
    { timeout: 120000 },
  );
  await page.locator('input[type=file]').first().setInputFiles(process.env.SUPERAGENT_ARCHIVE_PATH);
  const installed = await upload;
  if (installed.status() === 409) await page.getByRole('button', { name: '确认替换', exact: true }).click();
  else assert.ok(installed.ok(), await installed.text());
  console.log('Artifact uploaded through the real plugin page');
  await page.getByRole('button', { name: '暂停新接单与派发', exact: true }).waitFor({ timeout: 120000 });
  if (await page.getByRole('button', { name: '启用Superagent', exact: true }).last().isVisible())
    await page.getByRole('button', { name: '启用Superagent', exact: true }).last().click();
  await page.getByRole('button', { name: '禁用Superagent', exact: true }).last().waitFor({ timeout: 60000 });
  await page.getByLabel('助手名称', { exact: true }).fill('我的助手 · 验收');
  await page
    .getByLabel('允许处理的工作', { exact: true })
    .fill(
      `只处理本次隔离测试 ${root}/sample-work 中的样例文件任务；可以创建、修改并读取验证样例，不提交、不发布、不安装依赖。含糊请求先问清楚；原会话反馈沿同一 Work；交付后等待人接受。`,
    );
  const saved = page.waitForResponse(
    (response) => response.url().endsWith('/contributions/configuration') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  assert.ok((await saved).ok(), 'the real configuration save must succeed');
  console.log('Configuration saved');
  await page.getByRole('button', { name: '选择成员和会话', exact: true }).click();
  await page.getByTestId('official.superagent-row-coordinator:codex-acceptance-action-choose').click();
  await page.getByText('已选协调成员：砚砚 · 隔离验收', { exact: true }).waitFor();
  console.log('Coordinator selected');
  const worker = page.getByTestId('official.superagent-row-worker:codex-acceptance-action-choose');
  if ((await worker.textContent()) === '选用') await worker.click();
  await page
    .getByTestId('official.superagent-row-worker:codex-acceptance-action-choose')
    .filter({ hasText: '取消' })
    .waitFor();
  for (const source of sources) {
    const button = page.getByTestId(`official.superagent-row-${source.id}-action-choose`);
    if ((await button.textContent()) === '监听') await button.click();
    await page.getByTestId(`official.superagent-row-${source.id}-action-choose`).filter({ hasText: '移除' }).waitFor();
  }
  const started = page.waitForResponse(
    (response) => response.url().endsWith('/actions/activity/enable') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '确认并开始跟进', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
  const response = await started;
  assert.ok(response.ok(), await response.text());
  await page.screenshot({ path: `${root}/settings-active.png`, fullPage: true });
  const entries = await (await context.request.get(`${api}/api/plugin-conversations`)).json();
  const entry = entries.entries.find((entry) => entry.pluginId === 'official.superagent');
  assert.equal(entry.status, 'listening');
  assert.ok(entry.threadId);
  await writeFile(`${root}/active-entry.json`, JSON.stringify(entry, null, 2));
  await page.goto(`${origin}/?shell=v2`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const expand = page.getByRole('button', { name: /^(展开侧栏|Show sidebar)$/ });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: '我的助手 · 验收，监听中', exact: true }).click({ timeout: 60000 });
  await page.waitForURL(`**/thread/${entry.threadId}*`);
  await page.screenshot({ path: `${root}/main-active.png`, fullPage: true });
  await context.storageState({ path: `${root}/browser-state.json` });
  await writeFile(
    `${root}/browser-settings.json`,
    JSON.stringify(
      {
        kind: 'real-host-real-settings',
        errors,
        mainThreadId: entry.threadId,
        sourceThreadIds: sources.map((source) => source.id),
        verified: [
          'tgz-upload-replacement',
          'host-enable',
          'config-save',
          'member-select',
          'scope-select',
          'confirmed-start',
          'top-entry-navigation',
        ],
        notVerified: ['real-model-work', 'macOS'],
      },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
} finally {
  await page.screenshot({ path: `${root}/settings-last.png`, fullPage: true });
  await writeFile(`${root}/settings-last.txt`, await page.locator('body').innerText());
  await browser.close();
}
