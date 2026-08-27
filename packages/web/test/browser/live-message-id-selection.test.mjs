import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');
const LIVE_MESSAGE_ID = 'msg-inv-live-selection-id-codex-sol';
const PERSISTED_MESSAGE_ID = 'persisted-live-selection-id';

async function findFreePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  server.close();
  await once(server, 'close');
  return address.port;
}

async function waitForPage(url, server, output) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited before readiness:\n${output.join('')}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The dev server is still compiling or has not opened its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}:\n${output.join('')}`);
}

async function stopServer(server) {
  if (server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

test(
  'a just-finished message exports and forwards a CLI quote with its persisted ID without refresh',
  { timeout: 90_000 },
  async () => {
    const port = await findFreePort();
    const output = [];
    const server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
      cwd: WEB_ROOT,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (chunk) => output.push(chunk.toString()));
    server.stderr.on('data', (chunk) => output.push(chunk.toString()));

    let browser;
    try {
      const url = `http://127.0.0.1:${port}/dev/f294-live-selection-id`;
      await waitForPage(url, server, output);
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
      let exportBody;
      let forwardBody;

      await page.route('**/api/session', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
      );
      await page.route('**/api/cats', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            cats: [
              {
                id: 'codex-sol',
                displayName: '缅因猫 Sol',
                color: { primary: '#6b8f34', secondary: '#c8d8b5' },
                mentionPatterns: ['codex-sol'],
                clientId: 'openai',
                defaultModel: 'gpt-5.6-sol',
                avatar: '/avatars/codex.png',
                roleDescription: '小太阳型攻坚猫',
                personality: 'warm',
                roster: { available: true },
              },
            ],
          }),
        }),
      );
      await page.route('**/api/config/cat-order', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: '{"catOrder":["codex-sol"]}' }),
      );
      await page.route('**/api/threads/thread-live-selection-id/export-selection-image', async (route) => {
        exportBody = route.request().postDataJSON();
        await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('fixture-png') });
      });
      await page.route('**/api/messages', async (route) => {
        forwardBody = route.request().postDataJSON();
        const item = forwardBody?.messageBundle?.items?.[0];
        const sourceIds = item?.sourceMessageIds;
        const valid = Array.isArray(sourceIds) && sourceIds.includes(item?.messageId);
        await route.fulfill({
          status: valid ? 200 : 400,
          contentType: 'application/json',
          body: JSON.stringify(
            valid ? { messageBundleId: 'bundle-live-selection-id' } : { error: 'Invalid request body' },
          ),
        });
      });

      await page.goto(url, { waitUntil: 'networkidle' });
      const article = page.getByTestId('live-message-identity-probe');
      await article.waitFor();
      assert.equal(await article.getAttribute('data-message-id'), LIVE_MESSAGE_ID);
      assert.equal(await article.getAttribute('data-message-streaming'), 'true');

      await page.getByRole('button', { name: '完成并立即选中' }).click();
      await page.waitForFunction(
        (persistedId) =>
          document.querySelector('article[data-message-id]')?.getAttribute('data-message-id') === persistedId,
        PERSISTED_MESSAGE_ID,
      );
      assert.equal(await article.getAttribute('data-message-streaming'), 'false');
      assert.equal(await page.locator('[data-rich-block-title]').textContent(), '刚完成的响应式富文本');

      await page.getByRole('button', { name: '长图' }).click();
      await page.waitForFunction(() => document.querySelector('[data-export-status]')?.textContent === 'exported');
      assert.deepEqual(exportBody, {
        items: [{ kind: 'message', messageId: PERSISTED_MESSAGE_ID }],
      });

      await page.getByTestId('message-selection-toolbar').getByRole('button', { name: '取消' }).click();
      const selectedText = await page.evaluate(() => {
        const segment = document.querySelector(
          '[data-testid="live-cli-forward-source"] [data-context-quote-segment-id="stdout"]',
        );
        if (!segment) throw new Error('live CLI source segment did not render');
        const walker = document.createTreeWalker(segment, NodeFilter.SHOW_TEXT);
        let textNode = walker.nextNode();
        while (textNode && !textNode.textContent?.includes('刚完成的 CLI 输出正文')) textNode = walker.nextNode();
        if (!textNode?.textContent) throw new Error('live CLI source text did not render');
        const text = '刚完成的 CLI 输出正文';
        const start = textNode.textContent.indexOf(text);
        const range = document.createRange();
        range.setStart(textNode, start);
        range.setEnd(textNode, start + text.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return selection?.toString() ?? '';
      });
      assert.equal(selectedText, '刚完成的 CLI 输出正文');

      await page.getByTestId('message-selection-add-to-chat').click();
      await page.getByTestId('context-annotation-forward').click();
      const picker = page.getByRole('dialog', { name: '转发到' });
      await picker.getByRole('button', { name: /接收测试线程/ }).click();
      await picker.getByRole('button', { name: /缅因猫 Sol/ }).click();
      await picker.getByRole('button', { name: '转发 1 段引用', exact: true }).click();
      await picker.waitFor({ state: 'hidden' });

      assert.equal(forwardBody?.messageBundle?.items?.[0]?.messageId, PERSISTED_MESSAGE_ID);
      assert.deepEqual(forwardBody?.messageBundle?.items?.[0]?.sourceMessageIds, [PERSISTED_MESSAGE_ID]);
    } finally {
      await browser?.close();
      await stopServer(server);
    }
  },
);
