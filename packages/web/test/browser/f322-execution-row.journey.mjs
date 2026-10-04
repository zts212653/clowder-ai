import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

/**
 * F322 original-B COMPONENT PREVIEW journey — the one-row execution/queue surface in a real browser.
 *
 * Two kinds of page: the row on its own (a component preview, scenes below), and `?mount=1`, the footer as the app
 * mounts it (real ChatContainerHeader + ThreadExecutionLayer + ChatInput) in v2 and in classic. The REAL ExecutionRow,
 * ExecutionRowPanel, QueueEntryRow, CatAvatar, ForceResetDialog and the real stores run on a column the width of the
 * reading column, and every button is PRESSED here. Each API request is answered (or refused) inside the isolated
 * browser and recorded; no dev or runtime service, user account or Redis is used.
 *
 * Set EXECUTION_ROW_EVIDENCE_DIR to also write the screenshots and the measurement table the PR cites.
 */
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(webRoot, 'test/browser/fixtures');
const origin = 'https://f322-execution-row.test';
const evidenceDir = process.env.EXECUTION_ROW_EVIDENCE_DIR;
const THREAD = 'thread-row';
const measurements = [];
let browser, script, css;
const startedIn = process.cwd();

const cats = ['opus', 'codex', 'gemini'].map((id, n) => ({
  id,
  displayName: ['宪宪', '砚砚', '烁烁'][n],
  breedId: ['ragdoll', 'maine-coon', 'siamese'][n],
  avatar: `/avatars/${id}.png`,
  color: { primary: ['#9B7EBD', '#5B8C5A', '#5B9BD5'][n], secondary: '#eeeeee' },
  mentionPatterns: [`@${id}`],
  clientId: 'fixture',
  defaultModel: 'fixture',
}));

before(async () => {
  process.chdir(webRoot);
  const result = await build({
    root: webRoot,
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    resolve: {
      alias: [
        { find: 'next/navigation', replacement: path.join(fixtureRoot, 'f322-shell-navigation.ts') },
        { find: '@', replacement: path.join(webRoot, 'src') },
      ],
    },
    define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(fixtureRoot, 'f322-execution-row.tsx'),
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  });
  const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
  const entry = outputs.find((item) => item.type === 'chunk' && item.isEntry);
  assert.ok(entry);
  script = entry.code;
  css = outputs
    .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) => item.source)
    .join('\n');
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  process.chdir(startedIn);
  await browser?.close();
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(path.join(evidenceDir, 'measurements.json'), `${JSON.stringify(measurements, null, 2)}\n`);
  }
});

/**
 * Open one scene. `respond(request)` may return `{ status, body }` to answer an API call; anything else gets `{}`/200.
 * Every API call is recorded as `METHOD /path` (+ parsed body) in `calls`.
 */
async function open(
  scene,
  {
    respond = () => null,
    width = 800,
    allowConsole = [],
    shell = 'v2',
    mount = false,
    ready = '[data-testid="execution-row"]',
  } = {},
) {
  const page = await browser.newPage({ viewport: { width, height: 640 } });
  page.setDefaultTimeout(5_000);
  const errors = [];
  const unexpected = [];
  const calls = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    // The browser logs every non-2xx fetch; a refusal the test provokes on purpose is named in `allowConsole`.
    if (msg.type() === 'error' && !allowConsole.some((part) => msg.text().includes(part)))
      errors.push(`console: ${msg.text()}`);
  });
  await page.addInitScript((value) => localStorage.setItem('cat-cafe:shell-presentation', value), shell);
  await page.route('**/*', async (handler) => {
    const request = handler.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(request.url());
      return handler.abort();
    }
    if (url.pathname === '/proof.js') return handler.fulfill({ contentType: 'text/javascript', body: script });
    if (url.pathname === '/proof.css') return handler.fulfill({ contentType: 'text/css', body: css });
    if (url.pathname.startsWith('/avatars/')) {
      const file = path.join(webRoot, 'public', url.pathname);
      const fallback = path.join(webRoot, 'public/avatars/default.png');
      return handler.fulfill({ contentType: 'image/png', body: readFileSync(existsSync(file) ? file : fallback) });
    }
    if (url.pathname === '/api/cats')
      return handler.fulfill({ contentType: 'application/json', body: JSON.stringify({ cats }) });
    // Ambient answers the app asks for on boot; they are not part of what the row does, so they are not recorded.
    if (url.pathname === '/api/session')
      return handler.fulfill({ contentType: 'application/json', body: JSON.stringify({ userId: 'owner-1' }) });
    if (url.pathname === '/api/config/cat-order')
      return handler.fulfill({ contentType: 'application/json', body: JSON.stringify({ catOrder: [] }) });
    if (url.pathname === '/api/config/env') return handler.fulfill({ contentType: 'application/json', body: '{}' });
    if (url.pathname.startsWith('/api/')) {
      const raw = request.postData();
      const call = { key: `${request.method()} ${url.pathname}${url.search}`, body: raw ? JSON.parse(raw) : undefined };
      calls.push(call);
      const answer = respond(call) ?? { status: 200, body: {} };
      return handler.fulfill({
        status: answer.status,
        contentType: 'application/json',
        body: JSON.stringify(answer.body),
      });
    }
    return handler.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
    });
  });
  await page.goto(`${origin}/?s=${scene}${mount ? '&mount=1' : ''}`, { waitUntil: 'networkidle' });
  await page.waitForSelector(ready);
  // Avatars are real files; wait for them so the shots and the boxes are final.
  await page.evaluate(() =>
    Promise.all(Array.from(document.images).map((img) => (img.complete ? null : img.decode().catch(() => null)))),
  );
  return { page, errors, unexpected, calls };
}

const rowBox = (page) =>
  page
    .locator('[data-testid="execution-row"] > div')
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { y: r.y, h: r.height };
    });
const bodyTop = (page) => page.locator('[data-testid="chat-body"]').evaluate((el) => el.getBoundingClientRect().y);
const text = (page, id) => page.locator(`[data-testid="${id}"]`).first().textContent();
const toasts = (page) => page.evaluate(() => window.__row.toasts());

async function shot(page, name) {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`) });
}

function finish({ errors, unexpected }) {
  assert.deepEqual(errors, [], 'page errors');
  assert.deepEqual(unexpected, [], 'requests that left the isolated origin');
}

test('every state of the design renders its words in a fixed 36px row', async () => {
  const expected = {
    working: /^宪宪 正在工作 \d+:\d{2}$/,
    queue: /^宪宪 正在工作 \d+:\d{2} · 排队 2$/,
    several: /^3 件在跑 · 排队 5$/,
    silent: /^没有动静 \d+:\d{2}$/,
    stopping: /^正在停止 \d+:\d{2}$/,
    blocked: /^全量门禁 · 不是你发起的，你不能停 \d+:\d{2}$/,
    unverified: /^运行状态待确认$/,
    stuck: /^1 件处理卡住 · 排队 2$/,
    paused: /^排队已暂停 · 3 条$/,
  };
  for (const [scene, pattern] of Object.entries(expected)) {
    const session = await open(scene);
    const label = await text(session.page, 'execution-row-text');
    assert.match(label, pattern, scene);
    const box = await rowBox(session.page);
    assert.equal(box.h, 36, `${scene}: row height`);
    measurements.push({ scene, text: label, rowHeight: box.h });
    await shot(session.page, scene);
    finish(session);
    await session.page.close();
  }
});

test('■ stops the run through the same cancel request, then re-reads the executions', async () => {
  const session = await open('working');
  await session.page.click('[data-testid="execution-row-stop"] button');
  await session.page.waitForFunction(() => true);
  await expectCalls(session, [
    `POST /api/threads/${THREAD}/executions/live/exec-opus/cancel`,
    'GET /api/executions/active?projectPath=%2Fpreview',
  ]);
  assert.deepEqual(session.calls[0].body, { catId: 'opus' });
  finish(session);
  await session.page.close();
});

test('the panel floats over the chat: nothing moves, Esc and an outside press close it', async () => {
  const session = await open('queue');
  const before = { row: await rowBox(session.page), body: await bodyTop(session.page) };
  await session.page.click('[data-testid="execution-row-toggle"]');
  await session.page.waitForSelector('[data-testid="execution-row-panel"]');
  const during = { row: await rowBox(session.page), body: await bodyTop(session.page) };
  assert.deepEqual(during, before, 'row and chat body did not move');
  const position = await session.page
    .locator('[data-testid="execution-row-panel"]')
    .evaluate((el) => getComputedStyle(el).position);
  assert.equal(position, 'absolute');
  // The row sits right above the composer at the bottom, so the panel must open UPWARD from it and stay on screen.
  const geometry = await session.page.evaluate(() => {
    const panel = document.querySelector('[data-testid="execution-row-panel"]').getBoundingClientRect();
    const row = document.querySelector('[data-testid="execution-row"]').getBoundingClientRect();
    return { panelTop: panel.top, panelBottom: panel.bottom, rowTop: row.top, viewportHeight: window.innerHeight };
  });
  assert.ok(
    geometry.panelBottom <= geometry.rowTop + 1,
    `the panel opens upward from the row: ${JSON.stringify(geometry)}`,
  );
  assert.ok(geometry.panelTop >= 0, `the panel stays on screen: ${JSON.stringify(geometry)}`);
  measurements.push({ scene: 'queue-open', before, during, panelPosition: position, geometry });
  await shot(session.page, 'queue-open');
  await session.page.keyboard.press('Escape');
  assert.equal(await session.page.locator('[data-testid="execution-row-panel"]').count(), 0, 'Esc closes');
  await session.page.click('[data-testid="execution-row-toggle"]');
  await session.page.waitForSelector('[data-testid="execution-row-panel"]');
  // The panel covers the middle of the chat (that is the point of a float), so press outside it: the thread header.
  await session.page.click('[data-testid="thread-header"]');
  assert.equal(await session.page.locator('[data-testid="execution-row-panel"]').count(), 0, 'outside press closes');
  finish(session);
  await session.page.close();
});

test('several runs: one ■ per run in the panel, each stopping only its own run', async () => {
  const session = await open('several');
  assert.equal(await session.page.locator('[data-testid="execution-row-stop"]').count(), 0, 'no single ■ on the row');
  await session.page.click('[data-testid="execution-row-toggle"]');
  await session.page.waitForSelector('[data-testid="execution-row-panel"]');
  await shot(session.page, 'several-open');
  const runs = session.page.locator('[data-testid="execution-row-run"]');
  assert.equal(await runs.count(), 3);
  await runs.filter({ hasText: '砚砚' }).locator('button').click();
  await expectCalls(session, [
    `POST /api/threads/${THREAD}/executions/live/exec-codex/cancel`,
    'GET /api/executions/active?projectPath=%2Fpreview',
  ]);
  finish(session);
  await session.page.close();
});

test('a force-reset the server refuses is not reported as done; the dialog stays; a retry that works closes it', async () => {
  let answer = { status: 409, body: { error: 'PRESTART_STATE_CHANGED' } };
  const session = await open('silent', {
    respond: (call) => (call.key.endsWith('/force-reset') ? answer : null),
    allowConsole: ['status of 409'],
  });
  await session.page.click('[data-testid="execution-row-force-reset"]');
  await session.page.waitForSelector('[role="dialog"]');
  await shot(session.page, 'silent-reset-dialog');
  await session.page.click('[role="dialog"] button:text-is("强制重置")');
  await session.page.waitForFunction(() => window.__row.toasts().length > 0);
  assert.deepEqual(await toasts(session.page), [{ title: '恢复未成功', type: 'error' }]);
  assert.equal(await session.page.locator('[role="dialog"]').count(), 1, 'dialog stays open on a refusal');

  answer = { status: 200, body: { ok: true } };
  await session.page.click('[role="dialog"] button:text-is("强制重置")');
  await session.page.waitForFunction(() => window.__row.toasts().some((t) => t.title === '已重置'));
  assert.equal(await session.page.locator('[role="dialog"]').count(), 0, 'dialog closes on success');
  const resets = session.calls.filter((c) => c.key.endsWith('/force-reset'));
  assert.equal(resets.length, 2);
  finish(session);
  await session.page.close();
});

test('stuck message: the row offers 强制重置 only; 恢复 waits in the panel; dragging sends queued entries only', async () => {
  const session = await open('stuck');
  assert.equal(await session.page.locator('[data-testid="execution-row-resume"]').count(), 0, 'no 恢复 on the row');
  await session.page.click('[data-testid="execution-row-toggle"]');
  await session.page.waitForSelector('[data-testid="execution-row-panel"]');
  assert.equal(await text(session.page, 'execution-row-queue-resume'), '恢复');
  await shot(session.page, 'stuck-open');

  // A real pointer drag: pick up entry "b" by its handle and drop it on "a".
  const handles = session.page.locator('button[aria-label="Drag to reorder"]:not([disabled])');
  assert.equal(await handles.count(), 2, 'the stuck message has no live handle');
  const from = await handles.nth(1).boundingBox();
  const to = await handles.nth(0).boundingBox();
  await session.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await session.page.mouse.down();
  await session.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 12, { steps: 4 });
  await session.page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 - 6, { steps: 12 });
  await session.page.mouse.up();
  await session.page.waitForFunction(() => true);
  await expectCalls(session, [`PATCH /api/threads/${THREAD}/queue/reorder`]);
  assert.deepEqual(session.calls[0].body, {
    positions: [
      { entryId: 'b', position: 0 },
      { entryId: 'a', position: 1 },
    ],
  });
  finish(session);
  await session.page.close();
});

test('paused: 继续 on the row posts queue/next; the reason is kept', async () => {
  const session = await open('paused', {
    respond: (call) => (call.key.endsWith('/queue/next') ? { status: 200, body: { started: true } } : null),
  });
  assert.equal(
    await session.page.locator('[data-testid="execution-row-text"]').getAttribute('title'),
    '当前调用已取消',
  );
  await session.page.click('[data-testid="execution-row-resume"]');
  await expectCalls(session, [`POST /api/threads/${THREAD}/queue/next`]);
  await session.page.click('[data-testid="execution-row-toggle"]');
  await session.page.waitForSelector('[data-testid="execution-row-pause-reason"]');
  await shot(session.page, 'paused-open');
  finish(session);
  await session.page.close();
});

/**
 * The composer's stop buttons and mic: how many of each, and how many stops come BEFORE the mic in the document. (The
 * classic "replying… cancel" bar has a stop of its own, so classic has two; v2 has one and it is last.)
 */
const composerControls = (page) =>
  page.evaluate(() => {
    const stops = [...document.querySelectorAll('button[aria-label="Stop generation"]')];
    const mics = [...document.querySelectorAll('button[aria-label^="Start voice input"]')];
    const before = mics.length
      ? stops.filter((stop) => Boolean(stop.compareDocumentPosition(mics[0]) & Node.DOCUMENT_POSITION_FOLLOWING)).length
      : -1;
    return { stop: stops.length, mic: mics.length, stopsBeforeMic: before };
  });

/** Wait until a recorded call matches, or fail naming everything that was recorded. */
async function waitForCall(session, match) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (session.calls.some(match)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`no matching call; recorded: ${session.calls.map((c) => c.key).join(' | ')}`);
}

test('mounted, new shell, a cat running, empty draft: the one row and the title ⌄ replace the old layers; the stop is the last control', async () => {
  const session = await open('working', { mount: true });
  const { page } = session;
  assert.equal(await page.locator('[data-testid="execution-row"]').count(), 1, 'the one row');
  assert.equal(await page.locator('[data-testid="thread-title-menu-toggle"]').count(), 1, 'the title ⌄');
  assert.equal(await page.locator('[data-testid="active-invocation-banner"]').count(), 0, 'no "replying… cancel" bar');
  assert.equal(await page.getByText('执行中', { exact: true }).count(), 0, 'no old execution bar');
  assert.deepEqual(await composerControls(page), { stop: 1, mic: 1, stopsBeforeMic: 0 }, 'mic, then the stop last');
  // The row and its ■ sit in the composer card's column (same left edge and width), not across the whole pane.
  const columns = await page.evaluate(() => {
    const box = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { left: Math.round(r.left), width: Math.round(r.width) };
    };
    return { row: box('[data-testid="execution-row"]'), composer: box('[data-testid="chat-input-composer-row"]') };
  });
  assert.deepEqual(columns.row, columns.composer, `the row shares the composer's column: ${JSON.stringify(columns)}`);
  // The stop is a live control, not a faded one: it is enabled by the time the shot is taken.
  await page.waitForSelector('button[aria-label="Stop generation"]:not([disabled])');
  await shot(page, 'v2-mounted-empty');
  await page.click('button[aria-label="Stop generation"]');
  await waitForCall(session, (c) => c.key === `POST /api/threads/${THREAD}/executions/live/exec-opus/cancel`);
  assert.deepEqual(session.calls.find((c) => c.key.endsWith('/exec-opus/cancel')).body, { catId: 'opus' });
  finish(session);
  await page.close();
});

test('mounted, new shell, text in the draft: the composer has no stop; queue-send is there; the row still stops the run', async () => {
  const session = await open('working', { mount: true });
  const { page } = session;
  await page.fill('textarea', '下一件工作：看一下这个');
  await page.waitForSelector('button[aria-label="排队发送"]');
  assert.equal(await page.locator('button[aria-label="Stop generation"]').count(), 0, 'no composer stop with text');
  await shot(page, 'v2-mounted-typed');
  await page.click('[data-testid="execution-row-stop"] button');
  await waitForCall(session, (c) => c.key === `POST /api/threads/${THREAD}/executions/live/exec-opus/cancel`);
  finish(session);
  await page.close();
});

test('mounted, new shell: the title ⌄ holds the normal force-reset — the same dialog, a refusal is not done, a retry is', async () => {
  let answer = { status: 409, body: { error: 'PRESTART_STATE_CHANGED' } };
  const session = await open('working', {
    mount: true,
    respond: (call) => (call.key.endsWith('/force-reset') ? answer : null),
    allowConsole: ['status of 409'],
  });
  const { page } = session;
  await page.click('[data-testid="thread-title-menu-toggle"]');
  await page.waitForSelector('[data-testid="thread-title-menu"]');
  await shot(page, 'v2-title-menu');
  await page.click('[data-testid="thread-title-menu-force-reset"]');
  await page.waitForSelector('[role="dialog"]');
  await page.click('[role="dialog"] button:text-is("强制重置")');
  await page.waitForFunction(() => window.__row.toasts().length > 0);
  assert.deepEqual(await toasts(page), [{ title: '恢复未成功', type: 'error' }]);
  assert.equal(await page.locator('[role="dialog"]').count(), 1, 'dialog stays on a refusal');
  answer = { status: 200, body: { ok: true } };
  await page.click('[role="dialog"] button:text-is("强制重置")');
  await page.waitForFunction(() => window.__row.toasts().some((t) => t.title === '已重置'));
  assert.equal(await page.locator('[role="dialog"]').count(), 0, 'dialog closes on success');
  assert.equal(session.calls.filter((c) => c.key.endsWith('/force-reset')).length, 2);
  finish(session);
  await page.close();
});

test('mounted, classic shell, the same cat running: nothing moved — the old bar, the old "replying… cancel" bar, the stop first, no row, no ⌄', async () => {
  const session = await open('working', { mount: true, shell: 'classic', ready: '[data-testid="chat-body"]' });
  const { page } = session;
  await page.getByText('执行中', { exact: true }).first().waitFor();
  await page.waitForSelector('[data-testid="active-invocation-banner"]');
  assert.equal(await page.locator('[data-testid="execution-row"]').count(), 0, 'no new row in classic');
  assert.equal(await page.locator('[data-testid="thread-title-menu-toggle"]').count(), 0, 'no ⌄ in classic');
  assert.deepEqual(
    await composerControls(page),
    { stop: 2, mic: 1, stopsBeforeMic: 2 },
    "classic: the bar's stop and the side stop both stay before the mic, as before",
  );
  await page.waitForSelector('button[aria-label="Stop generation"]:not([disabled])');
  await shot(page, 'classic-mounted');
  finish(session);
  await page.close();
});

/** Wait until the recorded API calls equal `keys` (order-sensitive), or fail with what was recorded. */
async function expectCalls(session, keys) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (session.calls.length >= keys.length) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(
    session.calls.map((c) => c.key),
    keys,
  );
}
