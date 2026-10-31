import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import puppeteer from 'puppeteer-core';
import { loadChromium } from '../../../scripts/f317-page-action/browser-binary.mjs';
import { createOwnerCdpConnector } from '../src/domains/concierge/action/jev/OwnerCdpConnector.ts';

test('configured CDP attachment preserves both owner viewports and exposes only the granted page', async (t) => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<input id="note" value="original">');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const chromium = await loadChromium();
  const owner = await puppeteer.launch({
    headless: true,
    executablePath: chromium.executablePath(),
    defaultViewport: null,
    args: ['--remote-debugging-port=0', '--window-size=1280,900'],
  });
  t.after(() => owner.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const granted = await owner.newPage();
  const unrelated = await owner.newPage();
  await granted.goto(`${base}/granted`);
  await unrelated.goto(`${base}/unrelated`);
  const widths = async () => Promise.all([granted, unrelated].map((page) => page.evaluate(() => innerWidth)));
  const before = await widths();
  assert.deepEqual(before, [1280, 1280]);
  const config = {
    profileId: 'owner-note',
    pageUrl: granted.url(),
    browserURL: `http://127.0.0.1:${new URL(owner.wsEndpoint()).port}`,
    allowJevProjection: true,
    targets: [{ id: 'note', selector: '#note', operation: 'fill', expectedReadbackTemplate: '{value}' }],
    readback: { selector: '#note', kind: 'value' },
  };
  const handle = await createOwnerCdpConnector(config).open(
    {
      profileId: config.profileId,
      url: config.pageUrl,
      spec: { targets: [{ id: 'note', selector: '#note', operation: 'fill' }], readback: config.readback },
    },
    AbortSignal.timeout(5000),
  );
  t.after(() => handle.close());
  const during = await widths();
  const attachedUrls = (await handle.page.browser().pages()).map((page) => page.url());
  await handle.close();
  assert.deepEqual(during, before, 'connecting must not change any owner viewport');
  assert.deepEqual(await widths(), before, 'disconnecting must leave the original viewports intact');
  assert.deepEqual(attachedUrls, [config.pageUrl], 'unrelated pages are outside this attachment');
  assert.equal(unrelated.url(), `${base}/unrelated`);
  assert.equal(await granted.$eval('#note', (node) => node.value), 'original');
});
