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

async function waitForWidgetMeasurement(page) {
  await page.waitForFunction(() => {
    const widget = document.querySelector('[data-html-widget]');
    return widget?.getAttribute('data-html-widget-layout-state') === 'ready';
  });
  return page.locator('[data-html-widget]');
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
  'html_widget remeasures across desktop and 360px layouts, then exports the bottom sentinel',
  { timeout: 120_000 },
  async (t) => {
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
    const exporter = new ImageExporter();
    try {
      const url = `http://127.0.0.1:${port}/dev/f294-html-widget-responsive-export`;
      await waitForPage(url, server, output);
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(url, { waitUntil: 'networkidle' });

      await t.test('live 14KB message mounts and refreshes without ever committing an empty iframe', async () => {
        const livePage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const liveUrl = `http://127.0.0.1:${port}/dev/f294-html-widget-live-message`;
        const assertVisibleLiveWidget = async () => {
          const liveWidget = await waitForWidgetMeasurement(livePage);
          assert.equal(
            await livePage.locator('[data-live-message-widget-fixture]').getAttribute('data-source-html-code-points'),
            '14904',
            'fixture must retain the exact persisted 14KB html_widget document',
          );
          assert.equal(
            await livePage.locator('[data-live-message-widget-fixture]').getAttribute('data-empty-iframe-observed'),
            'false',
            'message-flow mount must not commit a real iframe whose srcDoc is the empty server placeholder',
          );
          const childFrame = livePage.frames().find((frame) => frame.parentFrame() === livePage.mainFrame());
          assert.ok(childFrame, 'live message iframe must create a child browsing context');
          await childFrame.waitForSelector('main.page');
          assert.match(
            await childFrame.locator('body').innerText(),
            /不从三百件事开始/,
            'live message iframe must expose visible body content, not only payload/height metadata',
          );
          assert.equal(await liveWidget.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
        };

        try {
          await livePage.goto(liveUrl, { waitUntil: 'networkidle' });
          await assertVisibleLiveWidget();
          await livePage.reload({ waitUntil: 'networkidle' });
          await assertVisibleLiveWidget();
        } finally {
          await livePage.close();
        }
      });

      const widget = await waitForWidgetMeasurement(page);
      const desktopHeight = Number(await widget.getAttribute('data-html-widget-measured-height'));
      assert.ok(desktopHeight > 720, `desktop fixture must exercise the long preview, got ${desktopHeight}px`);
      assert.equal(await widget.getAttribute('data-html-widget-expanded'), 'false');
      assert.equal(await widget.locator('iframe').getAttribute('scrolling'), 'no');
      assert.equal(await widget.locator('iframe').evaluate((iframe) => iframe.style.height), '720px');

      await page.setViewportSize({ width: 360, height: 800 });
      await page.waitForFunction((previousHeight) => {
        const value = Number(
          document.querySelector('[data-html-widget]')?.getAttribute('data-html-widget-measured-height'),
        );
        return value > previousHeight;
      }, desktopHeight);
      const narrowHeight = Number(await widget.getAttribute('data-html-widget-measured-height'));
      assert.ok(
        narrowHeight > desktopHeight,
        `responsive single-column height ${narrowHeight}px must exceed ${desktopHeight}px`,
      );
      assert.equal(await widget.locator('iframe').evaluate((iframe) => iframe.style.height), '720px');

      await page.getByRole('button', { name: '展开完整内容' }).click();
      await page.waitForFunction(
        () => document.querySelector('[data-html-widget]')?.getAttribute('data-html-widget-expanded') === 'true',
      );
      assert.equal(await widget.locator('iframe').evaluate((iframe) => iframe.style.height), `${narrowHeight}px`);

      const childFrame = page.frames().find((frame) => frame.parentFrame() === page.mainFrame());
      assert.ok(childFrame, 'sandbox widget frame must exist');
      const childLayout = await childFrame.evaluate(() => {
        const sentinel = document.querySelector('#html-widget-bottom-sentinel');
        if (!sentinel) throw new Error('bottom sentinel missing from html_widget');
        const rect = sentinel.getBoundingClientRect();
        return {
          sentinelBottom: rect.bottom,
          viewportHeight: window.innerHeight,
          rootOverflow: getComputedStyle(document.documentElement).overflow,
          bodyOverflow: getComputedStyle(document.body).overflow,
        };
      });
      assert.ok(
        childLayout.sentinelBottom <= childLayout.viewportHeight + 1,
        `expanded iframe clipped sentinel at ${childLayout.sentinelBottom}/${childLayout.viewportHeight}`,
      );
      assert.equal(childLayout.rootOverflow, 'hidden');
      assert.equal(childLayout.bodyOverflow, 'hidden');

      await page.getByRole('button', { name: '收起完整内容' }).click();
      assert.equal(await widget.locator('iframe').evaluate((iframe) => iframe.style.height), '720px');

      await t.test('short content auto-fits below the initial hint and iframe viewport', async () => {
        const shortPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        try {
          await shortPage.goto(`${url}?fixture=short`, { waitUntil: 'networkidle' });
          const shortWidget = await waitForWidgetMeasurement(shortPage);
          const shortHeight = Number(await shortWidget.getAttribute('data-html-widget-measured-height'));
          assert.ok(
            shortHeight < 100,
            `short widget must shed its 500px hint and viewport floor, got ${shortHeight}px`,
          );
          assert.equal(
            await shortWidget.locator('iframe').evaluate((iframe) => iframe.style.height),
            `${shortHeight}px`,
          );
        } finally {
          await shortPage.close();
        }
      });

      await t.test('viewport-relative CSS converges without parent-child height amplification', async () => {
        const viewportRelativePage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        try {
          await viewportRelativePage.goto(`${url}?fixture=viewport-relative`, { waitUntil: 'networkidle' });
          const viewportRelativeWidget = await waitForWidgetMeasurement(viewportRelativePage);
          const observedHeights = [];
          for (let sample = 0; sample < 12; sample++) {
            observedHeights.push(Number(await viewportRelativeWidget.getAttribute('data-html-widget-measured-height')));
            await viewportRelativePage.waitForTimeout(100);
          }
          assert.ok(
            Math.max(...observedHeights) - Math.min(...observedHeights) <= 2,
            `viewport-relative widget must converge instead of feeding back: ${observedHeights.join(', ')}`,
          );
          assert.ok(
            observedHeights.at(-1) <= 320,
            `viewport-relative widget must remain near its initial 300px viewport: ${observedHeights.join(', ')}`,
          );
        } finally {
          await viewportRelativePage.close();
        }
      });

      const png = await exporter.capture(url, 'browser-test-user', { selectionMessageIds: [FIXTURE_MESSAGE_ID] });
      const magentaPixels = await countMagentaPixels(png);
      assert.ok(magentaPixels > 1_000, `exported PNG lost the bottom sentinel (${magentaPixels} magenta pixels)`);

      await t.test('async descendant geometry invalidates readiness before PNG capture', async () => {
        const asyncPng = await exporter.capture(`${url}?fixture=async-image`, 'browser-test-user', {
          selectionMessageIds: [FIXTURE_MESSAGE_ID],
        });
        const asyncMagentaPixels = await countMagentaPixels(asyncPng);
        assert.ok(
          asyncMagentaPixels > 100_000,
          `exported PNG silently clipped the loaded async image sentinel (${asyncMagentaPixels} magenta pixels)`,
        );
      });

      await t.test('CSS generated content is included in the selective PNG', async () => {
        const pseudoPng = await exporter.capture(`${url}?fixture=pseudo-content`, 'browser-test-user', {
          selectionMessageIds: [FIXTURE_MESSAGE_ID],
        });
        const pseudoMagentaPixels = await countMagentaPixels(pseudoPng);
        assert.ok(
          pseudoMagentaPixels > 100_000,
          `exported PNG silently clipped the CSS generated sentinel (${pseudoMagentaPixels} magenta pixels)`,
        );
      });

      await t.test('documentElement generated content is included in the selective PNG', async () => {
        const rootPseudoPng = await exporter.capture(`${url}?fixture=root-pseudo-content`, 'browser-test-user', {
          selectionMessageIds: [FIXTURE_MESSAGE_ID],
        });
        const rootPseudoMagentaPixels = await countMagentaPixels(rootPseudoPng);
        assert.ok(
          rootPseudoMagentaPixels > 100_000,
          `exported PNG silently clipped the root CSS generated sentinel (${rootPseudoMagentaPixels} magenta pixels)`,
        );
      });

      await t.test('viewport-bound documentElement generated overflow rejects instead of clipping', async () => {
        await assert.rejects(
          () =>
            exporter.capture(`${url}?fixture=root-pseudo-feedback`, 'browser-test-user', {
              selectionMessageIds: [FIXTURE_MESSAGE_ID],
            }),
          /HTML widget layout failed/,
          'root generated overflow that moves with the iframe viewport must fail closed',
        );
      });

      await t.test('fixed generated paint outside every scroll extent rejects instead of clipping', async () => {
        await assert.rejects(
          () =>
            exporter.capture(`${url}?fixture=fixed-root-pseudo`, 'browser-test-user', {
              selectionMessageIds: [FIXTURE_MESSAGE_ID],
            }),
          /HTML widget layout failed/,
          'a generated fixed box outside descendant/body/root extents must fail closed',
        );
      });

      await t.test('CSSOM-generated fixed paint revokes stale readiness before screenshot', async () => {
        await assert.rejects(
          () =>
            exporter.capture(`${url}?fixture=cssom-fixed-root-pseudo`, 'browser-test-user', {
              selectionMessageIds: [FIXTURE_MESSAGE_ID],
            }),
          /HTML widget layout failed/,
          'a fixed pseudo inserted through CSSOM during the stable-height window must fail closed',
        );
      });

      await t.test('CSSOM paint inserted after the final pre-capture proof invalidates the candidate PNG', async () => {
        await assert.rejects(
          () =>
            exporter.capture(`${url}?fixture=cssom-final-proof-race`, 'browser-test-user', {
              selectionMessageIds: [FIXTURE_MESSAGE_ID],
            }),
          /HTML widget layout failed/,
          'a fixed pseudo inserted after the final proof ack must discard the candidate screenshot',
        );
      });

      await t.test('measurable CSSOM-generated flow refreshes proof and enters the PNG', async () => {
        const cssomPseudoPng = await exporter.capture(`${url}?fixture=cssom-root-pseudo-content`, 'browser-test-user', {
          selectionMessageIds: [FIXTURE_MESSAGE_ID],
        });
        const cssomPseudoMagentaPixels = await countMagentaPixels(cssomPseudoPng);
        assert.ok(
          cssomPseudoMagentaPixels > 100_000,
          `fresh proof lost measurable CSSOM generated content (${cssomPseudoMagentaPixels} magenta pixels)`,
        );
      });

      await t.test('viewport-dependent overflow rejects instead of capturing a clipped sentinel', async () => {
        await assert.rejects(
          () =>
            exporter.capture(`${url}?fixture=viewport-feedback`, 'browser-test-user', {
              selectionMessageIds: [FIXTURE_MESSAGE_ID],
            }),
          /HTML widget layout failed/,
          'an unresolvable 100vh + 100px feedback cycle must fail closed',
        );
      });

      await t.test('unstable export rejects instead of silently capturing', async () => {
        const exporterBrowser = exporter.browser;
        assert.ok(exporterBrowser, 'the prior successful export must initialize the shared browser');
        const pagesBeforeFailure = (await exporterBrowser.pages()).length;
        await assert.rejects(
          () =>
            exporter.capture(`${url}?fixture=short&unstable=1`, 'browser-test-user', {
              selectionMessageIds: [FIXTURE_MESSAGE_ID],
            }),
          /Page height did not stabilize within maxWait/,
          'an unstable export must fail instead of silently capturing a transient layout',
        );
        const pagesAfterFailure = (await exporterBrowser.pages()).length;
        assert.equal(pagesAfterFailure, pagesBeforeFailure, 'a failed capture must close its Puppeteer page');
      });
    } finally {
      await exporter.close();
      if (browser) await browser.close();
      await stopServer(server);
    }
  },
);
