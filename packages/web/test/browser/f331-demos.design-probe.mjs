import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';

// Live author preview: real AppShell, real media and isolated API. No model invocation.
test('F331 real waiting entry, continuous playback, closing and explicit draft', async () => {
  const browser = await chromium.launch({ headless: true });
  const evidence = '/tmp/cat-cafe-evidence/f331-demos';
  await mkdir(evidence, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
    page.setDefaultTimeout(10000);
    await page.goto('http://localhost:5142/dev/f331-demo-preview?shell=v2');
    const sessionResponse = await page.request.get('http://localhost:5142/api/session');
    const { csrfToken } = await sessionResponse.json();
    const headers = { 'x-csrf-token': csrfToken };
    const companionResponse = await page.request.post('http://localhost:5142/api/concierge/thread', { headers });
    assert.equal(companionResponse.ok(), true);
    const { threadId: companionId } = await companionResponse.json();
    await page.request.get(`http://localhost:5142/thread/${companionId}`);
    const draftUrl = `http://localhost:5142/api/threads/${companionId}/composer-draft`;
    const { revision } = await (await page.request.get(draftUrl)).json();
    const saved = await page.request.put(draftUrl, {
      headers,
      data: { expectedRevision: revision, text: '伴随对话里原有的草稿。' },
    });
    assert.equal(saved.ok(), true);
    const watch = page.getByRole('button', { name: '观看演示' });
    await page.screenshot({ path: `${evidence}/before-watch.png` });
    await watch.waitFor();
    await page.locator('textarea').fill('关闭演示后，请保留这段草稿。');
    await page.screenshot({ path: `${evidence}/entry.png` });
    await watch.click();
    await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.5);
    const duration = await page.locator('video').evaluate((video) => video.duration);
    assert.ok(duration >= 48 && duration < 49, `complete cut duration ${duration}`);
    await page.screenshot({ path: `${evidence}/playing.png` });
    // A real stream transition must not remove the root-owned player.
    await page.getByRole('button', { name: '模拟猫开始回复' }).evaluate((button) => button.click());
    assert.equal(await page.locator('dialog[open]').count(), 1);
    const removedVideo = await page.locator('video').elementHandle();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await removedVideo.evaluate((video) => video.paused), true);
    assert.equal(await page.locator('textarea').inputValue(), '关闭演示后，请保留这段草稿。');
    await page.getByRole('button', { name: '恢复等待' }).click();
    await watch.waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${evidence}/mobile-entry.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await watch.click();
    await page.screenshot({ path: `${evidence}/mobile-playing.png` });
    assert.equal(
      await page.locator('dialog').evaluate((node) => node.getBoundingClientRect().width <= innerWidth),
      true,
    );
    await page.getByRole('button', { name: '立即试用', exact: true }).click();
    await page.waitForURL(/\/thread\//, { waitUntil: 'commit' });
    await page.locator('textarea').waitFor();
    await page.waitForFunction(() => document.querySelector('textarea')?.value.includes('提议创建新对话'));
    assert.match(await page.locator('textarea').inputValue(), /伴随对话里原有的草稿。/);
    assert.match(await page.locator('textarea').inputValue(), /提议创建新对话/);
    await page.screenshot({ path: `${evidence}/try-draft.png` });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
