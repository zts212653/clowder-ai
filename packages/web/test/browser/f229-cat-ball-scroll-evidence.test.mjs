import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const playwrightModule = process.env.F229_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.F229_PLAYWRIGHT_MODULE).href
  : new URL('../../../ppt-forge/node_modules/playwright/index.mjs', import.meta.url).href;
const { chromium } = await import(playwrightModule);

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');
const EVIDENCE_DIR = process.env.F229_SCROLL_EVIDENCE_DIR ?? path.join(tmpdir(), 'cat-cafe-evidence', 'f229-scroll');

let server;
let browser;
let environment;
let baseUrl;

async function freePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 30_000 + Math.floor(Math.random() * 10_000);
    const socket = createServer();
    try {
      socket.listen(port, '127.0.0.1');
      await once(socket, 'listening');
      socket.close();
      await once(socket, 'close');
      return port;
    } catch {
      socket.close();
    }
  }
  throw new Error('No available browser fixture port in 30000-39999');
}

function messages(prefix) {
  return Array.from({ length: 32 }, (_, index) => ({
    id: `${prefix}-${index}`,
    type: 'assistant',
    catId: 'codex-sol',
    content: `${prefix} message ${index + 1}. ${'This is synthetic browser evidence for independent scroll state. '.repeat(3)}`,
    timestamp: 1_700_000_000_000 + index,
    ...(index === 0
      ? {
          extra: {
            rich: {
              v: 1,
              blocks: [
                {
                  id: `${prefix}-layout-widget`,
                  kind: 'html_widget',
                  v: 1,
                  title: `${prefix} layout widget`,
                  html: `<html><body style="margin:0"><main style="height:1200px">${prefix} synthetic layout content</main></body></html>`,
                  height: 720,
                },
              ],
            },
          },
        }
      : {}),
  }));
}

before(
  async () => {
    await mkdir(EVIDENCE_DIR, { recursive: true });
    const port = await freePort();
    environment = await createNextDevTestEnvironment('f229-scroll', { NEXT_PUBLIC_API_URL: '' });
    const output = [];
    server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
      cwd: WEB_ROOT,
      env: environment.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    server.stdout.on('data', (chunk) => output.push(chunk.toString()));
    server.stderr.on('data', (chunk) => output.push(chunk.toString()));
    baseUrl = `http://127.0.0.1:${port}/dev/f229-cat-ball-scroll`;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(output.join(''));
      try {
        if ((await fetch(baseUrl)).ok) break;
      } catch {
        // Next is still starting or compiling the fixture.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal((await fetch(baseUrl)).status, 200, output.join(''));
    browser = await chromium.launch({ headless: true });
  },
  { timeout: 210_000 },
);

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  await environment?.cleanup();
});

test(
  'real Cat Ball panel scrolls independently from full thread and preserves full remount offset',
  { timeout: 120_000 },
  async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });
    await page.route('**/api/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const hasMessages = pathname.includes('/messages');
      const hasCats = pathname === '/api/cats';
      const body = hasMessages
        ? { messages: messages(pathname.includes('concierge') ? 'Cat Ball B' : 'Full A'), tasks: [], hasMore: false }
        : hasCats
          ? { cats: [] }
          : { error: 'unavailable in isolated browser fixture' };
      return route.fulfill({
        status: hasMessages || hasCats ? 200 : 403,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      const full = page.getByTestId('full-surface-host').locator('[data-chat-container]');
      const dialog = page.getByRole('dialog', { name: /Cat Ball B.*对话气泡/ });
      const compact = dialog.locator('[data-chat-container]');
      await full.waitFor({ timeout: 15_000 });
      await compact.waitFor({ timeout: 15_000 });
      await page.waitForFunction(() => {
        const surfaces = [...document.querySelectorAll('[data-chat-container]')];
        return surfaces.length === 2 && surfaces.every((element) => element.scrollHeight > element.clientHeight + 200);
      });
      await page.waitForTimeout(500);

      await full.evaluate((element) => {
        element.scrollTop = 220;
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
      });
      const fullOffset = await full.evaluate((element) => element.scrollTop);
      assert(fullOffset > 100, `full thread must be scrolled up: ${fullOffset}`);
      await compact.evaluate((element) => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
        element.scrollTop = 0;
      });
      const jump = dialog.getByRole('button', { name: '到最新' });
      await jump.waitFor();
      await page.waitForTimeout(150);
      assert.equal(await compact.evaluate((element) => element.scrollTop), 0);
      await page.screenshot({ path: path.join(EVIDENCE_DIR, '01-before-jump.png'), fullPage: true });

      await jump.click();
      await page.waitForFunction(() => {
        const element = document.querySelector('[role="dialog"] [data-chat-container]');
        return element && element.scrollHeight - element.clientHeight - element.scrollTop <= 120;
      });
      assert.equal(await full.evaluate((element) => element.scrollTop), fullOffset);
      await page.screenshot({ path: path.join(EVIDENCE_DIR, '02-after-jump.png'), fullPage: true });

      await page.getByTestId('append-concierge-message').click();
      await dialog.getByText(/New Cat Ball message/).waitFor();
      await page.waitForFunction(() => {
        const element = document.querySelector('[role="dialog"] [data-chat-container]');
        return element && element.scrollHeight - element.clientHeight - element.scrollTop <= 120;
      });
      assert.equal(await full.evaluate((element) => element.scrollTop), fullOffset);
      await page.screenshot({ path: path.join(EVIDENCE_DIR, '03-after-append.png'), fullPage: true });

      await page.getByTestId('toggle-full-surface').click();
      await full.waitFor({ state: 'detached' });
      await page.getByTestId('toggle-full-surface').click();
      await full.waitFor();
      await page.waitForFunction((expected) => {
        const element = document.querySelector('[data-testid="full-surface-host"] [data-chat-container]');
        return element && Math.abs(element.scrollTop - expected) <= 5;
      }, fullOffset);
      await page.screenshot({ path: path.join(EVIDENCE_DIR, '04-full-remount-restored.png'), fullPage: true });
      console.log(JSON.stringify({ fullOffset, restoredOffset: await full.evaluate((element) => element.scrollTop) }));

      // Exercise the real HtmlWidgetBlock producer in both mounted surfaces.
      await full.evaluate((element) => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
        element.scrollTop = 200;
      });
      await compact.evaluate((element) => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
        element.scrollTop = 600;
      });
      const fullWidget = full.locator('[data-html-widget="Full A-layout-widget"]');
      const compactWidget = compact.locator('[data-html-widget="Cat Ball B-layout-widget"]');
      await fullWidget.getByRole('button', { name: '展开完整内容' }).waitFor();
      await compactWidget.getByRole('button', { name: '展开完整内容' }).waitFor();
      await page.waitForTimeout(250);
      const compactReadingOffset = await compact.evaluate((element) => element.scrollTop);
      assert.equal(compactReadingOffset, 600);
      await fullWidget.getByRole('button', { name: '展开完整内容' }).click();
      await fullWidget.getByRole('button', { name: '收起完整内容' }).waitFor();
      await page.waitForTimeout(250);
      assert.equal(await compact.evaluate((element) => element.scrollTop), compactReadingOffset);
      await fullWidget.getByRole('button', { name: '收起完整内容' }).click();
      await fullWidget.getByRole('button', { name: '展开完整内容' }).waitFor();
      await page.waitForTimeout(250);
      assert.equal(await compact.evaluate((element) => element.scrollTop), compactReadingOffset);
      await page.screenshot({ path: path.join(EVIDENCE_DIR, '05-full-widget-compact-preserved.png'), fullPage: true });

      const fullReadingOffset = await full.evaluate((element) => element.scrollTop);
      await compactWidget.getByRole('button', { name: '展开完整内容' }).click();
      await compactWidget.getByRole('button', { name: '收起完整内容' }).waitFor();
      await page.waitForTimeout(250);
      assert.equal(await full.evaluate((element) => element.scrollTop), fullReadingOffset);
      await compactWidget.getByRole('button', { name: '收起完整内容' }).click();
      await compactWidget.getByRole('button', { name: '展开完整内容' }).waitFor();
      await page.waitForTimeout(250);
      assert.equal(await full.evaluate((element) => element.scrollTop), fullReadingOffset);
      await page.screenshot({ path: path.join(EVIDENCE_DIR, '06-compact-widget-full-preserved.png'), fullPage: true });
      const compactPostDisclosureOffset = await compact.evaluate((element) => element.scrollTop);
      await page.getByTestId('toggle-full-surface').click();
      await full.waitFor({ state: 'detached' });
      await page.getByTestId('toggle-full-surface').click();
      await full.waitFor();
      await page.waitForFunction((expected) => {
        const element = document.querySelector('[data-testid="full-surface-host"] [data-chat-container]');
        return element && Math.abs(element.scrollTop - expected) <= 5;
      }, fullReadingOffset);
      assert.equal(await compact.evaluate((element) => element.scrollTop), compactPostDisclosureOffset);
      await page.screenshot({
        path: path.join(EVIDENCE_DIR, '07-widget-reading-remount-restored.png'),
        fullPage: true,
      });
      console.log(
        JSON.stringify({
          compactReadingOffset,
          compactPostDisclosureOffset,
          fullReadingOffset,
          widgetDirections: 'full↔compact',
        }),
      );
    } catch (error) {
      await page
        .screenshot({ path: path.join(EVIDENCE_DIR, 'failed-browser-state.png'), fullPage: true })
        .catch(() => {});
      console.error({
        pageErrors: pageErrors.slice(0, 8),
        body: await page
          .locator('body')
          .innerText()
          .catch(() => ''),
      });
      throw error;
    } finally {
      await context.close();
    }
  },
);
