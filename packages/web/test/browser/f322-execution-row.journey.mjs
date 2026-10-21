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

const dispositionSnapshot = (thread = null) => ({
  productDefault: 'next_work',
  global: null,
  thread,
  effective: thread ?? 'next_work',
  source: thread ? 'thread' : 'product',
  onboardingSeen: true,
});

const cats = [
  ...['opus', 'codex', 'gemini'].map((id, n) => ({
    id,
    displayName: ['宪宪', '砚砚', '烁烁'][n],
    nickname: ['宪宪', '砚砚', '烁烁'][n],
    ...(id === 'opus' ? { variantLabel: 'Opus 5.5' } : {}),
    breedId: ['ragdoll', 'maine-coon', 'siamese'][n],
    avatar: `/avatars/${id}.png`,
    color: { primary: ['#9B7EBD', '#5B8C5A', '#5B9BD5'][n], secondary: '#eeeeee' },
    mentionPatterns: [`@${id}`, `@${['宪宪', '砚砚', '烁烁'][n]}`],
    carrier: 'cli',
    clientId: 'fixture',
    defaultModel: 'fixture',
  })),
  {
    id: 'sonnet',
    displayName: '宪宪',
    nickname: '宪宪',
    variantLabel: 'Sonnet 5.5',
    breedId: 'ragdoll',
    avatar: '/avatars/sonnet.png',
    color: { primary: '#7C3AED', secondary: '#eeeeee' },
    mentionPatterns: ['@sonnet', '@宪宪'],
    carrier: 'cli',
    clientId: 'fixture',
    defaultModel: 'fixture',
  },
];

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
    catalog = cats,
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
      return handler.fulfill({ contentType: 'application/json', body: JSON.stringify({ cats: catalog }) });
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

test('unavailable recipient explanation stays visible in the actual desktop and mobile composer', async () => {
  for (const width of [1100, 390]) {
    const session = await open('working', {
      mount: true,
      width,
      respond: (call) =>
        call.key === 'POST /api/routing/preview'
          ? {
              status: 200,
              body: { targetCats: ['codex'], reason: { kind: 'recent_replier' }, unavailableTargets: ['opus'] },
            }
          : null,
    });
    const { page } = session;
    try {
      const notice = page.locator('[data-testid="composer-routing-root"] output');
      await notice.waitFor({ state: 'visible' });
      assert.equal(await notice.innerText(), '宪宪 · Opus 5.5暂时不能用，改发给砚砚');
      const geometry = await notice.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          bottom: box.bottom,
          height: box.height,
          viewport: innerWidth,
          pageWidth: document.documentElement.scrollWidth,
          viewportHeight: innerHeight,
        };
      });
      assert.ok(geometry.left >= 0 && geometry.right <= width, JSON.stringify(geometry));
      assert.ok(geometry.height > 0 && geometry.bottom <= geometry.viewportHeight, JSON.stringify(geometry));
      assert.ok(geometry.pageWidth <= width, JSON.stringify(geometry));
      assert.match(await page.getByTestId('composer-routing-preview').getAttribute('aria-label'), /改发给砚砚/);
      await page.getByTestId('composer-routing-preview').click();
      await page.getByRole('dialog').waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await shot(page, `unavailable-recipient-${width}`);
      measurements.push({ scene: 'unavailable-recipient', width, ...geometry });
      finish(session);
    } finally {
      await page.close();
    }
  }
});

test('every state of the design renders its words in a fixed 36px row', async () => {
  const expected = {
    working: /^宪宪 · Opus 5\.5 处理中 \d+:\d{2}$/,
    queue: /^宪宪 · Opus 5\.5 处理中 \d+:\d{2} · 排队 2$/,
    several: /^3 项运行中 · 排队 5$/,
    silent: /^没有动静 \d+:\d{2}$/,
    stopping: /^正在停止 \d+:\d{2}$/,
    blocked: /^全量门禁 · 不是你发起的，你不能停 \d+:\d{2}$/,
    confirming: /^正在确认运行状态…$/,
    unverified: /^运行状态待确认$/,
    stuck: /^1 项处理受阻 · 排队 2$/,
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
    'GET /api/executions/active?scope=all',
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
  await runs
    .filter({ hasText: '砚砚' })
    .getByRole('button', { name: 'Stop codex live_invocation exec-codex', exact: true })
    .click();
  await expectCalls(session, [
    `POST /api/threads/${THREAD}/executions/live/exec-codex/cancel`,
    'GET /api/executions/active?scope=all',
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
    const stops = [...document.querySelectorAll('button[aria-label="Stop generation"], button[aria-label="停止生成"]')];
    const mics = [
      ...document.querySelectorAll('button[aria-label^="Start voice input"], button[aria-label="语音输入"]'),
    ];
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
  await page.focus('textarea');
  await page.waitForSelector('button[aria-label="语音输入"]');
  await page.waitForSelector('button[aria-label="停止生成"]');
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
  await page.waitForSelector('button[aria-label="停止生成"]:not([disabled])');
  await shot(page, 'v2-mounted-empty');
  await page.click('button[aria-label="停止生成"]');
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
  assert.equal(
    await page.locator('button[aria-label="Stop generation"], button[aria-label="停止生成"]').count(),
    0,
    'no composer stop with text',
  );
  await shot(page, 'v2-mounted-typed');
  await page.click('[data-testid="execution-row-stop"] button');
  await waitForCall(session, (c) => c.key === `POST /api/threads/${THREAD}/executions/live/exec-opus/cancel`);
  finish(session);
  await page.close();
});

test('mounted, new shell: recipient preview follows visible @ text and preferred cat lives only in +', async () => {
  const snapshotNow = Date.now();
  let preferredCats = ['opus'];
  const session = await open('working', {
    mount: true,
    respond: (call) => {
      if (call.key === `GET /api/config/conversation-view?threadId=${THREAD}`) {
        return { status: 200, body: { stored: null, effective: { mode: 'group' }, source: 'product' } };
      }
      if (call.key === 'POST /api/routing/preview') {
        const explicit = call.body.content.startsWith('@砚砚 ');
        return {
          status: 200,
          body: {
            targetCats: [explicit ? 'codex' : 'opus'],
            reason: { kind: explicit ? 'current_message_mentions' : 'recent_replier' },
          },
        };
      }
      if (call.key === `PATCH /api/threads/${THREAD}`) {
        preferredCats = [...call.body.preferredCats];
        return { status: 200, body: { id: THREAD, preferredCats } };
      }
      if (call.key === 'GET /api/threads?view=sidebar') {
        return {
          status: 200,
          body: {
            threads: [
              {
                id: THREAD,
                title: 'preview',
                projectPath: '/preview',
                preferredCats,
                participants: ['opus'],
                labels: [],
                createdBy: 'owner-1',
                createdAt: snapshotNow - 300_000,
                lastActiveAt: snapshotNow,
                pinned: false,
                favorited: false,
              },
            ],
          },
        };
      }
      return null;
    },
  });
  const { page } = session;
  await waitForCall(session, (call) => call.key === 'POST /api/routing/preview');
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="composer-routing-preview"]')?.textContent?.includes('宪宪'),
  );
  assert.match(
    (await page.locator('[data-testid="composer-routing-preview"]').getAttribute('aria-label')) ?? '',
    /宪宪 · Opus 5\.5最近回过你/,
  );

  await page.click('[data-testid="composer-routing-preview"]');
  await page.click('[data-testid="composer-recipient-codex"]');
  await page.waitForFunction(() => document.querySelector('textarea')?.value === '@砚砚 ');
  await waitForCall(session, (call) => call.key === 'POST /api/routing/preview' && call.body.content === '@砚砚 ');
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="composer-routing-preview"]')?.textContent?.includes('砚砚'),
  );
  assert.match(
    (await page.locator('[data-testid="composer-routing-preview"]').getAttribute('aria-label')) ?? '',
    /这条里 @ 了砚砚/,
  );

  const routingCallCount = () => session.calls.filter((call) => call.key === 'POST /api/routing/preview').length;
  const beforeTyping = routingCallCount();
  await page.fill('textarea', '@砚砚 a');
  assert.match(
    (await page.locator('[data-testid="composer-routing-preview"]').textContent()) ?? '',
    /砚砚/,
    'ordinary typing keeps the last resolved recipient instead of flashing Checking',
  );
  await waitForCall(session, () => routingCallCount() === beforeTyping + 1);

  await page.dispatchEvent('textarea', 'compositionstart');
  await page.fill('textarea', '@砚砚 ab');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(routingCallCount(), beforeTyping + 1, 'IME composition does not refresh routing');
  assert.match(
    (await page.locator('[data-testid="composer-routing-preview"]').textContent()) ?? '',
    /砚砚/,
    'IME composition keeps the resolved recipient and avatar stable',
  );
  await page.dispatchEvent('textarea', 'compositionend');
  await waitForCall(session, () => routingCallCount() === beforeTyping + 2);

  await page.click('button[aria-controls="composer-add-menu"]');
  await page.waitForSelector('[data-testid="composer-preferred-cat-section"]');
  assert.match(await text(page, 'composer-preferred-cat-section'), /这条对话 · 没 @ 时先找谁/);
  assert.match(await text(page, 'composer-preferred-cat-section'), /只在还没有猫回过话时用上/);
  await page.click('[data-testid="composer-preferred-cat-toggle"]');
  await page.click('[data-testid="composer-preferred-cat-codex"]');
  await waitForCall(session, (call) => call.key === `PATCH /api/threads/${THREAD}`);
  assert.deepEqual(session.calls.find((call) => call.key === `PATCH /api/threads/${THREAD}`).body, {
    preferredCats: ['opus', 'codex'],
  });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="composer-preferred-cat-toggle"]')?.textContent === '首选猫 · 2',
  );
  assert.equal(await page.locator('[data-testid="composer-preferred-cat-toggle"]').textContent(), '首选猫 · 2');
  assert.equal(await page.locator('[data-testid="composer-preferred-cat-opus"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-testid="composer-preferred-cat-codex"]').getAttribute('aria-pressed'), 'true');
  await page.click('[data-testid="composer-preferred-cat-gemini"]');
  await waitForCall(
    session,
    () => session.calls.filter((call) => call.key === `PATCH /api/threads/${THREAD}`).length === 2,
  );
  const preferredCatWrites = session.calls.filter((call) => call.key === `PATCH /api/threads/${THREAD}`);
  assert.deepEqual(preferredCatWrites[1].body, { preferredCats: ['opus', 'codex', 'gemini'] });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="composer-preferred-cat-toggle"]')?.textContent === '首选猫 · 3',
  );
  assert.equal(await page.locator('[data-testid="composer-preferred-cat-toggle"]').textContent(), '首选猫 · 3');
  assert.equal(
    await page.locator('[data-testid="composer-preferred-cat-gemini"]').getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(
    await page.locator('[data-testid="thread-cat-pill"]').count(),
    0,
    'composer has no old preferred-cat pill',
  );
  await shot(page, 'v2-recipient-preview');
  if (evidenceDir) {
    writeFileSync(
      path.join(evidenceDir, 'v2-recipient-preview-requests.json'),
      `${JSON.stringify(session.calls, null, 2)}\n`,
    );
  }
  finish(session);
  await page.close();
});

test('the complete multi-recipient identity is measured and hidden atomically when it does not fit', async () => {
  for (const width of [900, 462]) {
    const session = await open('working', {
      mount: true,
      width,
      respond: (call) => {
        if (call.key === `GET /api/config/conversation-view?threadId=${THREAD}`) {
          return { status: 200, body: { stored: null, effective: { mode: 'group' }, source: 'product' } };
        }
        if (call.key === 'POST /api/routing/preview') {
          return {
            status: 200,
            body: { targetCats: ['opus', 'sonnet'], reason: { kind: 'current_message_mentions' } },
          };
        }
        return null;
      },
    });
    await waitForCall(session, (call) => call.key === 'POST /api/routing/preview');
    await session.page.waitForFunction(() =>
      document
        .querySelector('[data-testid="composer-routing-preview"]')
        ?.getAttribute('aria-label')
        ?.includes('Sonnet 5.5'),
    );

    const identity = await session.page.evaluate(() => {
      const name = document.querySelector('[data-testid="composer-routing-name"]');
      const style = name ? getComputedStyle(name) : null;
      return {
        available: name?.clientWidth ?? 0,
        required: name?.scrollWidth ?? 0,
        visible: style?.display !== 'none' && style?.visibility !== 'hidden',
        aria: document.querySelector('[data-testid="composer-routing-preview"]')?.getAttribute('aria-label') ?? '',
        avatarCount: document.querySelectorAll('[data-testid="composer-routing-preview"] img').length,
      };
    });
    assert.ok(identity.required > identity.available, `${width}px: fixture must exercise an overflowing full identity`);
    assert.equal(identity.visible, false, `${width}px: the full identity is hidden instead of clipped`);
    assert.match(identity.aria, /宪宪 · Opus 5\.5、宪宪 · Sonnet 5\.5/);
    assert.equal(identity.avatarCount, 2, `${width}px: avatars still identify the recipients`);

    await session.page.hover('[data-testid="composer-routing-preview"]');
    const tooltip = session.page.locator('[data-testid="app-tooltip"]');
    await tooltip.waitFor();
    assert.match((await tooltip.textContent()) ?? '', /宪宪 · Opus 5\.5、宪宪 · Sonnet 5\.5/);
    await shot(session.page, `multiple-recipient-${width}`);
    finish(session);
    await session.page.close();
  }
});

test('the recipient menu disables a catalog entry that has no unique registered mention', async () => {
  const ambiguousCatalog = cats
    .filter((cat) => cat.id === 'opus' || cat.id === 'sonnet')
    .map((cat) => ({ ...cat, mentionPatterns: ['@宪宪'] }));
  const session = await open('working', {
    mount: true,
    catalog: ambiguousCatalog,
    respond: (call) => {
      if (call.key === `GET /api/config/conversation-view?threadId=${THREAD}`) {
        return { status: 200, body: { stored: null, effective: { mode: 'group' }, source: 'product' } };
      }
      if (call.key === 'POST /api/routing/preview') {
        return { status: 200, body: { targetCats: ['opus'], reason: { kind: 'recent_replier' } } };
      }
      return null;
    },
  });
  await waitForCall(session, (call) => call.key === 'POST /api/routing/preview');
  await session.page.click('[data-testid="composer-routing-preview"]');

  const opus = session.page.locator('[data-testid="composer-recipient-opus"]');
  assert.equal(await opus.isDisabled(), true);
  assert.match((await opus.textContent()) ?? '', /没有唯一 @ 名称/);
  await opus.evaluate((button) => button.click());
  assert.equal(await session.page.locator('textarea').inputValue(), '', 'a disabled row cannot insert a guessed token');
  await shot(session.page, 'recipient-no-unique-mention');
  finish(session);
  await session.page.close();
});

test('a 430px chat column keeps one useful status, icon actions, and no partial recipient name', async () => {
  for (const [scene, compact, action] of [
    ['working', '在工作', 'stop'],
    ['paused', '已暂停', 'resume'],
    ['silent', '没动静', 'force-reset'],
  ]) {
    const session = await open(scene, { width: 462 });
    const layout = await session.page.evaluate((actionName) => {
      const full = document.querySelector('[data-testid="execution-row-text"]');
      const compactNode = document.querySelector('[data-testid="execution-row-text-compact"]');
      const label = document.querySelector(`[data-testid="execution-row-${actionName}-label"]`);
      const icon = document.querySelector(`[data-testid="execution-row-${actionName}-icon"]`);
      const surface = document.querySelector('[data-testid="execution-row-surface"]');
      return {
        fullDisplay: getComputedStyle(full).display,
        compactDisplay: getComputedStyle(compactNode).display,
        compactText: compactNode.textContent.trim(),
        actionLabelDisplay: getComputedStyle(label).display,
        actionIconDisplay: getComputedStyle(icon).display,
        noOverflow: surface.scrollWidth <= surface.clientWidth,
      };
    }, action);
    assert.equal(layout.fullDisplay, 'none', `${scene}: long status yields first`);
    assert.notEqual(layout.compactDisplay, 'none', `${scene}: compact status stays visible`);
    assert.equal(layout.compactText, compact, `${scene}: compact status still explains the state`);
    assert.equal(layout.actionLabelDisplay, 'none', `${scene}: action words yield before status`);
    assert.notEqual(layout.actionIconDisplay, 'none', `${scene}: action remains reachable as an icon`);
    assert.equal(layout.noOverflow, true, `${scene}: row stays inside the narrow column`);
    await shot(session.page, `narrow-${scene}`);
    finish(session);
    await session.page.close();
  }

  const recipient = await open('working', {
    mount: true,
    width: 462,
    respond: (call) => {
      if (call.key === `GET /api/config/conversation-view?threadId=${THREAD}`) {
        return { status: 200, body: { stored: null, effective: { mode: 'group' }, source: 'product' } };
      }
      if (call.key === 'POST /api/routing/preview') {
        return { status: 200, body: { targetCats: ['opus'], reason: { kind: 'recent_replier' } } };
      }
      return null;
    },
  });
  await waitForCall(recipient, (call) => call.key === 'POST /api/routing/preview');
  await recipient.page.waitForFunction(() =>
    document
      .querySelector('[data-testid="composer-routing-preview"]')
      ?.getAttribute('aria-label')
      ?.includes('Opus 5.5'),
  );
  const recipientLayout = await recipient.page.evaluate(() => {
    const name = document.querySelector('[data-testid="composer-routing-name"]');
    const trigger = document.querySelector('[data-testid="composer-routing-preview"]');
    const context = document.querySelector('[data-testid="chat-composer-context"]');
    const composer = document.querySelector('[data-testid="chat-input-composer-row"]');
    const nameBox = name?.getBoundingClientRect();
    const triggerBox = trigger?.getBoundingClientRect();
    return {
      nameDisplay: name ? getComputedStyle(name).display : null,
      nameVisibility: name ? getComputedStyle(name).visibility : null,
      nameText: name?.textContent?.trim() ?? '',
      nameFits:
        Boolean(name && nameBox && triggerBox) &&
        name.scrollWidth <= name.clientWidth &&
        nameBox.left >= triggerBox.left &&
        nameBox.right <= triggerBox.right,
      triggerNoOverflow: trigger ? trigger.scrollWidth <= trigger.clientWidth : false,
      contextNoOverflow: context ? context.scrollWidth <= context.clientWidth : false,
      composerNoOverflow: composer ? composer.scrollWidth <= composer.clientWidth : false,
    };
  });
  assert.equal(recipientLayout.nameText, '宪宪 · Opus 5.5', 'recipient keeps the canonical whole label');
  assert.equal(
    recipientLayout.nameDisplay === 'none' || recipientLayout.nameVisibility === 'hidden' || recipientLayout.nameFits,
    true,
    'recipient name is either wholly visible or wholly absent',
  );
  assert.equal(recipientLayout.triggerNoOverflow, true, 'recipient control stays inside its own box');
  assert.equal(recipientLayout.contextNoOverflow, true, 'project and recipient controls stay inside the context row');
  assert.equal(recipientLayout.composerNoOverflow, true, 'the complete composer stays inside the narrow chat column');
  await shot(recipient.page, 'narrow-recipient');
  finish(recipient);
  await recipient.page.close();
});

test('mounted, new shell: send mode lives first in +, saves for this conversation, and the row keeps its visual status cues', async () => {
  let savedDisposition = null;
  const session = await open('working', {
    mount: true,
    respond: (call) => {
      if (call.key === `GET /api/config/message-disposition?threadId=${THREAD}`) {
        return { status: 200, body: dispositionSnapshot(savedDisposition) };
      }
      if (call.key === 'PUT /api/config/message-disposition') {
        savedDisposition = call.body.disposition;
        return { status: 200, body: dispositionSnapshot(savedDisposition) };
      }
      return null;
    },
  });
  const { page } = session;

  await page.waitForSelector('textarea[placeholder="继续输入，成为下一件工作…"]');
  assert.equal(
    await page.locator('[data-testid="message-disposition-selector"]').count(),
    0,
    'v2 has no standalone chip',
  );

  const rowPresentation = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="execution-row"]');
    const surface = document.querySelector('[data-testid="execution-row-surface"]');
    const dot = document.querySelector('[data-testid="execution-row-dot"]');
    const composer = document.querySelector('[data-testid="chat-input-composer-row"]');
    return {
      tone: row?.getAttribute('data-tone'),
      surface: surface ? getComputedStyle(surface).backgroundColor : null,
      composer: composer ? getComputedStyle(composer).backgroundColor : null,
      dot: dot ? getComputedStyle(dot).backgroundColor : null,
      avatars: document.querySelectorAll('[data-testid="execution-row-avatars"] img').length,
      action: document.querySelector('[data-testid="execution-row-stop"]')?.textContent?.trim(),
    };
  });
  assert.equal(rowPresentation.tone, 'info');
  assert.notEqual(rowPresentation.surface, 'rgba(0, 0, 0, 0)', 'status surface is visibly tinted');
  assert.notEqual(rowPresentation.surface, rowPresentation.composer, 'status surface differs from the composer paper');
  assert.notEqual(rowPresentation.dot, 'rgba(0, 0, 0, 0)', 'status dot is visible');
  assert.equal(rowPresentation.avatars, 1, 'the working cat stays visible');
  assert.match(rowPresentation.action ?? '', /停止/, 'the live action stays visible');

  await page.click('button[aria-controls="composer-add-menu"]');
  await page.waitForSelector('[data-testid="message-disposition-menu-section"]');
  const sectionComesFirst = await page.evaluate(() => {
    const section = document.querySelector('[data-testid="message-disposition-menu-section"]');
    const context = document.querySelector('[data-testid="composer-add-context"]');
    return Boolean(section && context && section.compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  assert.equal(sectionComesFirst, true, 'send mode is the first + menu section');
  assert.match(await text(page, 'message-disposition-menu-section'), /这条发出去后/);
  await shot(page, 'v2-send-mode-menu');

  await page.click('[data-disposition-option="continue_current"]');
  await waitForCall(session, (call) => call.key === 'PUT /api/config/message-disposition');
  const write = session.calls.find((call) => call.key === 'PUT /api/config/message-disposition');
  assert.deepEqual(write.body, { scope: 'thread', threadId: THREAD, disposition: 'continue_current' });
  await page.waitForSelector('textarea[placeholder="接着当前工作补充…"]');
  assert.equal(await page.locator('[data-testid="composer-add-menu"]').count(), 0, 'a saved choice closes the menu');

  measurements.push({ scene: 'v2-send-mode-menu', rowPresentation, write: write.body });
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
  assert.equal(
    await page.locator('[data-testid="message-disposition-selector"]').count(),
    1,
    'classic keeps its old chip',
  );
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
