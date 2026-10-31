import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { realSurfaceApiResponse } from './f307-real-surface-fixtures.mjs';
import { EVIDENCE_DIR } from './f321-recall-browser.harness.mjs';

const metric = { value: null, unit: '%', sampleN: 3, sufficient: false, threshold: 20 };

export async function checkLibraryManagement(page, width) {
  await page.route('**/api/library/catalog', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        collections: ['active', 'archived'].map((status) => ({
          manifest: {
            id: `domain:${status}`,
            displayName: status === 'active' ? '当前资料库' : '已归档资料库',
            kind: 'domain',
            sensitivity: 'internal',
            status,
          },
          overview: null,
          health: null,
        })),
      }),
    }),
  );
  const writes = [];
  const recordWrite = (request) => {
    if (request.url().includes('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()))
      writes.push(request.url());
  };
  page.on('request', recordWrite);
  assert.ok(await page.getByRole('button', { name: '＋ 新建资料库', exact: true }).isVisible());
  await page.getByRole('link', { name: '管理资料库 ↗', exact: true }).click();
  await page.getByTestId('collection-catalog').waitFor();
  assert.equal(new URL(page.url()).pathname, '/memory/catalog');
  for (const name of ['重建索引', '归档', '取消归档'])
    assert.ok(await page.getByTestId('collection-catalog').getByRole('button', { name, exact: true }).isVisible());
  assert.deepEqual(writes, []);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `entry-management-${width}.png`), fullPage: true });
  await page.goBack();
  await page.getByRole('heading', { name: '资料库', exact: true }).waitFor();
  page.off('request', recordWrite);
}

const index = { healthy: true, backend: 'sqlite', docs_count: 1, threads_count: 3, edges_count: 0 };
const flag = {
  name: 'F200_CONSUMPTION_RERANK',
  category: 'evidence',
  defaultValue: 'off',
  currentValue: 'off',
  description: '消费重排序',
  sensitive: false,
  runtimeEditable: true,
  allowedValues: ['off', 'shadow', 'on'],
};
const service = {
  id: 'embedding-model',
  name: '嵌入模型',
  description: '语义检索',
  category: 'memory',
  features: ['memory-semantic-search'],
  endpoint: null,
  configured: false,
  status: 'not_configured',
  installed: true,
  enabled: false,
  installable: true,
  selectedModel: 'fixture-embedding',
};

export function registerMemorySettingsTests(getRuntime) {
  let samples;
  async function prepare() {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'test/memory-settings-browser-fixture.ts'], {
      cwd: path.resolve('../api'),
      encoding: 'utf8',
      maxBuffer: 5_000_000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const line = result.stdout.split('\n').find((item) => item.startsWith('F321_SETTINGS_JSON='));
    assert.ok(line, 'production maintenance samples missing');
    samples = JSON.parse(line.slice('F321_SETTINGS_JSON='.length));
    await writeFile(path.join(EVIDENCE_DIR, 'settings-api-samples.json'), JSON.stringify(samples));
  }
  async function view(width, state = 'ready') {
    const runtime = getRuntime();
    assert.ok(runtime, 'existing governed browser must be ready');
    const context = await runtime.browser.newContext({ viewport: { width, height: 960 } });
    const page = await context.newPage();
    // Settings uses synthetic HTTP owners; the shared shell must not register with a live socket server.
    await page.routeWebSocket('**/socket.io/**', (socket) => socket.close());
    const requests = [];
    const errors = [];
    const trace = [];
    const chunks = [];
    page.on('pageerror', (error) =>
      trace.push({ kind: 'pageerror', at: Date.now(), url: page.url(), message: error.message, stack: error.stack }),
    );
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.endsWith('/app/layout.js')) {
        chunks.push(recordLayoutChunk(response, trace, width, state));
      }
    });
    let mode = state;
    let effectiveMode = 'off';
    let configWritable = false;
    const held = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const key = url.pathname + url.search;
      requests.push({ key, method: request.method(), body: request.postData() });
      let response = samples[key] ?? settingsResponse(key, mode, effectiveMode);
      if (key === '/api/recall/flags' && mode === 'loading') await new Promise((resolve) => held.push(resolve));
      if (request.method() !== 'GET' && ['/api/evidence/rebuild', '/api/config/env'].includes(key))
        response = { status: 403, body: { error: 'Forbidden' } };
      if (key === '/api/config/env' && request.method() === 'PATCH' && configWritable) {
        effectiveMode = JSON.parse(request.postData()).updates[0].value;
        assert.ok(['off', 'shadow', 'on'].includes(effectiveMode));
        response = { body: { ok: true } };
      }
      response ??= realSurfaceApiResponse(request, false);
      await route.fulfill({
        status: response.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(response.body),
      });
    });
    await page.goto(`${runtime.origin}/memory/preview?tab=library&shell=v2`, { waitUntil: 'domcontentloaded' });
    // The settings link exists in SSR. Wait for the owner read and shell intent to hydrate before following it.
    await page
      .getByRole('complementary', { name: '索引与维护状态' })
      .getByText(`待维护 ${samples['/api/memory/maintenance'].body.pendingChecks} 项`, { exact: true })
      .waitFor();
    await page.waitForFunction(() => document.documentElement.dataset.shell === 'v2');
    trace.push({ kind: 'library-ready', at: Date.now() });
    await page.getByRole('link', { name: '索引与服务设置 ↗' }).click();
    await page.getByTestId('memory-settings').waitFor();
    trace.push({ kind: 'settings-ready', at: Date.now() });
    return {
      page,
      context,
      requests,
      errors,
      allowConfigUpdate() {
        configWritable = true;
      },
      async recordTrace() {
        await Promise.all(chunks);
        await writeFile(
          path.join(EVIDENCE_DIR, `settings-trace-${width}-${state}.json`),
          JSON.stringify(trace, null, 2),
        );
      },
      setState(next) {
        mode = next;
        for (const resolve of held.splice(0)) resolve();
      },
    };
  }
  for (const width of [1440, 390])
    test(`real Settings keeps the memory controls and owner maintenance link at ${width}px`, async () => {
      const v = await view(width);
      try {
        const pane = v.page.getByTestId('memory-settings');
        await pane.getByTestId('f200-rerank-badge').getByText('关闭', { exact: true }).waitFor();
        await pane.getByText('样本不足：3 / 20').first().waitFor();
        assert.match(v.page.url(), /\/settings\?s=ops&ops=memory/);
        assert.match(await pane.innerText(), /索引与召回[\s\S]*重建索引[\s\S]*召回功能标志/);
        for (const name of ['EMBED_MODE', 'F102_ABSTRACTIVE']) {
          const badge = pane.getByTestId(`feature-readonly-${name}`);
          assert.match(await badge.innerText(), /off · 只读/);
          assert.equal(await badge.locator('..').getByRole('button').count(), 0);
        }
        assert.match(await pane.innerText(), /off 不会停用已启用的服务/);
        assert.match(await pane.innerText(), /实际状态以本页“记忆整理”的持久开关为准/);
        assert.equal(
          await v.page.getByRole('button', { name: '索引与召回', exact: true }).getAttribute('aria-pressed'),
          'true',
        );
        assert.ok(
          await v.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          'Settings overflows',
        );
        await v.page.screenshot({ path: path.join(EVIDENCE_DIR, `settings-ready-${width}.png`), fullPage: true });
        await pane.getByRole('button', { name: '修改端口或模型' }).click();
        await v.page.getByText('没有权限读取服务预览', { exact: true }).waitFor();
        assert.equal(await v.page.getByRole('button', { name: '保存修改', exact: true }).isEnabled(), false);
        await v.page.screenshot({
          path: path.join(EVIDENCE_DIR, `settings-service-preview-${width}.png`),
          fullPage: true,
        });
        await v.page.getByRole('button', { name: '关闭', exact: true }).click();
        await pane.getByTestId('rebuild-button').click();
        await pane.getByTestId('rebuild-error').getByText('没有权限重建索引', { exact: true }).waitFor();
        await pane.locator('#evidence-feature-flags button').click();
        await pane.getByText('没能更新这个开关 · 没有权限更新这个开关', { exact: true }).waitFor();
        assert.equal(await pane.getByTestId('f200-rerank-badge').innerText(), '关闭');
        const writes = v.requests.filter((request) => request.method !== 'GET');
        assert.deepEqual(
          writes.map((request) => request.key),
          ['/api/evidence/rebuild', '/api/config/env'],
        );
        assert.deepEqual(JSON.parse(writes[1].body), { updates: [{ name: flag.name, value: 'shadow' }] });
        await v.page.screenshot({ path: path.join(EVIDENCE_DIR, `settings-denied-${width}.png`), fullPage: true });
        if (width === 1440) {
          v.allowConfigUpdate();
          await pane.locator('#evidence-feature-flags button').click();
          await pane.getByTestId('f200-rerank-badge').getByText('影子模式', { exact: true }).waitFor();
          await pane.locator('#evidence-feature-flags button').getByText('shadow', { exact: true }).waitFor();
          await v.page.screenshot({ path: path.join(EVIDENCE_DIR, 'settings-updated-1440.png'), fullPage: true });
        }
        await pane.getByRole('region', { name: '召回三轴观测' }).scrollIntoViewIfNeeded();
        await v.page.screenshot({
          path: path.join(EVIDENCE_DIR, `settings-observations-${width}.png`),
          fullPage: true,
        });
        await v.recordTrace();
        assert.deepEqual(v.errors, []);
        await writeFile(path.join(EVIDENCE_DIR, `settings-requests-${width}.json`), JSON.stringify(v.requests));
      } finally {
        await v.context.close();
      }
    });
  test('real Settings preserves independent error, loading, partial and no-data states with recovery', async () => {
    const v = await view(1440, 'error');
    try {
      const pane = v.page.getByTestId('memory-settings');
      await pane.getByText('暂时读不到召回功能标志', { exact: true }).waitFor();
      await pane.getByText('暂时读不到服务状态', { exact: true }).waitFor();
      await pane.getByText('暂时读不到索引状态', { exact: true }).waitFor();
      await pane.getByText('样本不足：3 / 20').first().waitFor();
      await pane.getByText('部分读到：2 个时间窗已核对。', { exact: true }).waitFor();
      await v.page.screenshot({ path: path.join(EVIDENCE_DIR, 'settings-partial-1440.png'), fullPage: true });
      v.setState('loading');
      const flags = pane.getByText('暂时读不到召回功能标志', { exact: true }).locator('..');
      await flags.getByRole('button', { name: '重试' }).click();
      await pane.getByText('加载中...', { exact: true }).waitFor();
      await v.page.screenshot({ path: path.join(EVIDENCE_DIR, 'settings-loading-1440.png'), fullPage: true });
      v.setState('ready');
      await pane.getByTestId('f200-rerank-badge').getByText('关闭', { exact: true }).waitFor();
      await pane.getByRole('button', { name: '重读 14 天观测' }).click();
      await pane.getByTestId('three-axis-section').getByText('无数据').first().waitFor();
      await v.recordTrace();
      assert.deepEqual(v.errors, []);
    } finally {
      await v.context.close();
    }
  });
  return prepare;
}

async function recordLayoutChunk(response, trace, width, state) {
  const frame = { kind: 'layout-chunk', at: Date.now(), url: response.url(), status: response.status() };
  try {
    const body = await response.text();
    frame.bytes = Buffer.byteLength(body);
    frame.sha256 = createHash('sha256').update(body).digest('hex');
    try {
      new Script(body);
      frame.syntax = 'valid';
    } catch (error) {
      frame.syntax = 'invalid';
      frame.syntaxError = error.stack;
      await writeFile(path.join(EVIDENCE_DIR, `layout-invalid-${width}-${state}.js`), body);
    }
  } catch (error) {
    frame.readError = error.message;
  }
  trace.push(frame);
}

function settingsResponse(key, mode, effectiveMode) {
  const body = {
    '/api/session': { userId: 'owner' },
    '/api/evidence/status': index,
    '/api/config/env-summary': {
      variables: [
        { ...flag, currentValue: effectiveMode },
        { ...flag, name: 'EMBED_MODE', currentValue: 'off', runtimeEditable: false },
        {
          ...flag,
          name: 'F102_ABSTRACTIVE',
          currentValue: 'off',
          runtimeEditable: undefined,
          allowedValues: undefined,
        },
      ],
    },
    '/api/recall/flags': { f200: { consumptionRerank: effectiveMode } },
    '/api/services': { services: [service] },
    '/api/services/embedding-model/install-preview': null,
    '/api/library/tool-usage-metrics': {
      generatedAt: '2026-10-05T11:00:00Z',
      threadCount: 3,
      distribution: { searchEvidence: metric, graphResolve: metric, listRecent: metric },
      grepAfterSearchRate: metric,
      candidateSelectionDistribution: metric,
      listRecentAdoptionRate: metric,
      nudgeFailureRate: metric,
    },
  }[key];
  if (new URL(key, 'http://fixture').pathname === '/api/services/embedding-model/install-preview')
    return { status: 403, body: { error: 'Forbidden' } };
  if (mode === 'error' && ['/api/evidence/status', '/api/recall/flags', '/api/services'].includes(key))
    return { status: 403, body: { error: 'Forbidden' } };
  if (key.startsWith('/api/recall/lifecycle/three-axis')) {
    const days = Number(new URL(`http://fixture${key}`).searchParams.get('days'));
    if (mode === 'error' && days === 14) return { status: 503, body: { error: 'Unavailable' } };
    const reading = { value: 0, maturity: 'no-data', reason: '没有可核对的样本' };
    return {
      body: {
        days,
        from: 0,
        to: 1,
        harmfulConsumption: reading,
        unmetDemandLowerBound: reading,
        attentionCost: reading,
      },
    };
  }
  return body ? { body } : null;
}
