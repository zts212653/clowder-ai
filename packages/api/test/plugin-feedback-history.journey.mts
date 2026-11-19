import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startInstalledFeedbackFixture } from './fixtures/feedback-installed-harness.mts';

const fixture = await startInstalledFeedbackFixture();
const browser = await fixture.playwright.chromium.launch({ headless: true, executablePath: process.env.FEEDBACK_CHROMIUM });
try {
  const page = await browser.newPage({ viewport: { width: 856, height: 932 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(12000);
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(fixture.url) ? route.continue() : route.abort());
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.getByRole('button', { name: '问题反馈', exact: true }).click();
  const panel = page.frameLocator('iframe[title="问题反馈"]');
  const field = panel.getByLabel('描述', { exact: true });
  const newFeedback = () => panel.locator('header').getByRole('button', { name: '新建反馈', exact: true }).click();
  await field.fill('这条草稿仍可继续填写');
  await panel.getByRole('button', { name: '保存草稿', exact: true }).click();
  await panel.getByText('草稿已保存到反馈记录', { exact: true }).waitFor();
  await newFeedback();
  const body = '点击工具栏切换失败\n\n## 问题摘要\n切换时停留在同一个工具页。\n\n' +
    Array.from({ length: 18 }, (_, i) => `段落 ${i + 1}：在桌面反馈中重现问题，确认当前状态与预期不一致。\n\n`).join('') +
    '## 最后一段\n这里是投递过的报告结尾。';
  await field.fill(body);
  await panel.getByRole('button', { name: '直接反馈', exact: true }).click();
  await panel.getByRole('checkbox', { name: /我已检查报告/ }).check();
  await panel.getByRole('button', { name: '提交正文', exact: true }).click();
  await panel.getByRole('link', { name: '打开 Issue #1', exact: true }).waitFor();
  await panel.locator('header').getByRole('button', { name: '反馈记录', exact: true }).click();
  const published = panel.locator('.history-item').filter({ hasText: '点击工具栏切换失败' });
  const draft = panel.locator('.history-item').filter({ hasText: '这条草稿仍可继续填写' });
  const number = published.getByRole('link', { name: '打开 Issue #1', exact: true });
  const issueUrl = await number.getAttribute('href');
  assert.match(issueUrl ?? '', /issues\/1$/);
  assert.equal(await draft.getByRole('link', { name: /打开 Issue/ }).count(), 0);
  await page.screenshot({ path: join(fixture.artifactRoot, 'numbered-history.png') });
  await published.getByRole('button', { name: '查看反馈', exact: true }).click();
  await panel.getByText('投递时的报告', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('link', { name: '打开 Issue #1', exact: true }).getAttribute('href'), issueUrl);
  const reader = panel.getByRole('region', { name: '阅读报告正文' });
  assert.match(await reader.innerText(), /切换时停留在同一个工具页/);
  assert.equal(await panel.locator('textarea').count(), 0);
  assert.equal(await panel.getByRole('button', { name: '提交正文', exact: true }).count(), 0);
  await page.screenshot({ path: join(fixture.artifactRoot, 'published-report-desktop.png') });
  await page.setViewportSize({ width: 420, height: 650 });
  await reader.press('End');
  const geometry = await reader.evaluate(el => {
    const region = el.getBoundingClientRect();
    const last = el.querySelector('article > :last-child')!.getBoundingClientRect();
    return { bottomVisible: last.bottom <= region.bottom + 1, scrollTop: el.scrollTop,
      pageOverflow: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      contentOverflow: el.closest('.published-report')!.scrollWidth - el.closest('.published-report')!.clientWidth };
  });
  assert.equal(geometry.bottomVisible, true);
  assert.ok(geometry.scrollTop > 0);
  assert.equal(geometry.pageOverflow, 0);
  assert.equal(geometry.contentOverflow, 0);
  await page.screenshot({ path: join(fixture.artifactRoot, 'published-report-narrow-last-page.png') });
  await panel.getByRole('button', { name: '补充截图', exact: true }).click();
  await panel.getByLabel('选择本地图片', { exact: true }).waitFor({ state: 'attached' });
  assert.equal(await panel.getByRole('link', { name: '打开 Issue #1', exact: true }).getAttribute('href'), issueUrl);
  await panel.getByRole('button', { name: '返回投递报告', exact: true }).click();
  await reader.waitFor();
  assert.equal(await reader.evaluate(el => el.scrollTop), geometry.scrollTop);
  await panel.getByRole('button', { name: '返回记录', exact: true }).click();
  await number.waitFor();
  await draft.getByRole('button', { name: '继续填写', exact: true }).click();
  assert.equal(await field.inputValue(), '这条草稿仍可继续填写');
  assert.equal(fixture.posts(), 1);
  assert.deepEqual(errors, []);
  await writeFile(join(fixture.artifactRoot, 'published-history-receipt.json'), JSON.stringify({
    archiveSha256: fixture.ledger.archiveSha256, listShowsIssueNumber: true, originallySubmittedBodyReadable: true,
    checkedSameIssue: true, screenshotReturnPreservesReadingPosition: true, savedDraftUnchanged: true,
    geometry, fixtureIssuePosts: 1, publicWrites: 0, errors,
  }, null, 2));
  console.log('PASS: history shows the Issue number, opens submitted Markdown, and preserves supplement/navigation');
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  await page?.screenshot({ path: join(fixture.artifactRoot, 'failure.png') });
  throw error;
} finally {
  await browser.close();
  await fixture.stop();
}
