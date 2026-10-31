import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { realSurfaceApiResponse } from './f307-real-surface-fixtures.mjs';

// Controlled read responses exercise the production Settings/Plugin Manager
// layout; they do not install, configure, enable or call any live plugin.
const plugins = Array.from({ length: 12 }, (_, index) => ({
  pluginInstanceId: `pi_scroll_${index}`,
  publisher: 'Clowder AI',
  availableVersion: '0.1.0',
  installedVersion: '0.1.0',
  packageDigest: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
  artifact: 'installed',
  config: 'ready',
  auth: 'connected',
  intent: 'enabled',
  live: 'running',
  lifecycleRevision: 1,
  capabilitySummary: [],
  actions: { install: false, setEnabled: true, uninstall: true, blockingReasons: [] },
  pluginId: `scroll-${index}`,
  displayName: `滚动回归插件 ${index + 1}`,
  description: '固定区域内的插件列表和详情应各自原生滚动。',
  source: { kind: 'catalog', catalogId: `scroll-${index}`, packageName: `@fixture/scroll-${index}`, trust: 'official' },
}));
const catalog = { status: 'fresh', refreshedAt: 1 };
const personalProState = {
  pluginId: 'personal-chrome-host',
  channel: 'developer_preview',
  platform: 'darwin',
  platformSupport: 'supported',
  artifact: { helper: 'absent', extension: 'chrome_web_store' },
  distribution: { channel: 'chrome_web_store', integration: 'ready', publication: 'unavailable' },
  config: { status: 'absent' },
  authorization: { status: 'empty', count: 0, limit: 4, conversations: [] },
  intent: { status: 'developer_preview' },
  live: { status: 'dormant' },
};
const readmeMarkdown = Array.from(
  { length: 40 },
  (_, i) => `## 详情段落 ${i + 1}\n\n列表与详情各自滚动，页面标题保持原位。`,
).join('\n\n');

function pluginReadResponse(url) {
  if (url.pathname === '/api/plugins/personal-chrome') return { body: personalProState };
  if (url.pathname === '/api/plugin-manager/plugins' || url.pathname.endsWith('/plugins/search'))
    return { body: { plugins, catalog } };
  if (url.pathname.endsWith('/documentation')) return { body: { readmeMarkdown } };
  if (url.pathname.endsWith('/contributions/tools'))
    return { body: { pluginId: url.pathname.split('/')[4], tools: [] } };
  if (url.pathname.startsWith('/api/plugin-manager/plugins/'))
    return {
      body: {
        plugin: {
          ...plugins.find((p) => p.pluginId === url.pathname.split('/').at(-1)),
          capabilities: [],
          configFields: [],
          contributions: [],
        },
        catalog,
      },
    };
  if (url.pathname === '/api/plugins' || url.pathname === '/api/plugins/official') return { body: { plugins: [] } };
  return undefined;
}

async function installReadFixtures(page, blockedWrites) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      blockedWrites.push({ method: request.method(), path: url.pathname });
      return route.abort();
    }
    const response = pluginReadResponse(url) ?? realSurfaceApiResponse(request, false);
    return route.fulfill({
      status: response.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(response.body),
    });
  });
}

async function geometry(page) {
  return page.evaluate(() => {
    const panes = Object.fromEntries(
      ['list', 'detail'].map((name) => {
        const node = document.querySelector(`[data-plugin-scroll-region="${name}"]`);
        const rect = node.getBoundingClientRect();
        return [
          name,
          {
            top: rect.top,
            bottom: rect.bottom,
            client: node.clientHeight,
            scroll: node.scrollHeight,
            offset: node.scrollTop,
          },
        ];
      }),
    );
    return {
      windowY: scrollY,
      documentHeight: document.scrollingElement.scrollHeight,
      viewportHeight: innerHeight,
      headingTop: document.querySelector('h2').getBoundingClientRect().top,
      ancestors: [...document.querySelectorAll('[data-trajectory-origin-scroll]')].map((node) => node.scrollTop),
      panes,
    };
  });
}

async function wheel(page, locator, delta) {
  const box = await locator.boundingBox();
  assert.ok(box && box.height > 0, 'the original scroll pane must be visible');
  await page.mouse.move(box.x + Math.min(80, box.width / 2), box.y + Math.min(80, box.height / 2));
  await page.mouse.wheel(0, delta);
  // Native wheel scrolling may be compositor-driven after the input dispatch.
  await page.waitForTimeout(250);
}

function assertFrameStable(before, after) {
  assert.equal(after.windowY, 0, 'wheel must not move the document');
  assert.equal(after.documentHeight, after.viewportHeight, 'no blank document below the fixed frame');
  assert.equal(after.headingTop, before.headingTop, 'settings heading remains fixed');
  assert.deepEqual(after.ancestors, before.ancestors, 'no scroll chaining to the settings frame');
}

async function run(getSuite, shell, width, standalone) {
  const { browser, baseUrl, evidenceDir } = getSuite();
  const name = `plugin-scroll-${shell}-${width}${standalone ? '-standalone' : ''}`;
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript((shell) => {
    if (window.top !== window) return;
    localStorage.setItem('cat-cafe:shell-presentation', shell);
  }, shell);
  const page = await context.newPage();
  const result = { shell, width, standalone, blockedWrites: [], pageerrors: [], observations: {} };
  page.on('pageerror', (error) => result.pageerrors.push(error.message));
  await installReadFixtures(page, result.blockedWrites);
  try {
    const url = new URL(`/settings?s=plugins&shell=${shell}${standalone ? '&standalone=1' : ''}`, baseUrl);
    result.url = url.href;
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-plugin-id="scroll-11"]').waitFor({ state: 'attached' });
    const list = page.locator('[data-plugin-scroll-region="list"]');
    const detail = page.locator('[data-plugin-scroll-region="detail"]');
    const before = await geometry(page);
    result.observations.before = before;
    await page.screenshot({ path: path.join(evidenceDir, `${name}-entry.png`) });
    assert.ok(
      before.panes.list.client > 0 && before.panes.list.scroll > before.panes.list.client,
      'long list must scroll inside its fixed pane',
    );
    await wheel(page, list, 650);
    const listScrolled = await geometry(page);
    result.observations.listScrolled = listScrolled;
    assert.ok(listScrolled.panes.list.offset > 0, 'native wheel moves the plugin list');
    assertFrameStable(before, listScrolled);
    await wheel(page, list, 10000);
    await wheel(page, list, 650);
    const listEnd = await geometry(page);
    result.observations.listEnd = listEnd;
    assert.ok(
      Math.abs(listEnd.panes.list.offset + listEnd.panes.list.client - listEnd.panes.list.scroll) <= 1,
      'bottom cards are reachable',
    );
    const last = await page.locator('[data-plugin-id="personal-chrome-host"]').boundingBox();
    assert.ok(
      last && last.y >= listEnd.panes.list.top && last.y + last.height <= listEnd.panes.list.bottom + 1,
      'last compatibility card is fully in the pane',
    );
    assertFrameStable(before, listEnd);
    await page.screenshot({ path: path.join(evidenceDir, `${name}-list-end.png`) });
    await wheel(page, list, -10000);
    await wheel(page, list, -650);
    assertFrameStable(before, await geometry(page));
    await page.locator('[data-plugin-id="scroll-0"] > div > button').click();
    await page.getByTestId('plugin-manager-detail').waitFor();
    await page.getByRole('heading', { name: '详情段落 40', exact: true }).waitFor({ state: 'attached' });
    const detailBefore = await geometry(page);
    result.observations.detailBefore = detailBefore;
    assert.ok(
      detailBefore.panes.detail.scroll > detailBefore.panes.detail.client,
      'long documentation has its own scroll pane',
    );
    await wheel(page, detail, 650);
    const detailScrolled = await geometry(page);
    result.observations.detailScrolled = detailScrolled;
    assert.ok(detailScrolled.panes.detail.offset > 0);
    assertFrameStable(before, detailScrolled);
    await wheel(page, detail, 10000);
    await wheel(page, detail, 650);
    const detailEnd = await geometry(page);
    result.observations.detailEnd = detailEnd;
    assert.ok(
      Math.abs(detailEnd.panes.detail.offset + detailEnd.panes.detail.client - detailEnd.panes.detail.scroll) <= 1,
    );
    const finalParagraph = await page.getByRole('heading', { name: '详情段落 40', exact: true }).boundingBox();
    assert.ok(
      finalParagraph &&
        finalParagraph.y >= detailEnd.panes.detail.top &&
        finalParagraph.y + finalParagraph.height <= detailEnd.panes.detail.bottom,
    );
    assertFrameStable(before, detailEnd);
    await page.screenshot({ path: path.join(evidenceDir, `${name}-detail-end.png`) });
    await wheel(page, detail, -10000);
    await wheel(page, detail, -650);
    assertFrameStable(before, await geometry(page));
    if (width < 1024) {
      await page.getByRole('button', { name: '返回插件列表', exact: true }).click();
      assert.equal(await list.isVisible(), true);
      assert.equal(await detail.isVisible(), false);
      await page.locator('[data-plugin-id="scroll-0"] > div > button').click();
      assert.equal(
        await page
          .getByTestId('plugin-manager-detail')
          .getByRole('heading', { name: '滚动回归插件 1', exact: true })
          .isVisible(),
        true,
      );
    }
    if (shell === 'v2' && !standalone && width === 390) {
      await page.getByTestId('settings-entry-theme').click();
      await page.waitForURL('**/settings?*s=theme*');
      const ordinary = page.locator('[data-trajectory-origin-scroll]');
      await page.waitForFunction(() => {
        const node = document.querySelector('[data-trajectory-origin-scroll]');
        return node && node.scrollHeight > node.clientHeight;
      });
      await wheel(page, ordinary, 650);
      result.observations.ordinaryOffset = await ordinary.evaluate((node) => node.scrollTop);
      assert.ok(result.observations.ordinaryOffset > 0, 'ordinary settings keep native page-content scrolling');
      await page.getByTestId('settings-entry-connect').click();
      await page.getByTestId('settings-tab-plugins').click();
      await list.waitFor();
      assert.equal(await page.evaluate(() => scrollY), 0);
    }
    assert.deepEqual(result.pageerrors, []);
    assert.equal(
      result.blockedWrites.filter((r) => r.path.startsWith('/api/plugin')).length,
      0,
      'scrolling does not mutate plugins',
    );
    result.passed = true;
  } finally {
    await page.screenshot({ path: path.join(evidenceDir, `${name}-final.png`) }).catch(() => undefined);
    await context.close();
    result.contextClosed = true;
    await writeFile(path.join(evidenceDir, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }
}

export function registerPluginScrollJourneys(getSuite) {
  for (const [shell, width, standalone] of [
    ['v2', 1440, false],
    ['v2', 390, false],
    ['classic', 1440, false],
    ['v2', 390, true],
  ])
    test(`Plugin Manager native scroll ${shell} ${width}${standalone ? ' standalone' : ''}`, { timeout: 120000 }, () =>
      run(getSuite, shell, width, standalone),
    );
}
