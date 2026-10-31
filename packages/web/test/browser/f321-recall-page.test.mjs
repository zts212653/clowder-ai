import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { registerMemorySearchTests } from './f321-memory-search.journey.mjs';
import { checkLibraryManagement, registerMemorySettingsTests } from './f321-memory-settings.journey.mjs';
import { EVIDENCE_DIR, prepareBrakeDetail, recallPage, startRecallBrowser } from './f321-recall-browser.harness.mjs';

let runtime;
const flow = (page) => page.locator('section[aria-label="所有对话的召回流水"]');
const stats = (page) => page.locator('section[aria-label="召回统计"]');
async function waitReady(page) {
  await flow(page).locator('article').first().waitFor();
  await page
    .getByRole('heading', { name: /检索命中最多的品味/ })
    .locator('..')
    .getByRole('button', { name: /先看真实页面，再讨论布局/ })
    .waitFor();
  await page.waitForLoadState('networkidle');
}
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(EVIDENCE_DIR, name), fullPage: true });
}
function statsResponse(page, days) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/memory/recall/stats' && url.searchParams.get('days') === String(days);
  });
}
async function selectWindow(view, days, expectedCount, holdResponse = false) {
  const { page } = view;
  const response = statsResponse(page, days);
  if (holdResponse) view.setState('loading');
  await page.getByRole('button', { name: `近 ${days} 天`, exact: true }).click();
  const article = stats(page).locator('article').first();
  if (holdResponse) {
    await article.getByText('正在读取统计…', { exact: true }).waitFor();
    assert.doesNotMatch(await article.innerText(), /3\s*次/);
    await flow(page).getByText('正在读取召回记录…', { exact: true }).waitFor();
    assert.equal(await flow(page).locator('article').count(), 0);
    view.setState('ready');
  }
  assert.equal((await response).status(), 200);
  await article.getByText(new RegExp(`^${expectedCount}\\s*次$`)).waitFor();
  assert.match(await article.innerText(), new RegExp(`${expectedCount}\\s*次`));
}
async function checkLayout(page, width) {
  const layout = await page.evaluate(() => ({
    viewport: innerWidth,
    body: document.documentElement.scrollWidth,
    pane: document.querySelector('[data-testid="memory-page-preview"]')?.getBoundingClientRect().toJSON(),
  }));
  assert.equal(layout.viewport, width);
  assert.ok(layout.body <= width, `page overflows horizontally: ${JSON.stringify(layout)}`);
  assert.ok(layout.pane && layout.pane.right <= width + 1 && layout.pane.width > 250);
  return layout;
}
before(async () => {
  runtime = await startRecallBrowser();
  await prepareSearch();
  await prepareSettings();
});
after(async () => {
  await runtime?.close();
});

for (const width of [1440, 390])
  test(`real Recall page renders eight families, honest counts and owner labels at ${width}px`, async () => {
    const view = await recallPage(runtime, { width, height: 960 });
    try {
      const { page } = view;
      await waitReady(page);
      await stats(page)
        .locator('article')
        .first()
        .getByText(/^2\s*次$/)
        .waitFor();
      assert.match(await stats(page).locator('article').nth(0).innerText(), /猫发起的检索[\s\S]*2\s*次/);
      assert.match(await stats(page).locator('article').nth(1).innerText(), /通用上下文递送[\s\S]*1\s*次/);
      assert.match(await stats(page).locator('article').nth(2).innerText(), /全部时间[\s\S]*6\s*次/);
      for (const name of ['人物', '经验先例', '品味', '画像', '事件', '决策', '功能', '猫自己的种子'])
        assert.match(await flow(page).innerText(), new RegExp(`点名递送 · ${name}`));
      assert.match(await flow(page).innerText(), /点名递送 · 品味 · 采用/);
      assert.doesNotMatch(
        await page.getByTestId('memory-page-preview').innerText(),
        /cue-parent|revision-1|reply-cue|person_visible|source-taste/,
      );
      const layout = await checkLayout(page, width);
      await screenshot(page, `recall-ready-${width}.png`);
      const row = flow(page).locator('[data-recall-event-id]').filter({ hasText: '点名递送 · 品味' });
      assert.equal(await row.getByRole('button').count(), 0, 'delivery summary does not offer duplicate expansion');
      assert.equal(await row.getByText('先看真实页面，再讨论布局', { exact: true }).count(), 1);
      assert.equal(await row.getByRole('link').count(), 0, 'cue metadata does not invent a source destination');
      assert.match(await stats(page).innerText(), /只算同一次回复里、检索后不久读到结果的情况，可能漏算/);
      assert.match(await stats(page).innerText(), /点开 4 · 采用 1 · 明确不用 1 · 其余 4 次未回报/);
      assert.match(await stats(page).innerText(), /品味维度提示 · 全部时间：没有记录/);
      assert.match(await page.getByTestId('memory-page-preview').getByRole('complementary').innerText(), /点开 2 次/);
      if (width === 1440) {
        await selectWindow(view, 14, 3);
        await selectWindow(view, 30, 4, true);
        await page.getByRole('combobox', { name: '筛选召回来源' }).selectOption('pull');
        const filtered = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return url.pathname === '/api/memory/recall' && url.searchParams.get('catId') === 'codex61-sol';
        });
        await page.getByRole('combobox', { name: '筛选猫' }).selectOption('codex61-sol');
        assert.equal((await filtered).status(), 200);
        await flow(page).getByRole('link', { name: '记忆页的共创 ↗', exact: true }).waitFor();
        assert.equal(await flow(page).locator('article').count(), 1);
        assert.match(await flow(page).innerText(), /记忆页的共创/);
        assert.equal(view.requests.filter((url) => url === '/api/memory/taste').length, 1);
      }
      assert.equal(
        view.requests.some((url) => url.startsWith('/api/recall/events')),
        false,
      );
      assert.deepEqual(view.errors, []);
      await writeFile(
        path.join(EVIDENCE_DIR, `layout-${width}.json`),
        JSON.stringify({ layout, apiRequests: view.requests, pageErrors: view.errors }),
      );
    } finally {
      await view.context.close();
    }
  });

for (const width of [1440, 390])
  test(`v2 memory entry and AC-A7 destinations work while classic stays frozen at ${width}px`, async () => {
    const view = await recallPage(runtime, { width, height: 960 });
    try {
      const { page } = view;
      await waitReady(page);
      const samples = JSON.parse(await readFile(path.join(EVIDENCE_DIR, 'settings-api-samples.json'), 'utf8'));
      for (const endpoint of ['/api/memory/catalog', '/api/memory/library-feed', '/api/memory/maintenance']) {
        await page.route(`**${endpoint}`, (route) =>
          route.fulfill({
            status: samples[endpoint].status,
            contentType: 'application/json',
            body: JSON.stringify(samples[endpoint].body),
          }),
        );
      }
      if (width === 1440) await page.getByTestId('sidebar-memory').click();
      else await page.goto(`${runtime.origin}/memory?shell=v2`);
      await page.getByTestId('taste-card').first().waitFor();
      assert.equal(new URL(page.url()).pathname, '/memory');
      assert.equal(await page.getByTestId('memory-hub').count(), 0);
      assert.equal(await page.getByRole('navigation', { name: '记忆页标签' }).getByRole('link').count(), 4);
      const links = await page
        .getByRole('navigation', { name: '记忆页标签' })
        .getByRole('link')
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('href')));
      assert.ok(
        links.every((href) => href.startsWith('/memory?tab=')),
        JSON.stringify(links),
      );
      assert.ok(await page.getByRole('textbox', { name: '搜索记忆和资料' }).isVisible());
      await checkLayout(page, width);
      await screenshot(page, `entry-all-${width}.png`);
      await page
        .getByRole('navigation', { name: '记忆页标签' })
        .getByRole('link', { name: '召回记录', exact: true })
        .click();
      await waitReady(page);
      await prepareBrakeDetail(page);
      await page
        .getByRole('navigation', { name: '记忆页标签' })
        .getByRole('link', { name: '拉闸记录', exact: true })
        .click();
      await page.getByRole('heading', { name: '拉闸记录', exact: true }).waitFor();
      await page.getByRole('button', { name: '全部 10 条消息', exact: true }).waitFor();
      assert.equal(await page.getByTestId('brake-message').count(), 10);
      assert.equal(await page.locator('section[aria-label="拉闸记录"] article').count(), 10);
      const brakeDetail = page.getByRole('complementary', { name: '所选拉闸详情' });
      await brakeDetail.getByRole('heading', { name: '拉闸详情', exact: true }).waitFor();
      assert.match(await brakeDetail.getByTestId('brake-detail').innerText(), /原消息 0/);
      await page.getByTestId('brake-message').nth(1).getByRole('button').first().click();
      await brakeDetail.getByText(/喵约，原消息 1/).waitFor();
      assert.equal(await page.getByTestId('brake-message').count(), 10);
      await checkLayout(page, width);
      await screenshot(page, `entry-brakes-detail-${width}.png`);
      await brakeDetail.screenshot({ path: path.join(EVIDENCE_DIR, `entry-brakes-selected-${width}.png`) });
      await page
        .getByRole('navigation', { name: '记忆页标签' })
        .getByRole('link', { name: '资料库', exact: true })
        .click();
      await page.getByRole('heading', { name: '资料库', exact: true }).waitFor();
      await page
        .getByRole('complementary', { name: '索引与维护状态' })
        .getByText(`待维护 ${samples['/api/memory/maintenance'].body.pendingChecks} 项`, { exact: true })
        .waitFor();
      await page.getByRole('button', { name: '查看已处理', exact: true }).click();
      await page.getByRole('button', { name: '查看待收录', exact: true }).waitFor();
      await page.getByRole('button', { name: '查看待收录', exact: true }).click();
      await checkLayout(page, width);
      await screenshot(page, `entry-library-${width}.png`);
      await page.getByRole('link', { name: '索引与服务设置 ↗' }).click();
      await page.getByTestId('memory-settings').waitFor();
      const libraryReturn = page.getByRole('link', { name: '返回资料库 ↗', exact: true });
      assert.equal(await libraryReturn.getAttribute('href'), '/memory?tab=library');
      await libraryReturn.click();
      await page.getByRole('heading', { name: '资料库', exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, '/memory');
      assert.equal(new URL(page.url()).searchParams.get('tab'), 'library');
      // The shared shell host has no legacy feed response. Supply its actual empty DTO,
      // rather than the generic {} fallback; production classic remains unchanged.
      await page.route('**/api/knowledge/feed', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            needsReview: [],
            settled: [],
            rejected: [],
            stats: { decisions: 0, lessons: 0, methods: 0, total: 0 },
          }),
        }),
      );
      await checkLibraryManagement(page, width);
      await page.goto(`${runtime.origin}/memory?shell=classic&from=thread-origin`);
      await page.waitForFunction(
        () =>
          localStorage.getItem('cat-cafe:shell-presentation') === 'classic' && !document.documentElement.dataset.shell,
      );
      await page.getByTestId('memory-tab-feed').waitFor();
      await page.getByText('没有待确认的知识', { exact: true }).waitFor();
      assert.equal(await page.getByTestId('memory-page-preview').count(), 0);
      for (const name of ['知识动态', '搜索', '索引状态', '健康度', '图书馆', '知识图谱'])
        assert.ok(await page.getByTestId('memory-hub').getByRole('link', { name, exact: true }).isVisible());
      assert.deepEqual(view.errors, []);
      await screenshot(page, `entry-classic-${width}.png`);
    } catch (error) {
      const diagnostic = {
        url: view.page.url(),
        headings: await view.page.getByRole('heading').allTextContents(),
        pageErrors: view.errors,
        body: await view.page.locator('body').innerText(),
      };
      await writeFile(path.join(EVIDENCE_DIR, `entry-failure-${width}.json`), JSON.stringify(diagnostic, null, 2));
      await screenshot(view.page, `entry-failure-${width}.png`);
      console.log(JSON.stringify({ entryFailure: diagnostic }));
      throw error;
    } finally {
      await view.context.close();
    }
  });

test('real page keeps loading, unavailable, partial and verified empty distinct', async () => {
  const loading = await recallPage(runtime, { width: 1440, height: 960 }, 'loading');
  try {
    await flow(loading.page).getByText('正在读取召回记录…', { exact: true }).waitFor();
    assert.doesNotMatch(await flow(loading.page).innerText(), /还没有召回记录/);
    await screenshot(loading.page, 'recall-loading-1440.png');
    loading.setState('error');
    await flow(loading.page).getByRole('alert').waitFor();
    assert.match(await flow(loading.page).innerText(), /暂时读不到召回记录/);
    assert.doesNotMatch(await flow(loading.page).innerText(), /还没有召回记录/);
    await screenshot(loading.page, 'recall-unavailable-1440.png');
    loading.setState('ready');
    await flow(loading.page).getByRole('button', { name: '重试', exact: true }).click();
    await flow(loading.page).locator('article').first().waitFor();
    assert.equal(await flow(loading.page).getByRole('alert').count(), 0);
    assert.deepEqual(loading.errors, []);
  } finally {
    loading.setState('error');
    await loading.context.close();
  }
  for (const state of ['partial', 'empty']) {
    const view = await recallPage(runtime, { width: 390, height: 960 }, state);
    try {
      await flow(view.page)
        .getByText(state === 'partial' ? /部分读到/ : '还没有召回记录', { exact: state === 'empty' })
        .waitFor();
      if (state === 'partial') {
        assert.ok((await flow(view.page).locator('article').count()) > 0);
        assert.doesNotMatch(await flow(view.page).innerText(), /还没有召回记录/);
      } else assert.equal(await flow(view.page).locator('article').count(), 0);
      await checkLayout(view.page, 390);
      await screenshot(view.page, `recall-${state}-390.png`);
      assert.deepEqual(view.errors, []);
    } finally {
      await view.context.close();
    }
  }
});

test('real cursor pagination preserves earlier records through failure and recovery', async () => {
  const view = await recallPage(runtime, { width: 1440, height: 960 }, 'pagination');
  try {
    await flow(view.page).getByRole('button', { name: '读取更早的记录', exact: true }).waitFor();
    assert.equal(await flow(view.page).locator('article').count(), 50);
    view.failCursor(true);
    await flow(view.page).getByRole('button', { name: '读取更早的记录', exact: true }).click();
    await flow(view.page).getByText('暂时读不到更早的记录，已读到的记录仍在这里。').waitFor();
    assert.equal(await flow(view.page).locator('article').count(), 50);
    view.failCursor(false);
    await flow(view.page).getByRole('button', { name: '重试更早的记录', exact: true }).click();
    await view.page.waitForFunction(
      () => document.querySelectorAll('section[aria-label="所有对话的召回流水"] article').length === 55,
    );
    assert.equal(await flow(view.page).locator('article').count(), 55);
    assert.equal(await flow(view.page).getByRole('alert').count(), 0);
    assert.equal(await flow(view.page).getByRole('button', { name: '读取更早的记录', exact: true }).count(), 0);
    assert.deepEqual(view.errors, []);
  } finally {
    await view.context.close();
  }
});

test('real pull and relationship rows show queries, result counts and subsequent reads', async () => {
  const view = await recallPage(runtime, { width: 1440, height: 960 });
  try {
    const { page } = view;
    await waitReady(page);
    const response = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/memory/recall' && url.searchParams.get('source') === 'pull';
    });
    await page.getByRole('combobox', { name: '筛选召回来源' }).selectOption('pull');
    assert.equal((await response).status(), 200);
    const search = flow(page).locator('[data-recall-event-id="pull-visible"]');
    await search.getByText('记忆页的窄屏规则', { exact: true }).waitFor();
    const graphGroup = flow(page).locator('article').filter({ hasText: '关系查询 1' });
    await graphGroup.locator('[data-recall-group] > div button[aria-expanded]').click();
    const graph = graphGroup.locator('[data-recall-event-id="pull-other-thread"]');
    await graph.getByText('召回窗口与来源的关系', { exact: true }).waitFor();
    assert.match(await search.innerText(), /命中 1[\s\S]*之后读了 1/);
    assert.match(await graph.innerText(), /命中 2[\s\S]*之后读了 1/);
    await search.getByRole('button').click();
    await graph.getByRole('button').click();
    assert.ok((await search.getByRole('link').count()) > 0);
    assert.ok((await graph.getByRole('link').count()) > 0);
    await checkLayout(page, 1440);
    await screenshot(page, 'recall-search-1440.png');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.context.close();
  }
});

const prepareSearch = registerMemorySearchTests(() => runtime);
const prepareSettings = registerMemorySettingsTests(() => runtime);
