import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { registerMessageReadingVisibilityCases } from './message-reading-visibility.cases.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(webRoot, '../..');
const origin = 'https://f322-results.test';
const evidence = path.join(repoRoot, '.cat-cafe/tmp/message-results-browser');
const productionCss = JSON.parse(
  await fs.readFile(path.join(webRoot, 'src/generated/vendor-stylesheets.json'), 'utf8'),
);
assert(productionCss.length > 0, 'load the same stylesheet manifest as the real document');
let browser, script, css;
const originalCwd = process.cwd();
const records = Array.from({ length: 18 }, (_, index) => ({
  from: { kind: 'agent', catId: 'codex61-sol' },
  id: `old-${index}`,
  type: 'assistant',
  catId: 'codex61-sol',
  timestamp: 1790860800000 + index,
  content: `第 ${index + 1} 条原消息：琴键导航与阅读位置。${'真实组件受控历史。'.repeat(12)}`,
}));
before(async () => {
  process.chdir(webRoot);
  const built = await build({
    root: webRoot,
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@': path.join(webRoot, 'src') } },
    define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(webRoot, 'test/browser/fixtures/f322-message-results.tsx'),
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  });
  const outputs = Array.isArray(built) ? built.flatMap((r) => r.output) : built.output;
  script = outputs.find((o) => o.type === 'chunk' && o.isEntry).code;
  css = outputs
    .filter((o) => o.type === 'asset' && o.fileName.endsWith('.css'))
    .map((o) => o.source)
    .join('\n');
  await fs.mkdir(evidence, { recursive: true });
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  process.chdir(originalCwd);
});
function searchAnswer(url, coldReturn = false) {
  const systemNotice = url.searchParams.get('q') === 'system-notice';
  const connector = url.searchParams.get('q') === 'external-connector';
  return {
    searchId: crypto.randomUUID(),
    query: url.searchParams.get('q'),
    results: [records[0], records[3]].map((record) => ({
      threadId: coldReturn ? 'remote-controlled' : 'recall-controlled',
      messageId: record.id,
      threadTitle: '受控历史',
      speaker: systemNotice ? 'system' : connector ? 'connector' : record.catId,
      ...(connector ? { speakerLabel: 'Alpha Connector · Acceptance source' } : {}),
      timestamp: record.timestamp,
      timelineOrderAt: record.timestamp,
      snippet: {
        text: systemNotice ? '[定时任务] 持球唤醒。' : record.content.slice(0, 60),
        start: 0,
        end: 60,
        source: 'body',
      },
      highlights: systemNotice
        ? []
        : [{ start: record.content.indexOf('琴键'), end: record.content.indexOf('琴键') + 2 }],
      match: 'lexical',
      contentRevision: 'controlled',
      publiclyQuotable: true,
    })),
    meta: {
      scope: url.searchParams.has('threadId') ? 'thread' : 'global',
      sort: url.searchParams.get('messageSort'),
      effectiveMode: 'lexical',
      requestedMode: 'hybrid',
      degraded: true,
      partial: true,
      hasMore: true,
      candidateLimit: 2000,
      sourceCoverage: 'unknown',
      freshness: 'unknown',
      semanticCandidatesLimited: false,
      response: { budgetChars: 24000, serializedChars: 1000, truncated: false, continuation: 'unavailable' },
    },
  };
}
async function open(
  viewport = { width: 1440, height: 900 },
  dark = false,
  coldReturn = false,
  pendingRestore = false,
  longMessage = false,
  workspace = false,
) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  const queries = [];
  const pages = [];
  let originReads = 0;
  let releaseHistory;
  const historyGate = new Promise((resolve) => {
    releaseHistory = resolve;
  });
  if (longMessage) await page.addInitScript(() => localStorage.setItem('cat-cafe:shell-presentation', 'v2'));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, 'never call runtime or provider');
    if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: script });
    if (url.pathname === '/proof.css') return route.fulfill({ contentType: 'text/css', body: css });
    if (productionCss.includes(url.pathname))
      return fs
        .readFile(path.join(webRoot, 'public', url.pathname.slice(1)), 'utf8')
        .then((body) => route.fulfill({ contentType: 'text/css', body }));
    if (url.pathname.startsWith('/api/')) {
      let body = { cats: [], tasks: [], queue: [], activeInvocations: [] };
      if (url.pathname === '/api/cats')
        body = {
          cats: [
            {
              id: 'codex61-sol',
              displayName: '砚砚',
              breedId: 'maine-coon',
              avatar: '/avatars/codex.png',
              mentionPatterns: ['@codex61-sol'],
              carrier: 'cli',
              clientId: 'openai',
              defaultModel: 'gpt-6.1-sol',
              color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
            },
          ],
        };
      if (url.pathname === '/api/messages') {
        body = {
          messages: longMessage
            ? records.map((record, index) =>
                index === 0 ? { ...record, content: '长消息开头。\n\n' + '琴键长消息正文。\n\n'.repeat(180) } : record,
              )
            : records,
          hasMore: false,
        };
        if (pendingRestore && url.searchParams.get('threadId') === 'recall-controlled' && ++originReads > 1) {
          await historyGate;
        }
        if (coldReturn && url.searchParams.get('threadId') === 'recall-controlled') {
          const before = url.searchParams.get('before');
          if (before) {
            const observation = { before, waitMs: 0 };
            pages.push(observation);
            const startedAt = performance.now();
            // Two authoritative older pages each outlast the former 90-frame budget.
            await new Promise((resolve) => setTimeout(resolve, 2000));
            observation.waitMs = performance.now() - startedAt;
            const tailPage = before.endsWith(':old-14');
            body = { messages: tailPage ? records.slice(8, 14) : records.slice(0, 8), hasMore: tailPage };
          } else if (++originReads > 1) body = { messages: records.slice(14), hasMore: true };
        }
      }
      if (url.pathname === '/api/evidence/search') {
        queries.push(Object.fromEntries(url.searchParams));
        body = searchAnswer(url, coldReturn);
      }
      if (url.pathname === '/api/evidence/navigation-source') {
        body = {
          status: 'available',
          updated: false,
          target: {
            threadId: url.searchParams.get('threadId'),
            ...(url.searchParams.has('messageId')
              ? { messageId: url.searchParams.get('messageId'), contentRevision: 'controlled' }
              : {}),
          },
        };
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    if (url.pathname === '/avatars/codex.png')
      return route.fulfill({
        contentType: 'image/png',
        body: await fs.readFile(path.join(webRoot, 'public/avatars/codex.png')),
      });
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html ${dark ? 'data-theme="dark" class="dark"' : ''}><meta charset="utf-8">${productionCss.map((href) => `<link rel="stylesheet" href="${href}">`).join('')}<link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script></html>`,
    });
  });
  await page.goto(
    workspace
      ? `${origin}?proofWorkspace=1`
      : longMessage
        ? `${origin}?proofLong=1`
        : pendingRestore
          ? `${origin}?proofNavigation=1`
          : origin,
  );
  await page.getByRole('button', { name: '查找消息', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索消息' }).fill('琴键');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.locator('[data-message-search-result]').first().waitFor();
  return { page, errors, queries, pages, releaseHistory };
}

registerMessageReadingVisibilityCases({ open, evidence });

for (const width of [1440, 390]) {
  test(`search trip leaves the Workspace return clickable and resumes in Chat at ${width}px`, async () => {
    const { page, errors } = await open({ width, height: 900 }, false, false, false, false, true);
    try {
      await page.locator('[data-message-search-result]').first().getByRole('button', { name: '跳过去' }).click();
      const controls = page.getByRole('navigation', { name: '浏览本次检索结果' });
      await page.waitForFunction(() => document.querySelector('nav output')?.textContent === '1 / 2');
      await page.getByRole('button', { name: '查看原图', exact: true }).click();
      await page.screenshot({ path: path.join(evidence, `workspace-return-${width}.png`) });
      if (width === 1440) {
        const bounds = await controls.boundingBox();
        const chat = await page.getByTestId('thread-chat-host').boundingBox();
        assert(bounds && chat);
        assert(
          bounds.x >= chat.x && bounds.x + bounds.width <= chat.x + chat.width,
          'controls stay in the Chat column',
        );
      } else {
        assert.equal(await controls.count(), 0, 'covered Chat does not expose search navigation over Workspace');
      }
      await page.getByRole('button', { name: '‹ 聊天', exact: true }).click({ timeout: 4000 });
      await controls.getByRole('button', { name: '下一处结果' }).click();
      await page.waitForFunction(() => document.querySelector('nav output')?.textContent === '2 / 2');
      await controls.getByRole('button', { name: '回到刚才', exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-reading-trip-status]')?.getAttribute('data-reading-trip-status') ===
          'completed',
      );
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

test('cached thread restores its visible bottom before an unread revalidation response arrives', async () => {
  const { page, errors, releaseHistory } = await open({ width: 1440, height: 900 }, false, false, true);
  try {
    await page.getByRole('button', { name: '关闭消息搜索', exact: true }).click();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-reading-surface]');
      return el && el.scrollTop > 0 && Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) <= 1;
    });
    await page.getByRole('button', { name: '另一对话', exact: true }).click();
    await page.waitForURL(`${origin}/thread/remote-controlled`);
    await page.locator('[data-message-id="old-17"]').waitFor();
    const pending = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === '/api/messages' &&
        new URL(request.url()).searchParams.get('threadId') === 'recall-controlled',
    );
    await page.getByRole('button', { name: '未读缓存对话', exact: true }).click();
    await pending;
    await page.waitForURL(`${origin}/thread/recall-controlled`);
    // The response remains held. Observe real Chromium geometry after layout,
    // without using the test timeout as a product timing contract.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const beforeResponse = await page.locator('[data-reading-surface]').evaluate((el) => ({
      top: el.scrollTop,
      max: el.scrollHeight - el.clientHeight,
    }));
    assert(beforeResponse.max > 0);
    assert(Math.abs(beforeResponse.top - beforeResponse.max) <= 1, 'cached bottom must be visible before HTTP returns');
    releaseHistory();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-reading-surface]');
      return el && Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) <= 1;
    });
    await fs.writeFile(path.join(evidence, 'cached-pending-return.json'), JSON.stringify({ beforeResponse }, null, 2));
    assert.deepEqual(errors, []);
  } finally {
    releaseHistory();
    await page.close();
  }
});
test('system-notice results keep a neutral identity in the production renderer', async () => {
  const { page, errors } = await open();
  try {
    await page.getByRole('textbox', { name: '搜索消息' }).fill('system-notice');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page.getByRole('button', { name: '跳过去：系统通知 · 第1处', exact: true }).waitFor();
    const hits = page.locator('[data-message-search-result]');
    assert.equal(await hits.count(), 2);
    assert.equal(await hits.locator('[data-testid="message-result-human-nameplate"]').count(), 0);
    assert.equal(await hits.locator('[data-testid="cat-nameplate"]').count(), 0);
    assert((await hits.first().innerText()).includes('系统通知'));
    await page.screenshot({ path: path.join(evidence, 'system-notice-neutral.png') });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
test('connector source and sender remain neutral in the production result renderer', async () => {
  const { page, errors } = await open();
  try {
    await page.getByRole('textbox', { name: '搜索消息' }).fill('external-connector');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page
      .getByRole('button', { name: '跳过去：Alpha Connector · Acceptance source · 第1处', exact: true })
      .waitFor();
    const hits = page.locator('[data-message-search-result]');
    assert.equal(await hits.locator('[data-testid="message-result-human-nameplate"]').count(), 0);
    assert.equal(await hits.locator('[data-testid="cat-nameplate"]').count(), 0);
    await page.screenshot({ path: path.join(evidence, 'connector-source-neutral.png') });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
test('a tall original chat message lands with its nameplate and beginning inside the reading viewport', async () => {
  const { page, errors } = await open({ width: 1440, height: 900 }, false, false, false, true);
  try {
    // Exercise the original disclosure control; folded text is only 374px tall.
    await page.getByRole('button', { name: '关闭消息搜索', exact: true }).click();
    const target = page.locator('[data-message-id="old-0"]');
    await target.getByRole('button', { name: /^展开（还有 \d+ 行）$/ }).click();
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-message-id="old-0"]');
      const viewport = document.querySelector('[data-reading-surface]');
      return row && viewport && row.getBoundingClientRect().height > viewport.clientHeight;
    });
    await page.locator('[data-reading-surface]').hover({ position: { x: 40, y: 600 } });
    await page.mouse.wheel(0, 16000);
    await page.waitForFunction(() => {
      const viewport = document.querySelector('[data-reading-surface]');
      return Math.abs(viewport.scrollTop - (viewport.scrollHeight - viewport.clientHeight)) <= 1;
    });
    const originTop = await page.locator('[data-reading-surface]').evaluate((el) => el.scrollTop);
    await page.getByRole('button', { name: '查找消息', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索消息' }).fill('琴键');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page.locator('[data-message-search-result]').first().waitFor();
    await page.getByRole('button', { name: /跳过去.*第1处/ }).click();
    await page.locator('[data-reading-trip-status="ready"]').waitFor();
    const readyAnchor = await page.evaluate(
      () => JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:recall-controlled')).state,
    );
    assert.equal(readyAnchor.messageAnchor.messageId, 'old-0');
    assert.equal(
      readyAnchor.messageAnchor.viewportOffsetPx,
      6,
      'ready must persist the face-safe author-header offset',
    );
    const landed = await target.evaluate((row) => {
      const viewport = document.querySelector('[data-reading-surface]');
      const plate = row.querySelector('[data-testid="cat-nameplate"]');
      return {
        url: location.href,
        height: row.getBoundingClientRect().height,
        viewportHeight: viewport.clientHeight,
        top: row.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
        scrollTop: viewport.scrollTop,
        plateText: plate?.textContent,
        plateTop: plate?.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
        shell: localStorage.getItem('cat-cafe:shell-presentation'),
        text: row.innerText.slice(0, 300),
      };
    });
    console.log('long-message landed', JSON.stringify(landed));
    await fs.writeFile(path.join(evidence, 'long-message-landed.json'), JSON.stringify(landed, null, 2));
    await page.screenshot({ path: path.join(evidence, 'long-message-landed.png') });
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-message-id="old-0"]');
      const viewport = document.querySelector('[data-reading-surface]');
      const plate = row?.querySelector('[data-testid="cat-nameplate"]');
      return (
        plate &&
        viewport &&
        row.getBoundingClientRect().height > viewport.clientHeight &&
        plate.getBoundingClientRect().top >= viewport.getBoundingClientRect().top &&
        plate.getBoundingClientRect().bottom <= viewport.getBoundingClientRect().bottom
      );
    });
    const geometry = await target.evaluate((row) => {
      const viewport = document.querySelector('[data-reading-surface]').getBoundingClientRect();
      const nameplate = row.querySelector('[data-testid="cat-nameplate"]').getBoundingClientRect();
      const face = row.querySelector('[data-testid="cat-nameplate-avatar"]');
      const faceRect = face.getBoundingClientRect();
      const faceTopPoint = { x: faceRect.left + faceRect.width / 2, y: faceRect.top + 3 };
      const faceTopHit = document.elementFromPoint(faceTopPoint.x, faceTopPoint.y);
      return {
        height: row.getBoundingClientRect().height,
        viewportHeight: viewport.height,
        nameplateTop: nameplate.top - viewport.top,
        nameplateBottom: nameplate.bottom - viewport.top,
        faceTop: faceRect.top - viewport.top,
        faceTopPainted: face.contains(faceTopHit),
        faceTopHit: faceTopHit?.tagName,
      };
    });
    assert(geometry.height > geometry.viewportHeight);
    assert(geometry.nameplateTop >= 0 && geometry.nameplateBottom <= geometry.viewportHeight);
    assert.ok(geometry.faceTop >= 2, `the 2px face ring must stay inside the viewport: ${JSON.stringify(geometry)}`);
    assert.equal(
      geometry.faceTopPainted,
      true,
      `the top of the face must hit the face, not viewport chrome: ${JSON.stringify(geometry)}`,
    );
    await page.screenshot({ path: path.join(evidence, 'long-message-start-nameplate.png') });
    await fs.writeFile(path.join(evidence, 'long-message-geometry.json'), JSON.stringify(geometry, null, 2));
    await page.getByRole('button', { name: '回到刚才', exact: true }).click();
    await page.locator('[data-reading-trip-status="completed"]').waitFor();
    const returnedTop = await page.locator('[data-reading-surface]').evaluate((el) => el.scrollTop);
    assert(Math.abs(returnedTop - originTop) <= 1);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
test('actual shared results and reading owner keep origin through explicit message jump and settled return', async () => {
  const { page, errors, queries } = await open();
  try {
    assert.equal(queries[0].mode, 'hybrid');
    assert.equal(queries[0].threadId, 'recall-controlled');
    assert.equal(await page.locator('[data-message-search-result]').count(), 2);
    await page.locator('[data-message-search-result] [data-testid="cat-nameplate"]').first().waitFor();
    assert.equal(await page.locator('[data-message-search-result] [data-testid="cat-nameplate"]').count(), 2);
    assert.notEqual(
      await page.getByRole('dialog', { name: '查找消息' }).evaluate((el) => getComputedStyle(el).backgroundColor),
      'rgba(0, 0, 0, 0)',
      'proof must load the real opaque theme surface',
    );
    const saved = await page
      .locator('[data-reading-surface]')
      .evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
    assert(Math.abs(saved.top - saved.max) <= 1);
    await page.screenshot({ path: path.join(evidence, 'results-light.png') });
    await page.getByRole('button', { name: /跳过去.*第1处/ }).click();
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:recall-controlled')).state.messageAnchor?.messageId ===
        'old-0',
    );
    await page.getByRole('button', { name: '回到刚才' }).click();
    await page.locator('[data-reading-trip-status="completed"]').waitFor();
    const returned = await page
      .locator('[data-reading-surface]')
      .evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight, height: el.clientHeight }));
    await fs.writeFile(
      path.join(evidence, 'return-diagnostic.json'),
      JSON.stringify({ before: saved, returned }, null, 2),
    );
    console.log('return geometry', JSON.stringify({ before: saved, returned }));
    assert(Math.abs(returned.top - returned.max) <= 1, 'bottom ownership follows the new footer geometry');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('a cold origin returns exactly through two slow history pages after a real browser reload', async () => {
  const { page, errors, pages } = await open({ width: 1440, height: 900 }, false, true);
  try {
    await page.getByRole('button', { name: '关闭消息搜索', exact: true }).click();
    await page.locator('[data-reading-surface]').hover({ position: { x: 40, y: 600 } });
    await page.mouse.wheel(0, -1050);
    await page.waitForFunction(() => {
      const raw = localStorage.getItem('cat-cafe:thread-scroll:recall-controlled');
      const saved = raw ? JSON.parse(raw).state : null;
      return saved?.anchor === 'offset' && Number(saved.messageAnchor?.messageId?.slice(4)) < 8;
    });
    const before = await page.locator('[data-reading-surface]').evaluate((el) => ({
      top: el.scrollTop,
      saved: JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:recall-controlled')).state,
    }));
    await page.getByRole('button', { name: '查找消息', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索消息' }).fill('琴键');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page.getByRole('button', { name: /跳过去.*第1处/ }).click();
    await page.waitForURL('**/thread/remote-controlled');
    await page.locator('[data-reading-trip-status="ready"]').waitFor();
    await page.reload();
    await page.getByRole('button', { name: '回到刚才', exact: true }).click();
    await page.waitForURL('**/thread/recall-controlled');
    await page.locator('[data-reading-trip-status="completed"]').waitFor({ timeout: 15000 });
    const returned = await page.locator('[data-reading-surface]').evaluate((el) => ({
      top: el.scrollTop,
      saved: JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:recall-controlled')).state,
    }));
    assert.equal(pages.length, 2);
    assert(
      pages.every((page) => page.waitMs >= 1900),
      'the fixture must actually defer both pages; no reader wall deadline',
    );
    assert.deepEqual(returned.saved.messageAnchor, before.saved.messageAnchor);
    assert(Math.abs(returned.top - before.top) <= 1);
    await fs.writeFile(
      path.join(evidence, 'slow-paged-return.json'),
      JSON.stringify({ before, returned, pages }, null, 2),
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
test('global provenance, sorting and narrow dark layout keep real text and controls reachable', async () => {
  const { page, errors, queries } = await open({ width: 400, height: 900 }, true);
  try {
    await page.getByRole('button', { name: '全局', exact: true }).click();
    await page.getByRole('button', { name: '按相关', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-pressed="true"]') !== null);
    assert.equal(queries.at(-1).messageSort, 'relevance');
    assert.equal(queries.at(-1).threadId, undefined);
    await page.getByText('索引覆盖范围尚未确认。', { exact: false }).waitFor({ state: 'visible' });
    assert.equal(
      await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth),
      0,
    );
    await page.screenshot({ path: path.join(evidence, 'results-dark-400.png') });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('middle reading origin restores its signed message offset through the real Host controls', async () => {
  const { page, errors } = await open();
  try {
    await page.getByRole('button', { name: '关闭消息搜索', exact: true }).click();
    await page.locator('[data-reading-surface]').hover({ position: { x: 40, y: 600 } });
    await page.mouse.wheel(0, -720);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-reading-surface]');
      return el && el.scrollTop < el.scrollHeight - el.clientHeight - 100;
    });
    const before = await page.locator('[data-reading-surface]').evaluate((el) => ({
      top: el.scrollTop,
      saved: JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:recall-controlled')).state,
    }));
    assert.equal(before.saved.anchor, 'offset');
    await page.getByRole('button', { name: '查找消息', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索消息' }).fill('琴键');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page.getByRole('button', { name: /跳过去.*第1处/ }).click();
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:recall-controlled')).state.messageAnchor?.messageId ===
        'old-0',
    );
    await page.getByRole('button', { name: '回到刚才', exact: true }).click();
    await page.locator('[data-reading-trip-status="completed"]').waitFor();
    const returned = await page.locator('[data-reading-surface]').evaluate((el) => ({
      top: el.scrollTop,
      saved: JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:recall-controlled')).state,
    }));
    assert(Math.abs(returned.top - before.top) <= 1);
    assert.deepEqual(returned.saved.messageAnchor, before.saved.messageAnchor);
    await fs.writeFile(path.join(evidence, 'middle-return.json'), JSON.stringify({ before, returned }, null, 2));
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
