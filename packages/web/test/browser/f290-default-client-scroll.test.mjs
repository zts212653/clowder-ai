import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { defaultHumanAuthProvider, seedDefaultCollective } from './f290-default-client.fixture.mjs';

test('restores channel scroll after asynchronous Service history loading', { timeout: 20_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'f290-scroll-service-'));
  const opened = await CollectiveServiceStore.open({
    dataDirectory,
    humanAuthProvider: defaultHumanAuthProvider(),
  });
  const seeded = await seedDefaultCollective(opened.store, opened.bootstrapSecret);
  for (let index = 0; index < 40; index++)
    await opened.store.postHumanMessage(seeded.owner.sessionToken, {
      ...seeded.coordinates,
      clientEventId: `history-fixture-${index}`,
      body: `接着讨论这个界面的第 ${index + 1} 个细节。`,
      location: { channelId: '长讨论' },
      recipient: { kind: 'channel' },
    });
  const server = await startCollectiveServer({
    store: opened.store,
    host: '127.0.0.1',
    port: 0,
    allowedHostOrigins: [],
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(({ origin, token }) => sessionStorage.setItem(`collective-session:${origin}`, token), {
      origin: server.url,
      token: seeded.owner.sessionToken,
    });
    await page.goto(server.url, { waitUntil: 'networkidle' });
    await page
      .getByRole('navigation', { name: '频道', exact: true })
      .getByRole('button', { name: /长讨论/ })
      .click();
    await page.getByText('接着讨论这个界面的第 40 个细节。', { exact: true }).waitFor();
    await page.locator('.channel-flow').evaluate((flow) => {
      flow.scrollTop = 600;
    });
    await page.waitForFunction(() =>
      Object.keys(localStorage).some(
        (key) => key.startsWith('collective-scroll:') && localStorage.getItem(key) === '600',
      ),
    );
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('接着讨论这个界面的第 40 个细节。', { exact: true }).waitFor();
    assert.ok(
      await page.locator('.channel-flow').evaluate((flow) => flow.scrollTop >= 590),
      'channel reading position must survive the empty-before-history render',
    );
  } finally {
    await browser.close();
    await server.close();
    await rm(dataDirectory, { recursive: true });
  }
});
