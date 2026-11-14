import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../../artifacts/superagent-live', import.meta.url));
const entry = JSON.parse(await readFile(`${root}/active-entry.json`, 'utf8'));
const sources = JSON.parse(await readFile(`${root}/sample-sources.json`, 'utf8'));
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    storageState: `${root}/browser-state.json`,
    viewport: { width: 1440, height: 1000 },
  });
  const foreign = [];
  await context.route(/^https?:\/\/(localhost|127\.0\.0\.1):\d+\//, async (route) => {
    const url = new URL(route.request().url());
    if (!['5220', '3219'].includes(url.port)) {
      foreign.push(url.origin);
      await route.abort();
    } else await route.continue();
  });
  const page = await context.newPage();
  for (const shell of ['v2', 'classic']) {
    await page.goto(`http://127.0.0.1:5220/thread/${sources[0].id}?shell=${shell}`, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    const expand = page.getByRole('button', { name: /^(展开侧栏|Show sidebar)$/ });
    if (await expand.isVisible()) await expand.click();
    await page.getByRole('button', { name: '我的助手 · 验收，监听中', exact: true }).click({ timeout: 60000 });
    await page.waitForURL(`**/thread/${entry.threadId}*`);
    await page.screenshot({ path: `${root}/top-entry-${shell}.png`, fullPage: true });
  }
  assert.deepEqual(foreign, [], 'browser requests must stay in this acceptance instance');
  await writeFile(
    `${root}/browser-navigation.json`,
    JSON.stringify(
      {
        verified: ['real-top-entry-v2', 'real-top-entry-classic', 'existing-main-conversation-navigation'],
        mainThreadId: entry.threadId,
        foreignRequests: foreign,
      },
      null,
      2,
    ),
  );
  console.log('Both real sidebars open the same persistent Bot conversation');
} finally {
  await browser.close();
}
