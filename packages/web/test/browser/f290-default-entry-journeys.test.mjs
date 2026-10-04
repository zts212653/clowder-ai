import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before } from 'node:test';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { registerDefaultEntryJourney } from './default-entry-journey.harness.mjs';
import { defaultHumanAuthProvider, seedDefaultCollective } from './f290-default-client.fixture.mjs';
import { reserveNativeOwnerPorts, startNativeOwner } from './f290-native-owner.harness.mjs';

let ports;
let dataDirectory;
let service;
let seeded;
let browser;
let context;
let nativeOwner;

before(async () => {
  ports = await reserveNativeOwnerPorts();
  dataDirectory = await mkdtemp(path.join(tmpdir(), 'f290-default-entry-'));
  const opened = await CollectiveServiceStore.open({
    dataDirectory,
    humanAuthProvider: defaultHumanAuthProvider(),
  });
  seeded = await seedDefaultCollective(opened.store, opened.bootstrapSecret);
  service = await startCollectiveServer({
    store: opened.store,
    host: '127.0.0.1',
    port: 0,
    allowedHostOrigins: [`http://localhost:${ports.hostPort}`],
  });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(
    ({ origin, token }) => {
      if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
    },
    { origin: service.url, token: seeded.owner.sessionToken },
  );
  nativeOwner = await startNativeOwner({
    store: opened.store,
    owner: seeded.owner,
    collectiveId: seeded.coordinates.collectiveId,
    serviceUrl: service.url,
    context,
    ports,
  });
});

after(async () => {
  await context?.close();
  await browser?.close();
  await nativeOwner?.close();
  await ports?.close();
  await service?.close();
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
});

registerDefaultEntryJourney(
  {
    journeyId: 'f290-client-default-entry',
    surfaceTestId: 'collective-product-shell',
    title: 'direct Service opens the real Collective Client from its default entry',
    timeout: 30_000,
  },
  async (journey) => {
    const page = await context.newPage();
    try {
      await journey.enter(page, service.url);
      await page
        .getByRole('navigation', { name: '频道', exact: true })
        .getByRole('button', { name: /产品方向/ })
        .click();
      await page.getByText(seeded.first.body, { exact: true }).waitFor();
      await journey.arrive(page);
    } finally {
      await page.close();
    }
  },
);

registerDefaultEntryJourney(
  {
    journeyId: 'f290-host-default-entry',
    surfaceTestId: 'collective-launch-surface',
    title: 'Clowder AI Host opens the canonical Collective Client from /collective',
    timeout: 30_000,
  },
  async (journey) => {
    const page = await context.newPage();
    try {
      await journey.enter(page, `${nativeOwner.hostUrl}/collective`);
      const collective = page.frameLocator('iframe[title="Collective"]');
      await collective
        .getByRole('navigation', { name: '频道', exact: true })
        .getByRole('button', { name: /产品方向/ })
        .click();
      await collective.getByRole('button', { name: '我的 Café', exact: true }).waitFor();
      await journey.arrive(page);
      await nativeOwner.receiveRequest('帮我看看这条点名请求', '产品方向');
      const activity = page.locator('section[aria-label="家里近况"]');
      await activity.getByText('已送到私人 Thread，等待猫接手 · 点开查看').waitFor();
      const evidence = await mkdtemp(path.join(tmpdir(), 'f290-owner-progress-evidence-'));
      await page.screenshot({ path: path.join(evidence, 'queued-activity.png'), fullPage: true });
      await activity.getByRole('button', { name: /点名/ }).click();
      const privateThread = page.getByRole('link', { name: /在「.*」查看/ });
      await privateThread.waitFor();
      if (!(await privateThread.getAttribute('href'))?.startsWith('/thread/')) {
        throw new Error('Named request must link to its actual owner Thread');
      }
      await page.screenshot({ path: path.join(evidence, 'private-thread-link.png'), fullPage: true });
      console.log(JSON.stringify({ evidence }));
    } finally {
      await page.close();
    }
  },
);
