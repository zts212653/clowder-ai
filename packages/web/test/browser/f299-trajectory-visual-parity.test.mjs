import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
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
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited before readiness:\n${output.join('')}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Next.js is still starting or compiling the fixture.
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

let server;
let browser;
let baseUrl;

before(async () => {
  const sync = spawnSync(process.execPath, [path.resolve(WEB_ROOT, 'scripts/sync-vendor-assets.mjs')], {
    cwd: WEB_ROOT,
    encoding: 'utf8',
  });
  assert.equal(sync.status, 0, `vendor token sync failed:\n${sync.stdout}\n${sync.stderr}`);
  const port = await findFreePort();
  const output = [];
  server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: WEB_ROOT,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));
  baseUrl = `http://127.0.0.1:${port}/dev/f299-trajectory-visual-preview`;
  await waitForPage(baseUrl, server, output);
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await stopServer(server);
});

async function semanticSurfaces(page) {
  return page.locator('[data-semantic-role]').evaluateAll((nodes) =>
    nodes.map((node) => ({
      role: node.getAttribute('data-semantic-role'),
      text: node.textContent ?? '',
      backgroundImage: getComputedStyle(node).backgroundImage,
      boxShadow: getComputedStyle(node).boxShadow,
    })),
  );
}

test(
  'semantic cards keep role gradients and failed tools use error tone across themes and narrow layouts',
  { timeout: 90_000 },
  async () => {
    const page = await browser.newPage({ viewport: { width: 960, height: 900 } });
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      const light = await semanticSurfaces(page);
      const byRole = new Map(light.map((surface) => [surface.role, surface]));
      for (const role of ['user', 'assistant', 'system', 'context', 'tool', 'error']) {
        const surface = byRole.get(role);
        assert(surface, `${role} surface must render`);
        assert.match(surface.backgroundImage, /^linear-gradient\(/, `${role} needs a gradient`);
      }
      assert.equal(new Set(light.map((surface) => surface.backgroundImage)).size, 6, 'roles need distinct surfaces');
      const errorSurface = byRole.get('error');
      assert(errorSurface, 'error surface must render');
      assert.match(errorSurface.boxShadow, /inset/, 'error priority needs a non-color-only edge');
      const failedToolSurface = light.find(
        (surface) => surface.role === 'tool' && surface.text.includes('exec_command'),
      );
      assert(failedToolSurface, 'failed tool must keep its tool semantic role');
      assert.equal(
        failedToolSurface.backgroundImage,
        errorSurface.backgroundImage,
        'failed tool must use the computed error-tone gradient',
      );
      assert.match(failedToolSurface.boxShadow, /inset/, 'failed tool needs the same non-color-only error edge');

      await page.getByRole('button', { name: '切到暗色' }).click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      const dark = await semanticSurfaces(page);
      assert.notDeepEqual(
        dark.map((surface) => surface.backgroundImage),
        light.map((surface) => surface.backgroundImage),
        'theme tokens must adapt the gradients in dark mode',
      );

      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
        'the production trajectory component must not overflow a narrow viewport',
      );
    } finally {
      await page.close();
    }
  },
);
