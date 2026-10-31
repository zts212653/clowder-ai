import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { COMPANION_THREAD, createEntryFixture, OTHER_THREAD, PNG } from './f317-companion-entry.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function createCompanionEntryHarness() {
  let processHandle, browser, environment, origin;
  const log = [];
  async function start() {
    const preparation = spawnSync(process.execPath, [path.resolve(root, 'scripts/sync-vendor-assets.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(preparation.status, 0, preparation.stderr);
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    assert(address && typeof address !== 'string');
    const port = address.port;
    probe.close();
    await once(probe, 'close');
    origin = `http://127.0.0.1:${port}`;
    environment = await createNextDevTestEnvironment('f317-companion-entry', {
      NEXT_PUBLIC_API_URL: origin,
      API_SERVER_PORT: String(port),
    });
    processHandle = spawn(
      process.execPath,
      [path.resolve(root, '../../node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(port)],
      { cwd: root, env: environment.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    processHandle.stdout.on('data', (x) => log.push(x.toString()));
    processHandle.stderr.on('data', (x) => log.push(x.toString()));
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if (processHandle.exitCode !== null) throw Error(log.join(''));
      try {
        if ((await fetch(origin)).ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    browser = await chromium.launch({ headless: true });
  }
  async function open(mode = 'missing', width = 1280, presentation = 'v2') {
    const fixture = createEntryFixture(mode);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.route('**/api/**', fixture.handle);
    await page.route('**/uploads/f317-synthetic.png', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
    );
    await page.routeWebSocket(/socket\.io/, (socket) => socket.close());
    await page.addInitScript(() => {
      window.__captureAttempts = [];
      if (navigator.mediaDevices)
        for (const name of ['getUserMedia', 'getDisplayMedia'])
          Object.defineProperty(navigator.mediaDevices, name, {
            value: async () => {
              window.__captureAttempts.push(name);
              throw Error('No media in migration acceptance');
            },
          });
    });
    await page.goto(`${origin}/thread/${OTHER_THREAD}?shell=${presentation}`, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await page.getByRole('textbox', { name: '消息输入框' }).waitFor({ state: 'visible', timeout: 60000 });
    // The SSR textbox exists before React can own typing. This entry appears only after client config hydration.
    await page.getByTestId('concierge-rail-toggle').waitFor({ state: 'visible' });
    async function companion() {
      try {
        await page.getByTestId('concierge-rail-toggle').click();
        await page.waitForURL(`**/thread/${COMPANION_THREAD}`);
        await page.getByRole('region', { name: '伴随对话入口' }).waitFor({ state: 'visible' });
      } catch (error) {
        const state = await page.evaluate(() => ({
          url: location.href,
          text: document.body.innerText.slice(0, 6000),
          entry: document.querySelector('[data-testid="concierge-rail-toggle"]')?.outerHTML,
          regions: [...document.querySelectorAll('[aria-label]')].map((x) => x.getAttribute('aria-label')),
        }));
        if (process.env.F317_SUNSET_SCREENSHOTS)
          await page.screenshot({ path: `${process.env.F317_SUNSET_SCREENSHOTS}/failed-entry.png` });
        throw new Error(
          JSON.stringify({
            cause: String(error),
            state,
            errors,
            requests: fixture.calls.filter((x) => /concierge|messages|session/.test(x.path)),
          }),
          { cause: error },
        );
      }
    }
    return { page, context, fixture, errors, companion, origin, close: () => context.close() };
  }
  async function stop() {
    await browser?.close();
    if (processHandle?.exitCode === null) {
      processHandle.kill('SIGTERM');
      await Promise.race([once(processHandle, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (processHandle.exitCode === null) {
        processHandle.kill('SIGKILL');
        await once(processHandle, 'exit');
      }
    }
    await environment?.cleanup();
  }
  return { start, open, stop, logs: () => log.join('') };
}
