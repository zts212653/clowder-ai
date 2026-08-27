import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

await import('tsx/esm');
const { ImageExporter } = await import('../../../api/src/services/ImageExporter.ts');

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');
const MESSAGE_ID = 'f294-long-message-export-fixture';

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

async function countMagentaPixels(png) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let matches = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (data[offset] === 255 && data[offset + 1] === 0 && data[offset + 2] === 255) matches++;
  }
  return matches;
}

test(
  'selective PNG expands a real long ChatMessage and captures its bottom sentinel',
  { timeout: 120_000 },
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

    const exporter = new ImageExporter();
    let browser;
    try {
      const url = `http://127.0.0.1:${port}/dev/f294-long-message-export`;
      await waitForPage(url, server, output);

      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${url}?export=true&messageId=${MESSAGE_ID}`, { waitUntil: 'networkidle' });

      assert.equal(await page.getByRole('button', { name: /Show more|Show less/ }).count(), 0);
      const geometry = await page.locator('.markdown-content > p:last-child').evaluate((node) => {
        const paragraph = node.getBoundingClientRect();
        const bubble = node.closest('[data-testid="message-bubble"]')?.getBoundingClientRect();
        return { paragraphBottom: paragraph.bottom, bubbleBottom: bubble?.bottom ?? 0 };
      });
      assert.ok(
        geometry.paragraphBottom <= geometry.bubbleBottom + 1,
        `bottom paragraph must remain inside the exported bubble: ${JSON.stringify(geometry)}`,
      );

      const png = await exporter.capture(url, 'browser-test-user', { selectionMessageIds: [MESSAGE_ID] });
      const magentaPixels = await countMagentaPixels(png);
      assert.ok(magentaPixels > 20_000, `exported PNG lost the long-message bottom sentinel (${magentaPixels} pixels)`);
    } finally {
      await exporter.close();
      if (browser) await browser.close();
      await stopServer(server);
    }
  },
);
