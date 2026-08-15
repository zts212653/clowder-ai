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
      // The server is still compiling or has not opened its socket yet.
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
  'selection toolbar fits the 360px viewport chat canvas without clipping 44px targets',
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
      const url = `http://127.0.0.1:${port}/dev/f294-selection-toolbar-preview`;
      await waitForPage(url, server, output);
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
      await page.goto(url, { waitUntil: 'networkidle' });

      const metrics = await page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="chat-canvas"]');
        const toolbar = document.querySelector('[data-testid="message-selection-toolbar"]');
        const actions = document.querySelector('[data-testid="message-selection-actions"]');
        const cancel = document.querySelector('button[aria-label="取消"]');
        const actionButtons = Array.from(actions?.querySelectorAll('button') ?? []);
        if (!canvas || !toolbar || !actions || !cancel) throw new Error('F294 layout fixture did not render');
        return {
          canvas: { clientWidth: canvas.clientWidth, scrollWidth: canvas.scrollWidth },
          toolbar: { clientWidth: toolbar.clientWidth, scrollWidth: toolbar.scrollWidth },
          actions: { clientWidth: actions.clientWidth, scrollWidth: actions.scrollWidth },
          cancelRight: cancel.getBoundingClientRect().right,
          targets: actionButtons.map((button) => {
            const rect = button.getBoundingClientRect();
            return { label: button.getAttribute('aria-label'), height: rect.height, width: rect.width };
          }),
        };
      });

      assert.equal(metrics.canvas.clientWidth, 308, '52px ActivityBar should leave a 308px chat canvas');
      assert.ok(
        metrics.toolbar.scrollWidth <= metrics.toolbar.clientWidth,
        `toolbar overflowed: scrollWidth=${metrics.toolbar.scrollWidth}, clientWidth=${metrics.toolbar.clientWidth}`,
      );
      assert.ok(
        metrics.actions.scrollWidth <= metrics.actions.clientWidth,
        `action dock overflowed: scrollWidth=${metrics.actions.scrollWidth}, clientWidth=${metrics.actions.clientWidth}`,
      );
      assert.ok(metrics.cancelRight <= 360, `Cancel ended outside the viewport at x=${metrics.cancelRight}`);
      assert.equal(metrics.targets.length, 5);
      for (const target of metrics.targets) {
        assert.ok(target.width >= 44, `${target.label} target width was ${target.width}px`);
        assert.ok(target.height >= 44, `${target.label} target height was ${target.height}px`);
      }
    } finally {
      await browser?.close();
      await stopServer(server);
    }
  },
);
