import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let server;
let browser;
let environment;
let baseUrl = process.env.F293_PREVIEW_URL;
before(async () => {
  if (!baseUrl) {
    const portProbe = createServer();
    portProbe.listen(0, '127.0.0.1');
    await once(portProbe, 'listening');
    const port = portProbe.address().port;
    portProbe.close();
    await once(portProbe, 'close');
    environment = await createNextDevTestEnvironment('f293-human-recovery', {
      NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3194',
    });
    server = spawn(
      process.execPath,
      [path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(port)],
      { cwd: WEB_ROOT, env: environment.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const output = [];
    server.stdout.on('data', (chunk) => output.push(chunk.toString()));
    server.stderr.on('data', (chunk) => output.push(chunk.toString()));
    baseUrl = `http://127.0.0.1:${port}/dev/f293-human-recovery`;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(output.join(''));
      try {
        if ((await fetch(baseUrl)).ok) break;
      } catch {
        /* compiling */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal((await fetch(baseUrl)).status, 200, output.join(''));
  }
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (server.exitCode === null) {
      server.kill('SIGKILL');
      await once(server, 'exit');
    }
  }
  await environment?.cleanup();
});

test(
  'real Chat receipt remains readable, retries explicitly, follows terminal truth, and hydrates without replay',
  {
    timeout: 60_000,
  },
  async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    let status = 'running';
    let posts = 0;
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/debug/callback-auth') {
        await route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"forbidden"}' });
        return;
      }
      let body = {};
      if (url.pathname.endsWith('/retry')) {
        assert.equal(url.pathname, '/api/invocations/f293-preview-invocation/retry');
        assert.equal(route.request().method(), 'POST');
        posts++;
        status = 'running';
        body = { status: 'retrying' };
      } else if (url.pathname === '/api/invocations/f293-preview-invocation') {
        body = { status };
      } else if (url.pathname === '/api/cats') {
        body = { cats: [] };
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      const blocked = page.getByRole('region', { name: '自动发送被拦截' });
      await blocked.getByText('这条正在执行').waitFor();
      status = 'failed';
      await blocked.getByRole('button', { name: '重试这条' }).waitFor();
      assert.equal(posts, 0, 'polling terminal state never retries');
      assert.match(await blocked.innerText(), /本次未执行/);
      assert.doesNotMatch(await blocked.innerText(), /quota_exhausted|@antigravity|可考虑/);
      assert.match(await page.getByRole('region', { name: '人工主动尝试' }).innerText(), /仍会按你的选择尝试/);
      for (const [width, theme] of [
        [1100, 'light'],
        [360, 'light'],
        [360, 'dark'],
      ]) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (process.env.F293_EVIDENCE_DIR) {
          await mkdir(process.env.F293_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({
            path: path.join(process.env.F293_EVIDENCE_DIR, `${width}-${theme}.png`),
            fullPage: true,
          });
        }
      }
      await blocked.getByRole('button', { name: '重试这条' }).click();
      await blocked.getByText('已提交重试').waitFor();
      assert.equal(posts, 1);
      status = 'succeeded';
      await blocked.getByText('这条已执行').waitFor();
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByText('这条已执行').waitFor();
      assert.equal(posts, 1, 'refreshing completed history does not replay it');
      assert.deepEqual(pageErrors, []);
    } finally {
      await page.close();
    }
  },
);
