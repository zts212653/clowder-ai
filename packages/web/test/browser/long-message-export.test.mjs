import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

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
    const nextDev = await createNextDevTestEnvironment('long-message-export');
    const server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
      cwd: WEB_ROOT,
      env: nextDev.env,
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
      await nextDev.cleanup();
    }
  },
);

test(
  'selective PNG waits for an offscreen delayed paw-feel projection in single and stitched captures',
  { timeout: 120_000 },
  async (t) => {
    let sourceRequests = 0;
    const api = createHttpServer(async (request, response) => {
      response.setHeader('Access-Control-Allow-Origin', request.headers.origin ?? '*');
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Access-Control-Allow-Headers', 'X-Cat-Cafe-User, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.url?.startsWith('/api/paw-feel/source/')) {
        sourceRequests++;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        response.end(
          JSON.stringify({
            projectionStatus: 'available',
            degraded: false,
            items: [
              {
                disposition: { signalId: 'export-fixture', state: 'seen', lastTransitionAt: '2026-09-30T00:00:00Z' },
                responsibility: { state: 'unreviewed', validExit: false, evidenceRefs: [] },
                issue: { resolution: 'open', ageMs: 0, continuation: { kind: 'review_required', evidenceRefs: [] } },
                source: { availability: 'available' },
              },
            ],
          }),
        );
      } else {
        response.end('{}');
      }
    });
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
    const apiAddress = api.address();
    assert(apiAddress && typeof apiAddress !== 'string');
    const port = await findFreePort();
    const output = [];
    const nextDev = await createNextDevTestEnvironment('paw-feel-export', {
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${apiAddress.port}`,
    });
    const server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
      cwd: WEB_ROOT,
      env: nextDev.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (chunk) => output.push(chunk.toString()));
    server.stderr.on('data', (chunk) => output.push(chunk.toString()));
    const exporter = new ImageExporter();
    try {
      const url = `http://127.0.0.1:${port}/dev/f294-long-message-export`;
      await waitForPage(url, server, output);
      for (const fixture of ['paw-feel-short', 'paw-feel-tall']) {
        await t.test(fixture, async () => {
          const png = await exporter.capture(`${url}?fixture=${fixture}`, 'browser-test-user', {
            selectionMessageIds: [MESSAGE_ID],
          });
          const metadata = await sharp(png).metadata();
          assert.ok(fixture === 'paw-feel-short' ? metadata.height < 4000 : metadata.height > 4000);
          const magentaPixels = await countMagentaPixels(png);
          assert.ok(magentaPixels > 20_000, `PNG omitted the bottom disposition dock (${magentaPixels} pixels)`);
        });
      }
      assert.equal(sourceRequests, 2, 'each export must load one source snapshot without viewport reloads');
    } finally {
      await exporter.close();
      await stopServer(server);
      await nextDev.cleanup();
      api.closeAllConnections();
      await new Promise((resolve, reject) => api.close((error) => (error ? reject(error) : resolve())));
    }
  },
);
