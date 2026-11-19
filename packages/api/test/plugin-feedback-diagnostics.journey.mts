import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startInstalledFeedbackFixture } from './fixtures/feedback-installed-harness.mts';

const fixture = await startInstalledFeedbackFixture();
const runtime = join(fixture.artifactRoot, 'desktop-runtime-fixture');
await mkdir(join(runtime, 'desktop-dist/resources'), { recursive: true });
await writeFile(join(runtime, 'desktop-dist/resources/app.asar'), '');
process.argv[1] = join(runtime, 'packages/api/dist/domains/plugin/execution-worker/bootstrap.js');
process.env.CAT_CAFE_DESKTOP_STARTUP_ID = 'synthetic-launch-marker';
process.env.CAT_CAFE_RUNTIME_ROOT = runtime;
const browser = await fixture.playwright.chromium.launch({ headless: true, executablePath: process.env.FEEDBACK_CHROMIUM });
try {
  const page = await browser.newPage({ viewport: { width: 856, height: 932 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(fixture.url) ? route.continue() : route.abort());
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.getByRole('button', { name: '问题反馈', exact: true }).click();
  const panel = page.frameLocator('iframe[title="问题反馈"]');
  await panel.getByLabel('描述', { exact: true }).fill('想确认 Fast 模式默认值，以及这次请求是否使用了 Fast。');
  await panel.getByRole('button', { name: '生成分析报告', exact: true }).click();
  await panel.getByRole('button', { name: '准备分析材料', exact: true }).click();
  await panel.getByText('查看将发送的脱敏材料', { exact: true }).click();
  const material = await panel.getByLabel('脱敏分析材料', { exact: true }).inputValue();
  for (const expected of [
    'Windows (win32)', '桌面安装版（已核实打包资源）', '所选项目未发现 Clowder 源码',
    '非标准 API 日志布局', 'E_TIMEOUT', '# 桌面部署', '本次调用的实际值',
  ]) assert.ok(material.includes(expected), expected);
  assert.doesNotMatch(material, /log-secret-canary|synthetic-launch-marker|desktop-runtime-fixture|diagnostic-project/);
  assert.equal(fixture.modelRuns(), 0);
  await page.screenshot({ path: join(fixture.artifactRoot, 'prepared-install-only.png') });
  await panel.getByRole('button', { name: '开始分析', exact: true }).click();
  await panel.getByLabel('报告正文预览').waitFor({ timeout: 20000 });
  assert.equal(fixture.modelRuns(), 1);
  assert.ok(fixture.modelPrompt().endsWith(material));
  assert.match(fixture.modelPrompt(), /只有本次所选项目已检测到 Clowder 源码/);
  assert.equal(fixture.posts(), 0);
  assert.deepEqual(errors, []);
  await writeFile(join(fixture.artifactRoot, 'diagnostics-receipt.json'), JSON.stringify({
    archiveSha256: fixture.ledger.archiveSha256, mode: 'Windows Desktop packaging fixture with no source',
    packageGuideInConfirmedPrompt: true, currentApiClueInPrompt: true, checkoutRequired: false,
    unconfirmedAgentRuns: 0, agentRuns: 1, issuePosts: 0, errors,
  }, null, 2));
  console.log('PASS: archive supplies a confirmed no-source diagnostic, with guide and sanitized API clues');
} finally {
  await browser.close();
  await fixture.stop();
}
