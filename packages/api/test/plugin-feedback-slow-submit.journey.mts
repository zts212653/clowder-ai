import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Response as BrowserResponse, Request } from 'playwright';
import { startInstalledFeedbackFixture } from './fixtures/feedback-installed-harness.mts';

const fixture = await startInstalledFeedbackFixture();
const browser = await fixture.playwright.chromium.launch({
  headless: true,
  ...(process.env.FEEDBACK_CHROMIUM ? { executablePath: process.env.FEEDBACK_CHROMIUM } : {}),
});
const originalFetch = globalThis.fetch;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(fixture.url);
  await page.getByRole('button', { name: '问题反馈', exact: true }).click();
  const panel = page.frameLocator('iframe[title="问题反馈"]');
  await panel.getByLabel('标题（选填）').fill('Slow browser submission');
  await panel.getByLabel('描述').fill('Isolated provider: three valid eleven-second calls');
  await panel.getByRole('button', { name: '直接反馈', exact: true }).click();
  await panel.getByRole('checkbox', { name: '我已检查完整报告和所有图片' }).check();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (
      url.startsWith('https://gitlab.example.test') &&
      (url.endsWith('/user') || (url.endsWith('/issues') && init?.method === 'POST') || /\/issues\/\d+$/.test(url))
    )
      await delay(11_000, undefined, { signal: init?.signal ?? undefined });
    return originalFetch(input, init);
  };
  const isSubmit = (request: Request) =>
    request.method() === 'POST' &&
    request.url().endsWith('/api/plugins/official.feedback/feedback') &&
    request.postDataJSON().op === 'submit';
  const outcome = Promise.race([
    page
      .waitForResponse((response: BrowserResponse) => isSubmit(response.request()), { timeout: 60_000 })
      .then(
        async (response: BrowserResponse) => ({ status: response.status(), body: await response.json() }),
        (error: Error) => ({ status: 0, error: error.message }),
      ),
    page.waitForEvent('requestfailed', { predicate: isSubmit, timeout: 60_000 }).then(
      (request: Request) => ({ status: 0, error: request.failure()?.errorText }),
      (error: Error) => ({ status: 0, error: error.message }),
    ),
  ]);
  const started = Date.now();
  await panel.getByRole('button', { name: '确认上传', exact: true }).click();
  const result = await outcome;
  const receipt = { ...result, elapsedMs: Date.now() - started, createdIssues: fixture.posts(), browserErrors: errors };
  await writeFile(join(fixture.artifactRoot, 'slow-submit-receipt.json'), JSON.stringify(receipt, null, 2));
  await page.screenshot({ path: join(fixture.artifactRoot, 'slow-submit-result.png'), fullPage: true });
  console.log(JSON.stringify(receipt));
  assert.equal(result.status, 200, 'the actual browser session client must outlive a 33-second submission');
  assert.ok('body' in result && result.body.journal.state === 'published');
  assert.equal(fixture.posts(), 1);
  await panel.getByRole('link', { name: '打开 Issue', exact: true }).waitFor();
  assert.deepEqual(errors, []);
} finally {
  globalThis.fetch = originalFetch;
  await browser.close();
  await fixture.stop();
}
