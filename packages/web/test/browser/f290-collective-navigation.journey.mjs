import '../../../api/test/helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectiveArtifactOwnerFixture } from '../../../api/test/collective-artifact-owner.fixture.ts';

function hostDocument(url) {
  return `<style>body{margin:0;display:grid;grid-template-columns:52px minmax(0,1fr)}iframe{border:0;width:100%;height:100dvh}@media(max-width:820px){body{grid-template-columns:minmax(0,1fr)}nav{display:none}}</style><nav aria-label="Host rail">Café</nav><iframe title="Collective" src="${url}"></iframe>`;
}

async function capture(page, shots, name) {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function checkNavigation(client, width, embedded) {
  const pane = client.getByRole('complementary', { name: '共同家园导航', exact: true });
  const geometry = await pane.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const title = element.querySelector('.destination-header h1').getBoundingClientRect();
    return {
      inset: title.x - bounds.x,
      width: bounds.width,
      right: bounds.right,
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  assert.equal(geometry.inset, 16, `${embedded ? 'embedded' : 'standalone'} ${width}: duplicate rail reservation`);
  if (width > 820) assert.equal(geometry.width, width > 1540 ? 300 : 280);
  else assert.ok(geometry.right <= geometry.viewport, 'mobile navigation stays inside the frame');
  assert.equal(geometry.scrollWidth, geometry.viewport, 'no horizontal Client overflow');
  assert.equal(await client.locator('[data-spatial-role="global-rail"]').count(), embedded ? 0 : 1);
  await pane.getByRole('button', { name: '全部作品', exact: true }).click();
}

async function checkClient({ browser, f, hostUrl, embedded, shots }) {
  const context = await browser.newContext();
  try {
    await context.addInitScript(
      ({ origin, token }) => {
        if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
      },
      { origin: f.server.url, token: f.member.sessionToken },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    const lists = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.url().endsWith('/api/artifacts/list')) lists.push(response.status());
    });
    const url = new URL('/', f.server.url);
    url.searchParams.set('collectiveId', f.coordinates.collectiveId);
    for (const width of [1920, 1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto(embedded ? hostUrl : url.toString(), { waitUntil: 'networkidle' });
      const client = embedded ? page.frameLocator('iframe') : page;
      const home = client.getByTestId('collective-home');
      await home.locator('.shared-artifact-card').filter({ hasText: f.artifact.title }).waitFor();
      const browse = client.getByRole('button', { name: '先逛逛', exact: true });
      if (await browse.isVisible()) await browse.click();
      assert.equal(await home.getByRole('alert').count(), 0);
      await capture(page, shots, `home-${embedded ? 'embedded' : 'standalone'}-${width}`);
      if (width <= 820) await home.getByRole('button', { name: '频道导航', exact: true }).click();
      await checkNavigation(client, width, embedded);
      const library = client.getByRole('region', { name: '全部作品', exact: true });
      await library.locator('.shared-artifact-card').filter({ hasText: f.artifact.title }).waitFor();
      assert.equal(await library.getByRole('alert').count(), 0);
      await capture(page, shots, `library-${embedded ? 'embedded' : 'standalone'}-${width}`);
      if (width <= 820) await library.getByRole('button', { name: '频道导航', exact: true }).click();
      await client.locator('.channel-destination').filter({ hasText: 'general' }).click();
      const channel = client.getByRole('region', { name: '# general', exact: true });
      await channel.locator('.composer textarea').waitFor();
      assert.equal(await channel.locator('.scene-header').evaluate((e) => e.getBoundingClientRect().height), 52);
      assert.equal(await client.locator('.scene-tabs').count(), 0, 'channel actions share its one header');
      assert.equal(
        await channel
          .locator('.cafe-nameplate .avatar')
          .first()
          .evaluate((e) => e.getBoundingClientRect().width),
        32,
      );
      assert.equal(
        await channel
          .locator('.message-body')
          .first()
          .evaluate((e) => getComputedStyle(e).fontSize),
        '14px',
      );
      assert.equal(
        await channel
          .locator('.cafe-nameplate-avatar')
          .first()
          .evaluate((e) => e.getBoundingClientRect().width),
        32,
      );
      await channel.getByRole('button', { name: '任务 0', exact: true }).click();
      assert.equal(await client.getByRole('complementary', { name: '频道任务', exact: true }).count(), 1);
      await client.getByRole('button', { name: '关闭频道任务', exact: true }).click();
      await channel.getByRole('button', { name: '频道作品', exact: true }).click();
      assert.equal(await client.getByRole('complementary', { name: '频道作品', exact: true }).count(), 1);
      await client.getByRole('button', { name: '关闭频道作品', exact: true }).click();
      await capture(page, shots, `channel-${embedded ? 'embedded' : 'standalone'}-${width}`);
      if (width === 1440) {
        const body = `UI verified ${embedded ? 'embedded' : 'standalone'}`;
        await channel.locator('.composer textarea').fill(body);
        await channel.getByRole('button', { name: '发送', exact: true }).click();
        await channel.locator('.message-body').filter({ hasText: body }).waitFor();
        const saved = await f.store.listEventsForHuman(f.member.sessionToken, f.coordinates.collectiveId);
        assert.ok(
          saved.some((e) => e.body === body),
          'normal send reaches the real Service',
        );
        await client.locator('html').evaluate((e) => e.setAttribute('data-theme', 'dark'));
        await capture(page, shots, `channel-dark-${embedded ? 'embedded' : 'standalone'}-${width}`);
      }
    }
    assert.ok(lists.length > 0 && lists.every((status) => status === 200), 'real catalogue HTTP succeeds');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

// Real Client assets and Service HTTP; the test Host owns only its outer rail.
test(
  'Home and All works load through HTTP with one rail in standalone/embedded wide and narrow layouts',
  { timeout: 60000 },
  async (t) => {
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.CAT_CAFE_TEST_REAL_HOME && process.platform === 'darwin')
      process.env.PLAYWRIGHT_BROWSERS_PATH = join(
        process.env.CAT_CAFE_TEST_REAL_HOME,
        'Library',
        'Caches',
        'ms-playwright',
      );
    let frameUrl;
    const host = createServer((_, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(hostDocument(frameUrl));
    });
    await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => host.close(resolve)));
    const hostUrl = `http://127.0.0.1:${host.address().port}`;
    const f = await collectiveArtifactOwnerFixture(t, { additionalHostOrigins: [hostUrl] });
    frameUrl = `${f.server.url}/?collectiveId=${f.coordinates.collectiveId}&hostOrigin=${encodeURIComponent(hostUrl)}`;
    const { chromium } = await import('../../../ppt-forge/node_modules/playwright/index.mjs');
    const browser = await chromium.launch({ headless: true });
    const shots = process.env.F290_SCREENSHOTS;
    if (shots) await mkdir(shots, { recursive: true });
    try {
      await checkClient({ browser, f, hostUrl, embedded: false, shots });
      await checkClient({ browser, f, hostUrl, embedded: true, shots });
    } finally {
      await browser.close();
    }
  },
);
