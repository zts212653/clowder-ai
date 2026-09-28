import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

await import('tsx/esm');
const { ImageExporter } = await import('../../../api/src/services/ImageExporter.ts');

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');
const FIXTURE_MESSAGE_ID = 'html-widget-export-fixture-message';

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

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForAdditionalBrowserPage(browser, baselineCount, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await browser.pages()).length > baselineCount) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for the in-flight export page');
}

async function waitForProcessToExit(pid, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`owned Chromium process ${pid} survived transport-disconnect cleanup`);
}

test(
  'in-flight export transport disconnect drains owned Chromium and the runner exits',
  { timeout: 90_000 },
  async () => {
    const port = await findFreePort();
    const output = [];
    const nextDev = await createNextDevTestEnvironment('image-export-browser-disconnect');
    const server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
      cwd: WEB_ROOT,
      env: nextDev.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (chunk) => output.push(chunk.toString()));
    server.stderr.on('data', (chunk) => output.push(chunk.toString()));

    const exporter = new ImageExporter();
    let disconnectedBrowser;
    let ownedPid;
    try {
      const url = `http://127.0.0.1:${port}/dev/f294-html-widget-responsive-export`;
      await waitForPage(url, server, output);
      const firstPng = await exporter.capture(`${url}?fixture=short`, 'browser-test-user', {
        selectionMessageIds: [FIXTURE_MESSAGE_ID],
      });
      assert.ok(firstPng.length > 0, 'the fixture must initialize a reusable exporter browser');

      disconnectedBrowser = exporter.browser;
      assert.ok(disconnectedBrowser?.isConnected(), 'the initialized exporter browser must be connected');
      const browserProcess = disconnectedBrowser.process();
      assert.ok(browserProcess?.pid, 'the regression must identify the exact owned Chromium process');
      ownedPid = browserProcess.pid;
      const pagesBeforeCapture = (await disconnectedBrowser.pages()).length;
      const rejectedCapture = assert.rejects(
        () =>
          exporter.capture(`${url}?fixture=short&unstable=1`, 'browser-test-user', {
            selectionMessageIds: [FIXTURE_MESSAGE_ID],
          }),
        /Screenshot capture failed/,
        'the in-flight capture must fail closed when its browser transport disconnects',
      );

      await waitForAdditionalBrowserPage(disconnectedBrowser, pagesBeforeCapture);
      assert.equal(isProcessAlive(ownedPid), true, 'the probe must disconnect a live owned Chromium process');
      await disconnectedBrowser.disconnect();
      await rejectedCapture;
      assert.equal(exporter.browser, null, 'the disconnected handle must stop being reusable immediately');
      await waitForProcessToExit(ownedPid);
      assert.equal(isProcessAlive(ownedPid), false, 'the disconnected owned Chromium process must be gone');

      const recoveredPng = await exporter.capture(`${url}?fixture=short`, 'browser-test-user', {
        selectionMessageIds: [FIXTURE_MESSAGE_ID],
      });
      assert.ok(recoveredPng.length > 0, 'the next capture must relaunch and succeed');
      assert.notEqual(exporter.browser, disconnectedBrowser, 'the replacement must use a fresh browser handle');
      assert.equal(exporter.browser?.isConnected(), true, 'the replacement browser must remain reusable');
      assert.equal(
        (await exporter.browser.pages()).length,
        pagesBeforeCapture,
        'the recovered capture must close its transient Puppeteer page',
      );
    } finally {
      if (ownedPid && isProcessAlive(ownedPid)) await disconnectedBrowser?.close();
      await exporter.close();
      await stopServer(server);
      await nextDev.cleanup();
    }
  },
);
