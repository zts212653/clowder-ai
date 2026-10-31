import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { realSurfaceApiResponse } from './f307-real-surface-fixtures.mjs';
import { EVIDENCE_DIR } from './f321-recall-browser.harness.mjs';

export function registerMemorySearchTests(getRuntime) {
  let runtime;
  let sample;
  async function prepare() {
    await mkdir(EVIDENCE_DIR, { recursive: true });
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'test/memory-search-browser-fixture.ts'], {
      cwd: path.resolve('../api'),
      encoding: 'utf8',
      maxBuffer: 5_000_000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const line = result.stdout.split('\n').find((r) => r.startsWith('F321_SEARCH_JSON='));
    assert.ok(line);
    sample = JSON.parse(line.slice('F321_SEARCH_JSON='.length));
    await writeFile(path.join(EVIDENCE_DIR, 'search-api-samples.json'), JSON.stringify(sample));
    runtime = getRuntime();
    assert.ok(runtime, 'shared governed browser must be ready');
  }
  async function view(width = 1440) {
    const context = await runtime.browser.newContext({ viewport: { width, height: 960 } });
    const page = await context.newPage();
    let mode = 'ready';
    const held = [];
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      url.searchParams.sort();
      const key = url.pathname + url.search;
      let response = sample.samples[key];
      if (url.pathname === '/api/memory/search') {
        if (mode === 'loading' || url.searchParams.get('q') === 'old')
          await new Promise((resolve) => held.push(resolve));
        assert.ok(response, `missing real API search sample ${key}`);
        response = searchReadState(response, mode);
      }
      const hosts = {
        '/api/session': { userId: 'owner' },
        '/api/evidence/status': { healthy: true, backend: 'sqlite', docs_count: 4 },
        '/api/memory/maintenance': { pendingChecks: 0, passedChecks: 6 },
        '/api/memory/taste': { readStatus: 'ready', entries: [], coverage: { unverified: 0 }, dimensionHints: null },
      };
      if (url.pathname === `/api/threads/${sample.ownThreadId}/messages`)
        response ??= sample.samples[`/api/threads/${sample.ownThreadId}/messages?limit=50`];
      if (url.pathname === '/api/messages' && url.searchParams.get('threadId') === sample.ownThreadId)
        response = sample.samples[`/api/threads/${sample.ownThreadId}/messages?limit=50`];
      response ??= hosts[url.pathname] ? { body: hosts[url.pathname] } : realSurfaceApiResponse(route.request(), false);
      await route.fulfill({
        status: response.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(response.body),
      });
    });
    await page.goto(`${runtime.origin}/memory/preview?tab=all&shell=v2`, { waitUntil: 'domcontentloaded' });
    // A server-rendered input can be filled before React has attached its change handler.
    // The independent status read proves this page's effects have committed before input.
    await page.getByTestId('memory-status-line').getByText('索引正常', { exact: true }).waitFor();
    const search = async (q = '搜索设计') => {
      await page.getByRole('textbox', { name: '搜索记忆和资料' }).fill(q);
      const frame = await page.evaluate(() => ({
        input: document.querySelector('input[aria-label="搜索记忆和资料"]')?.value,
        buttonDisabled: document
          .querySelector('input[aria-label="搜索记忆和资料"]')
          ?.closest('form')
          ?.querySelector('button')?.disabled,
        status: document.querySelector('[data-testid="memory-status-line"]')?.textContent,
      }));
      console.log(JSON.stringify({ searchInputFrame: frame }));
      if (width === 1440) await page.getByRole('textbox', { name: '搜索记忆和资料' }).press('Enter');
      else await page.getByRole('button', { name: '搜索', exact: true }).click();
    };
    return {
      page,
      context,
      search,
      errors,
      setMode: (m) => {
        mode = m;
        for (const resolve of held.splice(0)) resolve();
      },
      release: () => {
        for (const resolve of held.splice(0)) resolve();
      },
    };
  }
  const panel = (page) => page.getByRole('region', { name: '记忆搜索结果' });
  for (const width of [1440, 390])
    test(`real unified search renders three source families and usable controls at ${width}px`, async () => {
      const v = await view(width);
      try {
        await v.search();
        await panel(v.page).getByRole('heading', { name: '搜索设计规范', exact: true }).waitFor();
        assert.match(await panel(v.page).innerText(), /品味[\s\S]*设计规范[\s\S]*对话/);
        assert.match(await panel(v.page).innerText(), /已验证/);
        assert.equal(await v.page.getByTestId('memory-page-preview').locator('nav [aria-current="page"]').count(), 0);
        assert.doesNotMatch(await panel(v.page).innerText(), /记录日期|2026-09-25/);
        assert.match(await panel(v.page).innerText(), /\d+ 月 \d+ 日/);
        assert.doesNotMatch(await panel(v.page).innerText(), /其他主人的私有|sourcePath|search-design|contentRevision/);
        const layout = await v.page.evaluate(() => ({
          viewport: innerWidth,
          body: document.documentElement.scrollWidth,
        }));
        assert.ok(layout.body <= width + 1, JSON.stringify(layout));
        await v.page.screenshot({ path: path.join(EVIDENCE_DIR, `search-ready-${width}.png`), fullPage: true });
        await panel(v.page).getByRole('button', { name: '记忆', exact: true }).click();
        await panel(v.page).locator('article').getByRole('button', { name: '打开 ↗', exact: true }).click();
        await panel(v.page).getByRole('heading', { name: '品味详情', exact: true }).waitFor();
        await panel(v.page)
          .getByText(/搜索设计先看真实界面/)
          .waitFor();
        await v.page.screenshot({ path: path.join(EVIDENCE_DIR, `search-taste-${width}.png`), fullPage: true });
        await panel(v.page).getByRole('button', { name: '返回搜索', exact: true }).click();
        await panel(v.page).getByRole('button', { name: '文档', exact: true }).click();
        const row = panel(v.page)
          .locator('article')
          .filter({ has: v.page.getByRole('heading', { name: '搜索设计规范', exact: true }) });
        await row.getByRole('button', { name: '打开 ↗', exact: true }).click();
        await v.page.getByRole('heading', { name: '搜索设计规范', exact: true }).last().waitFor();
        assert.match(await panel(v.page).innerText(), /读不到与空分开/);
        await v.page.screenshot({ path: path.join(EVIDENCE_DIR, `search-document-${width}.png`), fullPage: true });
        await panel(v.page).getByRole('button', { name: '返回搜索', exact: true }).click();
        await row.getByText('⋯', { exact: true }).click();
        await row.getByRole('button', { name: '查看关系图', exact: true }).click();
        await panel(v.page).getByTestId('graph-svg').waitFor();
        assert.match((await panel(v.page).getByTestId('graph-svg').textContent()) ?? '', /设计规范/);
        assert.doesNotMatch(await panel(v.page).innerText(), /search-design|read-states|project:search|Selected node/);
        const graphLayout = await panel(v.page)
          .getByTestId('graph-svg')
          .evaluate((svg) =>
            [...svg.querySelectorAll('rect')].map((rect) => ({
              x: rect.x.baseVal.value,
              width: rect.width.baseVal.value,
            })),
          );
        assert.equal(graphLayout.length, 2);
        const [left, right] = graphLayout.sort((a, b) => a.x - b.x);
        assert.ok(left.x + left.width < right.x, JSON.stringify(graphLayout));
        await v.page.screenshot({ path: path.join(EVIDENCE_DIR, `search-graph-${width}.png`), fullPage: true });
        assert.deepEqual(v.errors, []);
      } finally {
        await v.context.close();
      }
    });

  test('real search keeps loading, source failure, malformed body and verified memory-empty distinct', async () => {
    const v = await view();
    try {
      v.setMode('loading');
      await v.search();
      await panel(v.page).getByText('正在搜索…', { exact: true }).waitFor();
      await v.page.screenshot({ path: path.join(EVIDENCE_DIR, 'search-loading-1440.png'), fullPage: true });
      v.setMode('partial');
      await panel(v.page).getByText('文档暂时读不到', { exact: false }).waitFor();
      await panel(v.page).getByRole('heading', { name: '搜索设计的讨论', exact: true }).waitFor();
      await v.page.screenshot({ path: path.join(EVIDENCE_DIR, 'search-partial-1440.png'), fullPage: true });
      v.setMode('error');
      await v.search();
      await panel(v.page).getByText('暂时读不到搜索结果', { exact: false }).waitFor();
      assert.doesNotMatch(await panel(v.page).innerText(), /没有找到匹配/);
      await v.page.screenshot({ path: path.join(EVIDENCE_DIR, 'search-unavailable-1440.png'), fullPage: true });
      v.setMode('malformed');
      await panel(v.page).getByRole('button', { name: '重试', exact: true }).click();
      await panel(v.page).getByText('暂时读不到搜索结果', { exact: false }).waitFor();
      v.setMode('ready');
      await v.search('never-seen-token');
      await panel(v.page).getByRole('button', { name: '记忆', exact: true }).click();
      await panel(v.page).getByText('记忆里没有找到匹配。', { exact: true }).waitFor();
      await v.page.screenshot({ path: path.join(EVIDENCE_DIR, 'search-empty-1440.png'), fullPage: true });
      assert.deepEqual(v.errors, []);
    } finally {
      v.release();
      await v.context.close();
    }
  });

  test('real search ignores late queries and cancellation, then admits the exact canonical message before navigating', async () => {
    const v = await view();
    try {
      await v.search('old');
      await panel(v.page).getByText('正在搜索…', { exact: true }).waitFor();
      await v.search();
      await panel(v.page).getByRole('heading', { name: '搜索设计规范', exact: true }).waitFor();
      v.release();
      await v.page.waitForLoadState('networkidle');
      assert.match(await panel(v.page).innerText(), /“搜索设计” 的搜索结果/);
      await v.search('old');
      await panel(v.page).getByText('正在搜索…', { exact: true }).waitFor();
      await panel(v.page).getByRole('button', { name: '关闭搜索', exact: true }).click();
      v.release();
      await v.page.waitForLoadState('networkidle');
      assert.equal(await panel(v.page).count(), 0);
      await v.search();
      await panel(v.page).getByRole('heading', { name: '搜索设计规范', exact: true }).waitFor();
      await panel(v.page).getByRole('button', { name: '对话', exact: true }).click();
      const row = panel(v.page)
        .locator('article')
        .filter({ has: v.page.getByRole('heading', { name: '搜索设计的讨论', exact: true }) });
      await row.getByRole('button', { name: '打开 ↗', exact: true }).click();
      await v.page.waitForURL(`**/thread/${sample.ownThreadId}`);
      assert.equal(new URL(v.page.url()).pathname, `/thread/${sample.ownThreadId}`);
      await v.page.getByText('搜索设计要显示原话和出处。', { exact: false }).last().waitFor();
      await v.page.screenshot({ path: path.join(EVIDENCE_DIR, 'search-message-1440.png'), fullPage: true });
      assert.deepEqual(v.errors, []);
    } finally {
      v.release();
      await v.context.close();
    }
  });
  return prepare;
}

function searchReadState(response, mode) {
  if (mode === 'error')
    response = {
      body: {
        ...response.body,
        readStatus: 'unavailable',
        groups: response.body.groups.map((g) => ({ ...g, status: 'unavailable', results: [] })),
      },
    };
  if (mode === 'partial')
    response = {
      body: {
        ...response.body,
        readStatus: 'partial',
        groups: response.body.groups.map((g) =>
          g.type === 'documents' ? { ...g, status: 'unavailable', results: [] } : g,
        ),
      },
    };
  if (mode === 'malformed') response = { body: { groups: null } };

  return response;
}
