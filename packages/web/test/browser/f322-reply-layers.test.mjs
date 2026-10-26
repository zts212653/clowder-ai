import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { runMessageBundleNextJourney } from './f294-message-bundle-next.mjs';
import { runActionOwnerNextJourney } from './f322-action-owner-next.mjs';
import { runCatProfileCardJourney } from './f322-cat-profile-card.journey.mjs';
import { registerCrossThreadLetterJourneys } from './f322-cross-thread-letter.journey.mjs';
import { runNativeReplyNextJourney } from './f322-native-reply-next.mjs';
import { runNarrowUserActionJourney } from './f322-native-reply-reading.mjs';
import { runNativeReplyMotionJourney } from './f322-reply-motion.journey.mjs';
import { runSubexecutionNextJourney } from './f322-subexecution-next.mjs';
import { runThreadSettingsJourney } from './f322-thread-settings.journey.mjs';
import { contrast, measureReply } from './fixtures/f322-reply-layers-metrics.mjs';

/**
 * F322 B §1.16 probe — a cat's reply in three layers (new shell) in a real browser.
 *
 * The REAL ChatMessage / ReplyLayers / MessageViewportBoundary / CatNameplate and the real theme pipeline, one reply per state the
 * design names, on a column the width of the reading column (720) and of the Studio chat bar (400). Every request is answered
 * inside the isolated browser; no dev or runtime service, user account or Redis is used.
 *
 * Set REPLY_LAYERS_EVIDENCE_DIR to also write the screenshots and the measurement table the PR cites.
 */
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(webRoot, 'test/browser/fixtures');
const origin = 'https://f322-reply-layers.test';
const evidenceDir = process.env.REPLY_LAYERS_EVIDENCE_DIR;
const measurements = [];

test(
  'conversation settings: header and sidebar share one drawer with linked Feature editing',
  { timeout: 300000 },
  async () => {
    await runThreadSettingsJourney(browser, process.env.THREAD_SETTINGS_EVIDENCE_DIR ?? evidenceDir);
  },
);

test(
  'native cat card: avatar, original image, caret mention, cat view, settings and mobile sheet',
  { timeout: 300000 },
  async () => {
    await runCatProfileCardJourney(browser, process.env.CAT_CARD_EVIDENCE_DIR ?? evidenceDir);
  },
);
let browser, script, css;
const startedIn = process.cwd();

const cats = [
  ['opus', '布偶猫', '#9B7EBD', 'ragdoll'],
  ['codex', '缅因猫', '#5B8C5A', 'maine-coon'],
  ['gemini', '暹罗猫', '#5B9BD5', 'siamese'],
  ['glm52', '狸花猫', '#D4A76A', 'dragon-li'],
].map(([id, displayName, primary, breedId]) => ({
  id,
  displayName,
  breedId,
  avatar: `/avatars/${id}.png`,
  color: { primary, secondary: '#eeeeee' },
  mentionPatterns: [`@${id}`],
  carrier: 'cli',
  clientId: 'fixture',
  defaultModel: 'fixture',
}));

before(async () => {
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
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
        input: path.join(fixtureRoot, 'f322-reply-layers.tsx'),
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

function fixtureAssetResponse(url) {
  if (url.pathname === '/proof.js') return { contentType: 'text/javascript', body: script };
  if (url.pathname === '/proof.css') return { contentType: 'text/css', body: css };
  if (!url.pathname.startsWith('/avatars/')) return null;
  const file = path.join(webRoot, 'public', url.pathname);
  const served = existsSync(file) ? file : path.join(webRoot, 'public/avatars/default.png');
  return { contentType: 'image/png', body: readFileSync(served) };
}

function fixtureApiResponse(pathname) {
  // These fixture replies have no additional inputs during generation (#5614).
  if (/^\/api\/threads\/thread-replies\/messages\/[^/]+\/generation-messages$/.test(pathname)) {
    return { messageIds: [], hasAppendedInputs: false, complete: true };
  }
  switch (pathname) {
    case '/api/message-bundles/c-bundle':
      return {
        messageBundleId: 'c-bundle',
        targetThreadId: 'thread-replies',
        createdBy: 'owner-1',
        createdAt: 1791210000000,
        note: 'The forwarder owns this note, above the paper.',
        sourceThread: { id: 'c-original', title: 'Canonical source conversation' },
        items: [
          { status: 'tombstone', messageId: 'first', reason: 'source_unavailable' },
          ...['second', 'third'].map((id) => ({
            status: 'available',
            kind: 'message',
            messageId: id,
            sourceThreadId: 'c-original',
            from: { kind: 'agent', catId: 'opus' },
            timestamp: 1791210000000,
            readableContent: `${id.toUpperCase()} authorized source`,
          })),
        ],
      };
    case '/api/session':
      return { userId: 'owner-1' };
    case '/api/cats':
      return { cats };
    case '/api/config/env':
      return {};
    case '/api/config/env-summary':
      return { variables: [] };
    case '/api/config/cat-order':
      return { catOrder: [] };
    default:
      return null;
  }
}

async function serveFixtureRequest(handler, unexpected) {
  const request = handler.request();
  const url = new URL(request.url());
  if (url.origin !== origin) {
    unexpected.push(request.url());
    return handler.abort();
  }
  const asset = fixtureAssetResponse(url);
  if (asset) return handler.fulfill(asset);
  const api = fixtureApiResponse(url.pathname);
  if (api) return handler.fulfill({ contentType: 'application/json', body: JSON.stringify(api) });
  if (url.pathname.startsWith('/api/')) {
    unexpected.push(request.url());
    return handler.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  }
  return handler.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
  });
}

async function open({
  width = 720,
  base = 'light',
  viewportWidth = Math.max(width + 40, 480),
  longSource = false,
  replyCopy = false,
  presentation = 'v2',
  activity = false,
  failureVisibility = false,
} = {}) {
  const page = await browser.newPage({
    viewport: { width: viewportWidth, height: 1500 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(5_000);
  const errors = [];
  const unexpected = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  await page.addInitScript((value) => localStorage.setItem('cat-cafe:shell-presentation', value), presentation);
  await page.route('**/*', (handler) => serveFixtureRequest(handler, unexpected));
  await page.goto(
    `${origin}/?w=${width}${longSource ? '&longSource=1' : ''}${replyCopy ? '&replyCopy=1' : ''}${activity ? '&activity=1' : ''}${failureVisibility ? '&failureVisibility=1' : ''}`,
    {
      waitUntil: 'networkidle',
    },
  );
  await page.waitForSelector('[data-message-id="r-done"] img');
  await page.waitForSelector('#f056-dynamic-cat-tokens', { state: 'attached' });
  await page.evaluate((b) => window.__replies.applyTheme(b), base);
  await page.evaluate(() => window.__replies.applied());
  await page.evaluate(() =>
    Promise.all(Array.from(document.images).map((img) => (img.complete ? null : img.decode().catch(() => null)))),
  );
  return { page, errors, unexpected };
}

const measure = (page, id) => page.evaluate(measureReply(), id);

test('Activity hover and focus preserve containment, geometry and record disclosure', async () => {
  const { page, errors, unexpected } = await open({ width: 720, viewportWidth: 1440 });
  try {
    const row = page.locator('[data-message-id="r-done"]');
    const boundary = row.locator('xpath=ancestor::*[@data-message-viewport-boundary][1]');
    const toggle = row.getByTestId('reply-record-toggle');
    await toggle.scrollIntoViewIfNeeded();
    const before = await boundary.boundingBox();
    const box = await toggle.boundingBox();
    for (const offset of [-4, 4, box.height - 1, box.height + 4]) {
      await page.mouse.move(box.x + 12, box.y + offset);
      await page.waitForTimeout(30);
      assert.equal(await boundary.evaluate((el) => getComputedStyle(el).contentVisibility), 'auto');
      const after = await boundary.boundingBox();
      assert.equal(after.y, before.y);
      assert.equal(after.height, before.height);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    }
    await toggle.focus();
    assert.equal(await boundary.evaluate((el) => getComputedStyle(el).contentVisibility), 'auto');
    await toggle.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await toggle.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
  } finally {
    await page.close();
  }
});

test('failed primary executions disclose their reason, survive reload and identify the collapsed member', async () => {
  const { page, errors, unexpected } = await open({ failureVisibility: true });
  try {
    for (const language of ['zh', 'en']) {
      await page.evaluate((value) => window.__replies.setLanguage(value), language);
      const diagnostic = page.locator('[data-message-id="r-network-error"] [data-testid="cli-diagnostics-banner"]');
      assert.match(await diagnostic.innerText(), /网络连接失败/);
      const summary = page.locator('[data-testid="failed-group"] [data-testid="thread-status-text"]');
      await summary.focus();
      assert.match(await page.getByRole('tooltip').innerText(), /F317 C · 前台收件与长对话续接/);
      await diagnostic.screenshot({ path: path.join(evidenceDir ?? '/tmp', `failure-visible-${language}.png`) });
      await page.reload({ waitUntil: 'networkidle' });
      assert.match(await diagnostic.innerText(), /网络连接失败/);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
  } finally {
    await page.close();
  }
});

const STATES = [
  ['r-writing', 'working', '正在写回复'],
  ['r-working', 'working', '正在运行命令 pnpm'],
  ['r-working-long', 'working', '正在运行命令 pnpm'],
  ['r-quiet', 'quiet', '没有动静'],
  ['r-durable-processing', 'working', '正在写回复'],
  ['r-failed', 'failed', '没有完成：等待回复超时'],
  ['r-stopped', 'stopped', '已停止'],
];

test('every state of the last line: 22px high, observed working cat or 8px state dot, aligned with the body, nothing leaves the column', async () => {
  const { page, errors, unexpected } = await open({ width: 720 });
  for (const [id, kind, words] of STATES) {
    const m = await measure(page, id);
    assert.equal(m.hasLine, true, `${id}: has a last line`);
    assert.equal(m.line.h, 22, `${id}: the line is 22px high`);
    assert.equal(m.lineFont, '12px', `${id}: 12px text`);
    assert.equal(m.status?.kind, kind, `${id}: status kind`);
    assert.equal(m.status?.text, words, `${id}: status words`);
    if (kind === 'working') {
      assert.equal(m.dot.shape, 'cat');
      assert.equal(Math.round(m.dot.rect.h), 16, `${id}: working cat on the text baseline`);
      assert.equal(
        await page.locator(`[data-message-id="${id}"] [data-testid="reply-activity-cat"]`).textContent(),
        'ᓚᘏᗢ',
      );
    } else {
      assert.equal(m.dot.shape, 'dot');
      assert.equal(Math.round(m.dot.rect.w), 8, `${id}: 8px state dot`);
      assert.equal(Math.round(m.dot.rect.h), 8, `${id}: 8px state dot`);
    }
    assert.equal(m.cliBlock, false, `${id}: the dark CLI block is gone`);
    assert.equal(m.nameRowAnchor, false, `${id}: no anchor on the name row`);
    // the line starts where the body text starts
    assert.ok(
      Math.abs(m.line.x - m.bodyPara.rect.x) <= 1,
      `${id}: the line aligns with the body (${m.line.x} vs ${m.bodyPara.rect.x})`,
    );
    assert.ok(m.columnScroll.scrollWidth <= m.columnScroll.clientWidth, `${id}: nothing leaves the column`);
    assert.ok(m.line.r <= m.column.r - 20 + 1, `${id}: the line stays inside the column`);
    measurements.push({ test: 'states', id, ...m });
  }
  assert.equal((await measure(page, 'r-working')).param, null, 'arguments are absent from the reading line');
  const long = await measure(page, 'r-working-long');
  assert.equal(long.param, null);
  const status = page.locator('[data-message-id="r-working-long"] [data-testid="reply-status"]');
  await status.focus();
  const tip = page.getByRole('tooltip');
  await tip.waitFor();
  assert.ok(
    (await tip.innerText()).includes('--reporter=verbose '.repeat(6).trim()),
    'keyboard tip retains the full command',
  );
  await page.keyboard.press('Escape');
  assert.ok(long.summary.text.includes('1 次工具调用'), 'and the count after it is still there');
  if (evidenceDir)
    await page.locator('[data-testid="column"]').screenshot({ path: path.join(evidenceDir, 'states-light-720.png') });
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await page.close();
});

async function paintedObject(page, object) {
  return page.locator('[data-message-id="r-activity"] [data-testid="reply-status"]').evaluate((status, object) => {
    function findText() {
      const walker = document.createTreeWalker(status, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const index = text.textContent.indexOf(object);
        if (index >= 0) return { text, index };
      }
    }
    function clippingParents(parent, rect) {
      const clippedBy = [];
      for (; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        if (style.overflowX !== 'visible' && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1))
          clippedBy.push(parent.dataset.testid ?? parent.tagName);
        if (parent.dataset.testid === 'reply-last-line') break;
      }
      return clippedBy;
    }
    const found = findText();
    if (found) {
      const { text, index } = found;
      const range = document.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + object.length);
      const rect = range.getBoundingClientRect();
      const clippedBy = clippingParents(text.parentElement, rect);
      const center = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
      const style = getComputedStyle(text.parentElement);
      return {
        object,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        statusClient: status.clientWidth,
        statusScroll: status.scrollWidth,
        clippedBy,
        painted:
          rect.width > 0 &&
          clippedBy.length === 0 &&
          text.parentElement.contains(center) &&
          style.visibility === 'visible' &&
          Number(style.opacity) > 0,
      };
    }
    return { object, painted: false, reason: 'object text absent' };
  }, object);
}

async function assertReadObjectsPainted(page, row, base, width) {
  const objects = [];
  for (const object of ['Another.tsx', 'Second.tsx']) {
    if (object === 'Second.tsx') {
      await page.evaluate(() => window.__replies.appendTool('Read', { file_path: '/app/Second.tsx' }));
      await page.waitForFunction(() =>
        document
          .querySelector('[data-message-id="r-activity"] [data-testid="reply-status"]')
          .textContent.includes('Second.tsx'),
      );
    }
    const paint = await paintedObject(page, object);
    objects.push(paint);
    if (evidenceDir) {
      writeFileSync(path.join(evidenceDir, `object-${base}-${width}-${object}.json`), JSON.stringify(paint, null, 2));
      await row.screenshot({ path: path.join(evidenceDir, `object-${base}-${width}-${object}.png`) });
    }
    assert.equal(paint.painted, true, `short object must actually paint: ${JSON.stringify(paint)}`);
  }
  return objects;
}

test('observed tool calls change the short object and step once; elapsed ticks, reduced motion and narrow reading remain honest', async () => {
  for (const base of ['light', 'dark'])
    for (const width of [720, 300]) {
      const { page, errors, unexpected } = await open({ width, base, activity: true });
      const row = page.locator('[data-message-id="r-activity"]');
      const status = row.getByTestId('reply-status');
      const cat = row.getByTestId('reply-activity-cat');
      await row.scrollIntoViewIfNeeded();
      assert.equal(await status.textContent(), '正在读文件 ThreadItem.tsx');
      const firstTime = await row.getByTestId('reply-working-duration').innerText();
      await page.waitForFunction(
        (previous) =>
          document.querySelector('[data-message-id="r-activity"] [data-testid="reply-working-duration"]')
            .textContent !== previous,
        firstTime,
      );
      assert.equal(await cat.getAttribute('data-pulse'), 'false', 'clock ticks cannot restart an old tool pulse');
      const running = await cat.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          duration: style.animationDuration,
          iterations: style.animationIterationCount,
          rise: Math.min(
            ...node
              .getAnimations()
              .flatMap((animation) =>
                animation.effect.getKeyframes().map((frame) => new DOMMatrix(frame.transform).m42),
              ),
          ),
        };
      });
      assert.equal(running.iterations, 'infinite', 'a live long call keeps moving between tool events');
      assert.equal(running.duration, '0.8s', 'reuse the established small-run cadence');
      assert.ok(running.rise <= -2 && running.rise >= -3, 'the idle run rises 2–3px');
      for (const [label, args, object] of [
        ['Grep', { pattern: 'ReplyLastLine' }, 'ReplyLastLine'],
        ['Bash', { command: 'pnpm test --secret hidden' }, 'pnpm'],
      ]) {
        await page.evaluate(([label, args]) => window.__replies.appendTool(label, args), [label, args]);
        await page.waitForFunction(
          (object) =>
            document
              .querySelector('[data-message-id="r-activity"] [data-testid="reply-status"]')
              .textContent.includes(object),
          object,
        );
        assert.equal(await cat.getAttribute('data-pulse'), 'true', 'one new observed use pulses');
        const animation = await cat.evaluate((node) => {
          const s = getComputedStyle(node);
          return {
            name: s.animationName,
            iterations: s.animationIterationCount,
            duration: s.animationDuration,
            rise: Math.min(
              ...node
                .getAnimations()
                .flatMap((animation) =>
                  animation.effect.getKeyframes().map((frame) => new DOMMatrix(frame.transform).m42),
                ),
            ),
          };
        });
        assert.match(animation.name, /reply-tool-step/);
        assert.equal(animation.iterations, '1');
        assert.equal(animation.duration, '0.6s');
        assert.equal(animation.rise, -6, 'the fresh call replaces the small run with one higher jump');
        assert.doesNotMatch(await status.innerText(), /secret|hidden|--/);
        await page.waitForFunction(
          () =>
            document.querySelector('[data-message-id="r-activity"] [data-testid="reply-activity-cat"]').dataset
              .pulse === 'false',
        );
        assert.equal(await cat.evaluate((node) => getComputedStyle(node).animationIterationCount), 'infinite');
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate(() => window.__replies.appendTool('Read', { file_path: '/app/Another.tsx' }));
      await page.waitForFunction(() =>
        document
          .querySelector('[data-message-id="r-activity"] [data-testid="reply-status"]')
          .textContent.includes('Another.tsx'),
      );
      assert.equal(await cat.evaluate((node) => getComputedStyle(node).animationName), 'none');
      await page.waitForFunction(
        () =>
          document.querySelector('[data-message-id="r-activity"] [data-testid="reply-activity-cat"]').dataset.pulse ===
          'false',
      );
      assert.equal(
        await cat.evaluate((node) => getComputedStyle(node).animationName),
        'none',
        'reduced motion also stops the continuous run',
      );
      assert.equal(await row.locator('[data-testid="cat-nameplate-avatar"] .animate-pulse').count(), 0);
      const objects = await assertReadObjectsPainted(page, row, base, width);
      const geometry = await row.getByTestId('reply-last-line').evaluate((line) => ({
        height: line.getBoundingClientRect().height,
        scroll: line.scrollWidth,
        client: line.clientWidth,
      }));
      assert.equal(geometry.height, 22);
      assert.ok(geometry.scroll <= geometry.client + 1, JSON.stringify(geometry));
      if (evidenceDir) await row.screenshot({ path: path.join(evidenceDir, `activity-${base}-${width}.png`) });
      measurements.push({ test: 'activity', base, width, geometry, objects });
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, []);
      await page.close();
    }
});

test('the settled reply: record line with duration and errors, trajectory at its end, nothing said about being done', async () => {
  const { page, errors } = await open({ width: 720 });
  const m = await measure(page, 'r-done');
  assert.equal(m.status, null, 'a normal finish has no status');
  assert.equal(m.summary.text, '3 次工具调用 · 6 分 42 秒 · 其中 1 次出错');
  assert.equal(m.trajectory, true);
  assert.equal(m.line.h, 22);
  assert.equal(m.record, null, 'the record starts closed');
  assert.ok(!(await page.locator('[data-message-id="r-done"]').innerText()).includes('已完成'));
  const plain = await measure(page, 'r-plain');
  assert.equal(plain.hasLine, false, 'a plain callback reply with nothing to record has no last line');
  const rerouted = await measure(page, 'r-rerouted');
  assert.equal(rerouted.reroute?.text, '上游换模', 'F319: the reroute stays on the line');
  await page.close();
  assert.deepEqual(errors, []);
});

test('S3/S4: canonical dispatch avatars and terminal recall retain exact sources, with linked and legacy carriers invisible', async () => {
  const { page, errors, unexpected } = await open({ width: 400 });
  const reply = page.locator('[data-message-id="r-handoff-recall"]');
  const dispatch = reply.locator('xpath=following-sibling::ul[@data-testid="message-dispatch-avatars"]');
  assert.deepEqual(
    await dispatch
      .locator('[data-dispatch-target]')
      .evaluateAll((items) => items.map((item) => [item.dataset.dispatchTarget, item.dataset.dispatchPhase])),
    [
      ['codex', 'settled'],
      ['gemini', 'settled'],
    ],
  );
  assert.equal(await reply.locator('[data-testid="reply-recall"]').innerText(), '召回 1');
  for (const id of ['r-handoff-route-1', 'r-handoff-route-2', 'r-dispatch-failure-1', 'r-dispatch-failure-2']) {
    assert.equal(await page.locator(`[data-message-id="${id}"]`).count(), 0, `${id}: no separate carrier row`);
  }
  await reply.locator('[data-testid="reply-record-toggle"]').click();
  assert.equal(await reply.locator('[data-testid="reply-record"] > :first-child').innerText(), '检索 1');
  await reply.locator('[data-testid="reply-recall"]').click();
  const url = new URL(page.url());
  assert.equal(url.searchParams.get('workspaceMode'), 'recall');
  assert.equal(url.searchParams.get('recallInv'), 'r-handoff-recall');
  assert.equal(url.searchParams.get('recallCat'), 'opus');
  const fallback = page.locator('[data-message-id="r-orphan-dispatch-failure"]');
  assert.equal(await page.locator('[data-message-id="r-source-not-in-timeline"]').count(), 0);
  assert.equal(await fallback.isVisible(), true, 'an unlinked failure remains visible instead of disappearing');
  assert.match(await fallback.innerText(), /唤起处理成员失败/);
  const m = await measure(page, 'r-handoff-recall');
  assert.ok(m.columnScroll.scrollWidth <= m.columnScroll.clientWidth, 'the 400px column does not overflow');
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await page.close();
});

test('opening the record: thinking, one row per call, the model line last; the chosen state is kept; 400px stays inside', async () => {
  const { page, errors } = await open({ width: 400 });
  await page.locator('[data-message-id="r-done"] [data-testid="reply-record-toggle"]').click();
  const open1 = await measure(page, 'r-done');
  assert.ok(open1.record, 'the record is open');
  const rows = await page.locator('[data-message-id="r-done"] [data-testid^="reply-record-tool-"]').count();
  assert.equal(rows, 3);
  assert.equal(await page.locator('[data-message-id="r-done"] [data-testid="reply-record-thinking"]').count(), 1);
  const order = await page
    .locator('[data-message-id="r-done"] [data-testid="reply-record"] > *')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  assert.equal(order[0], 'reply-record-thinking');
  assert.equal(order.at(-1), 'reply-record-meta', 'the model / cost line is last');
  assert.ok(open1.columnScroll.scrollWidth <= open1.columnScroll.clientWidth, 'nothing leaves the 400px column');
  assert.ok(open1.record.r <= open1.column.r - 20 + 1, 'the record stays inside the column');
  if (evidenceDir)
    await page
      .locator('[data-message-id="r-done"]')
      .screenshot({ path: path.join(evidenceDir, 'record-open-400.png') });
  assert.deepEqual(errors, []);
  await page.close();
});

test('native pointer opens adjacent running and terminal records without losing the click during focus reflow', async () => {
  const { page, errors, unexpected } = await open({ width: 400 });
  await page.setViewportSize({ width: 480, height: 2600 });

  for (const [phase, status, rowState] of [
    ['running', 'working', 'running'],
    ['canceled', 'stopped', 'unconfirmed'],
    ['succeeded', null, 'unconfirmed'],
  ]) {
    const message = page.locator(`[data-message-id="r-terminal-${phase}"]`);
    assert.equal(
      await message.locator('[data-testid="reply-layers"]').getAttribute('data-reply-status'),
      status,
      `${phase}: terminal precedence is visible before disclosure`,
    );

    const toggle = message.locator('[data-testid="reply-record-toggle"]');
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', `${phase}: native pointer opens the record`);
    assert.equal(
      await message.locator(`[data-testid="reply-record-tool-terminal-${phase}"]`).getAttribute('data-state'),
      rowState,
      `${phase}: the opened row uses the effective reply state`,
    );
  }

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await page.close();
});

for (const [base] of [['light'], ['dark']]) {
  test(`legibility on what is really behind it — ${base}: status words ≥ 4.5:1, the record line ≥ 4.5:1, the dot ≥ 3:1`, async () => {
    const { page, errors } = await open({ width: 720, base });
    const table = [];
    for (const [id] of STATES) {
      const m = await measure(page, id);
      const words = contrast(m.status.color, m.bg);
      const dot = m.dot.tone === 'hollow' ? null : contrast(m.dot.bg, m.bg);
      const summary = m.summary?.color ? contrast(m.summary.color, m.bg) : null;
      table.push({ id, tone: m.dot.tone, words, dot, summary });
      assert.ok(words >= 4.5, `${base} ${id}: status words ${words}:1 on ${m.bg}`);
      if (dot !== null) assert.ok(dot >= 3, `${base} ${id}: dot ${dot}:1`);
      if (summary !== null) assert.ok(summary >= 4.5, `${base} ${id}: record line ${summary}:1`);
    }
    const rerouted = await measure(page, 'r-rerouted');
    assert.ok(contrast(rerouted.reroute.color, rerouted.bg) >= 4.5, `${base}: the reroute words read`);
    measurements.push({ test: 'legibility', base, table });
    if (evidenceDir)
      await page
        .locator('[data-testid="column"]')
        .screenshot({ path: path.join(evidenceDir, `states-${base}-720.png`) });
    assert.deepEqual(errors, []);
    await page.close();
  });
}

test('v2 reading actions remain transient and forwarding keeps the ordered authorized preview', async () => {
  for (const base of ['light', 'dark']) {
    const { page, errors, unexpected } = await open({ width: 400, base, viewportWidth: 1024 });
    const host = page.getByTestId('line-c');
    const row = host.locator('[data-message-id="c-source"]');
    await row.scrollIntoViewIfNeeded();
    assert.equal(await row.locator('[data-cross-thread-letter]').getByRole('link', { name: '去原对话 ↗' }).count(), 1);
    assert.equal(await row.locator('[data-message-author-row]').getByRole('link', { name: '去原对话 ↗' }).count(), 0);
    assert.equal(
      await row
        .locator('[data-cross-thread-letter]')
        .getByText('从「Canonical source conversation」', { exact: true })
        .count(),
      1,
    );
    assert.equal((await row.innerText()).includes('📮'), false);
    const retired = host.locator('[data-message-id="c-retired-source"]');
    assert.equal(
      await retired.locator('[data-cross-thread-letter]').getByRole('link', { name: '去原对话 ↗' }).count(),
      1,
    );
    assert.equal(await retired.getByTestId('cat-nameplate').count(), 0);
    assert.equal((await retired.innerText()).includes('📮'), false);

    const slot = await row.locator('[data-message-action-slot]').boundingBox();
    assert.equal(slot.width, 0);
    assert.equal(slot.height, 0);
    await row.hover();
    const actions = page.locator('[data-message-actions-owner="c-source"]').getByRole('toolbar', { name: '消息操作' });
    const sourceLink = row.locator('[data-cross-thread-letter]').getByRole('link', { name: '去原对话 ↗' });
    const provenanceHits = await sourceLink.evaluate((link) => {
      const rect = link.getBoundingClientRect();
      return [rect.left + 4, (rect.left + rect.right) / 2, rect.right - 4].map((x) => {
        const hit = document.elementFromPoint(x, (rect.top + rect.bottom) / 2);
        return { owned: link.contains(hit), label: hit?.getAttribute('aria-label'), tag: hit?.tagName };
      });
    });
    assert.ok(
      provenanceHits.every((hit) => hit.owned),
      JSON.stringify(provenanceHits),
    );
    const originUrl = page.url();
    await sourceLink.click();
    assert.equal(new URL(page.url()).pathname, '/thread/c-original', 'native pointer reaches the source owner');
    await page.evaluate((url) => window.history.replaceState(null, '', url), originUrl);
    await row.hover();
    await actions.getByRole('button', { name: '更多消息操作' }).click();
    await actions.getByRole('menu', { name: '更多消息操作', exact: true }).waitFor();
    assert.equal(await actions.getByRole('menuitem', { name: '复制消息 ID' }).count(), 1);
    assert.deepEqual(
      await actions.getByRole('menuitem').allTextContents(),
      ['从这里分支', '复制消息 ID'],
      'More keeps the existing branch and ID actions; reading actions live on the dock',
    );
    assert.equal(await actions.getByRole('separator').count(), 0);
    await actions.getByRole('button', { name: '多选消息' }).click();
    assert.equal(await host.getByRole('checkbox', { checked: true }).count(), 1);
    const selected = host.getByTestId('message-selection-toolbar');
    assert.equal(await selected.getByRole('group', { name: '导出为' }).getByRole('button').count(), 3);
    assert.equal(await selected.getByRole('button', { name: '转发', exact: true }).isDisabled(), true);
    await selected.getByRole('button', { name: '取消', exact: true }).click();
    const card = host.locator('[data-message-bundle-card]');
    assert.deepEqual(
      await card
        .locator('[data-bundle-preview-item]')
        .evaluateAll((items) => items.map((el) => el.dataset.bundlePreviewItem)),
      ['first', 'second'],
    );
    assert.equal(await card.locator('[data-bundle-tombstone] img').count(), 0);
    assert.equal(
      await host
        .getByRole('note', { name: '转发留言' })
        .locator('xpath=ancestor::*[@data-message-bundle-card]')
        .count(),
      0,
    );
    const reads = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/message-bundles/c-bundle')) reads.push(r.url());
    });
    await card.getByRole('button', { name: '展开全部 3 条' }).click();
    await card.getByRole('button', { name: '查看来源消息 3' }).waitFor();
    assert.equal(reads.length, 1, 'each expansion authorizes its source again');
    assert.ok((await card.innerText()).includes('THIRD authorized source'));
    const overflow = await host.evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(overflow.scroll <= overflow.width);
    assert.deepEqual(errors, [], JSON.stringify({ unexpected }));
    assert.deepEqual(unexpected, []);
    await page.close();
  }
});

test('hover and focused action owners leave provenance hit targets and row geometry intact in desktop and compact layouts', async () => {
  for (const [width, viewportWidth] of [
    [400, 1024],
    [720, 1024],
    [350, 390],
  ]) {
    for (const base of ['light', 'dark']) {
      const { page, errors, unexpected } = await open({ width, viewportWidth, base, longSource: true });
      for (const id of ['c-source', 'c-retired-source']) {
        const row = page.locator(`[data-message-id="${id}"]`);
        await row.scrollIntoViewIfNeeded();
        const before = await row.boundingBox();
        await row.hover();
        const paint = page.locator(`[data-message-actions-owner="${id}"]`);
        const control =
          viewportWidth < 768
            ? paint.getByTestId('message-actions-compact-trigger')
            : paint.getByRole('button', { name: '更多消息操作' });
        await control.focus();
        const link = row.locator('[data-cross-thread-letter] a');
        const hits = await link.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const misses = [];
          for (let x = r.left + 8; x < r.right - 4; x += 8) {
            for (const y of [r.top + 4, (r.top + r.bottom) / 2, r.bottom - 4]) {
              const hit = document.elementFromPoint(x, y);
              if (!el.contains(hit)) misses.push({ x, y, label: hit?.getAttribute('aria-label'), tag: hit?.tagName });
            }
          }
          return misses;
        });
        assert.deepEqual(hits, [], `${id}/${width}/${base}: every visible source-link strip belongs to its link`);
        const after = await row.boundingBox();
        assert.equal(after.y, before.y);
        assert.equal(after.height, before.height);
        const slot = await row.locator('[data-message-action-slot]').boundingBox();
        assert.equal(slot.width, 0);
        assert.equal(slot.height, 0);
        const url = page.url();
        await link.click();
        assert.equal(new URL(page.url()).pathname, '/thread/c-original');
        await page.evaluate((original) => window.history.replaceState(null, '', original), url);
      }
      assert.ok(await page.getByTestId('column').evaluate((el) => el.scrollWidth <= el.clientWidth));
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, []);
      if (evidenceDir)
        await page
          .getByTestId('line-c')
          .screenshot({ path: path.join(evidenceDir, `source-hit-${width}-${base}.png`) });
      await page.close();
    }
  }
});

test('narrow user actions preserve reading geometry and return keyboard focus after the existing sheet', async () =>
  runNarrowUserActionJourney(open));

for (const [width, base, presentation] of [
  [720, 'light', 'v2'],
  [300, 'dark', 'v2'],
  [400, 'light', 'classic'],
]) {
  test(`reply body copy switches in place with keyboard disclosure: ${presentation} ${base} ${width}`, async () => {
    const { page, errors, unexpected } = await open({ width, base, presentation, replyCopy: true });
    const reply = page.locator('[data-message-id="r-copy-long"]');
    const quote = page.locator('[data-testid="context-attachment-copy-quote"]');
    const toggle = reply.getByRole('button', {
      name: presentation === 'v2' ? '展开（还有 15 行）' : 'Show more (+15 lines)',
      exact: true,
    });
    await toggle.focus();
    await page.keyboard.press('Enter');
    const less = reply.getByRole('button', { name: presentation === 'v2' ? '收起' : 'Show less', exact: true });
    assert.equal(await less.count(), 1);
    assert.match(
      await quote.innerText(),
      presentation === 'v2' ? /引用[\s\S]*布偶猫 的回复[\s\S]*批注/ : /QUOTE[\s\S]*CLI Output[\s\S]*COMMENT/,
    );
    assert.match(await page.locator('[data-testid="copy-tip"]').innerText(), presentation === 'v2' ? /^提示/ : /^Tip/);
    const draft = page.getByRole('textbox', { name: 'Copy probe draft' });
    await draft.fill('Persist this unsent draft');
    const paragraph = await reply.locator('p').first().elementHandle();
    await less.focus();
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.__replies.setLanguage('en'));
    const englishLess = reply.getByRole('button', { name: 'Show less', exact: true });
    await englishLess.waitFor();
    assert.equal(
      await reply
        .locator('p')
        .first()
        .evaluate((node, old) => node === old, paragraph),
      true,
    );
    assert.equal(await draft.inputValue(), 'Persist this unsent draft');
    assert.equal(await page.evaluate(() => window.scrollY), scrollBefore);
    assert.equal(await englishLess.evaluate((node) => node === document.activeElement), true);
    assert.match(
      await quote.innerText(),
      presentation === 'v2' ? /Quote[\s\S]*布偶猫's reply[\s\S]*Comment/ : /QUOTE[\s\S]*CLI Output[\s\S]*COMMENT/,
    );
    assert.match(await quote.innerText(), /Original quoted text 原样保留/);
    assert.match(await quote.innerText(), /Original comment 批注原文/);
    await page.keyboard.press('Space');
    assert.equal(await reply.getByRole('button', { name: 'Show more (+15 lines)', exact: true }).count(), 1);
    const bounds = await quote.evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth }));
    assert.ok(bounds.scroll <= bounds.width + 1, JSON.stringify(bounds));
    if (evidenceDir) {
      await quote.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(evidenceDir, `reply-copy-${presentation}-${base}-${width}.png`) });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    await page.close();
  });
}

// Registered F322 reply journey; no extra browser unit or parallel admission.
test(
  'native message bundle: original crash route, canonical sender, reload and contained bad reads',
  { timeout: 300000 },
  async () => {
    await runMessageBundleNextJourney(browser, evidenceDir);
  },
);

test(
  'native output: actual Next host preserves answer/process, source selection, history and classic',
  { timeout: 300000 },
  async () => {
    await runNativeReplyNextJourney(browser, evidenceDir);
  },
);

test('native action owner: real sheets, expanded More edges and author translation', { timeout: 300000 }, async () => {
  await runActionOwnerNextJourney(browser, evidenceDir);
});

test(
  'native subexecutions: mother record, native phases, nested identity, history and classic',
  { timeout: 300000 },
  async () => {
    await runSubexecutionNextJourney(browser, evidenceDir);
  },
);

registerCrossThreadLetterJourneys({ webRoot, browser: () => browser, evidenceDir });

test('native live last line: real long command, one higher jump, natural silence and reduced motion', async () => {
  await runNativeReplyMotionJourney(browser, evidenceDir);
});
