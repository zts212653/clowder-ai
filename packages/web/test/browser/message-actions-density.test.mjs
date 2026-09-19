/**
 * F294 resting-density contract + quote-plane collision fixture.
 *
 * The operator twice reported the same defect: a permanently painted action strip pinned above
 * every message, plus a reserved empty row holding it. Unit tests can only assert class
 * names, so this test asserts the rendered result — nothing painted and nothing occupied
 * until a pointer or keyboard actually asks for it. The density fixture renders the real
 * ChatMessageRow boundary, and hit-tests the floated toolbar so paint containment cannot hide
 * behind a green opacity assertion again.
 *
 * It also measures the real Chromium Range offsets for a repeated rendered paragraph, and the
 * renderer's own character-reference decoding, so the server-side collision fixtures in
 * packages/api/test/message-selection-rich-text-quote.test.js stay measured facts instead of
 * guessed numbers.
 *
 * A second test covers touch-only devices, where neither hover nor keyboard focus exists: the
 * per-message actions must stay reachable there or hiding them becomes a functional regression.
 *
 * These fixtures live on their own dev page. The sibling selection-toolbar preview hosts a
 * deployment-admission probe backed by a per-document singleton, so sharing one document made
 * the two guards observe each other's state.
 *
 * Both tests share one dev server and one browser: every extra Next dev server in a run
 * competes for the same first-compile budget, and this file used to spend that budget twice.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');
const COLD_COMPILE_TIMEOUT_MS = 180_000;
const HYDRATION_TIMEOUT_MS = 30_000;

async function findFreePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  server.close();
  await once(server, 'close');
  return address.port;
}

async function waitForPage(url, server, output) {
  // A route-level 200 can arrive before Next has emitted the client chunks referenced by that
  // document. Opening Chromium in that gap yields a permanent chunk-load error, so readiness
  // means both the HTML and every explicit first-screen script are fully retrievable.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited before readiness:\n${output.join('')}`);
    try {
      const response = await fetch(url);
      if (response.ok) {
        const html = await response.text();
        const scriptUrls = Array.from(
          html.matchAll(/<script[^>]+src="([^"]+)"/g),
          ([, source]) => new URL(source.replaceAll('&amp;', '&'), url),
        );
        if (scriptUrls.length > 0) {
          const scriptResponses = await Promise.all(scriptUrls.map((scriptUrl) => fetch(scriptUrl)));
          const scriptsReady = scriptResponses.every((scriptResponse) => scriptResponse.ok);
          await Promise.all(scriptResponses.map((scriptResponse) => scriptResponse.arrayBuffer()));
          if (scriptsReady) return;
        }
      }
    } catch {
      // The server is still compiling or has not opened its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}:\n${output.join('')}`);
}

async function stopServer(server) {
  if (server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

function createTestChildEnvironment(overrides = {}) {
  const childEnv = {
    ...process.env,
    ...overrides,
  };

  // Node's test runner owns every NODE_TEST_* variable. Letting any of them cross into the
  // application server or browser process can change their runtime and corrupt client hydration.
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('NODE_TEST_')) delete childEnv[key];
  }
  return childEnv;
}

function assertNoTestRunnerEnvironment(childEnv, childName) {
  assert.deepEqual(
    Object.keys(childEnv).filter((key) => key.startsWith('NODE_TEST_')),
    [],
    `${childName} must not inherit Node test-runner coordination state`,
  );
}

async function stubProvisionalAvatar(context) {
  // CatAvatar's provisional path is covered by its own hydration-race test. Keep this layout
  // fixture from compiling Next's /_not-found route while the action UI is hydrating.
  await context.route('**/avatars/codex-sol.png', (route) =>
    route.fulfill({
      contentType: 'image/png',
      path: path.join(WEB_ROOT, 'public/avatars/codex.png'),
    }),
  );
}

async function waitForHydratedFixture(page, timeout = HYDRATION_TIMEOUT_MS) {
  await page.locator('[data-testid="f294-quote-plane-fixtures"][data-hydrated="true"]').waitFor({
    state: 'attached',
    timeout,
  });
}

async function gotoHydratedFixture(page, timeout = HYDRATION_TIMEOUT_MS) {
  const clientErrors = [];
  let rejectClientFailure;
  const clientFailure = new Promise((_, reject) => {
    rejectClientFailure = reject;
  });
  const onConsole = (message) => {
    if (message.type() === 'error') clientErrors.push(`console: ${message.text()}`);
  };
  const onPageError = (error) => {
    clientErrors.push(`pageerror: ${error.stack || error.message}`);
    rejectClientFailure(error);
  };
  const onRequestFailed = (request) =>
    clientErrors.push(`requestfailed: ${request.url()} (${request.failure()?.errorText ?? 'unknown'})`);
  const onRequest = (request) => {
    if (!request.url().includes('/_next/static/')) clientErrors.push(`request: ${request.method()} ${request.url()}`);
  };
  const onResponse = (response) => {
    if (response.status() >= 400) clientErrors.push(`response: ${response.status()} ${response.url()}`);
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onRequestFailed);
  page.on('request', onRequest);
  page.on('response', onResponse);

  try {
    await Promise.race([
      (async () => {
        // The fixture owns an explicit hydration marker. Next dev can keep ancillary requests
        // active after the page is usable, so network-idle is not part of this test's contract.
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout });
        await waitForHydratedFixture(page, timeout);
      })(),
      clientFailure,
    ]);
  } catch (error) {
    const documentState = await page
      .evaluate(() => {
        const scripts = Array.from(document.scripts, (script, index) => ({
          index,
          source: script.src || `[inline:${script.text.length}]`,
        }));
        return {
          readyState: document.readyState,
          hydrated: document.querySelector('[data-testid="f294-quote-plane-fixtures"]')?.getAttribute('data-hydrated'),
          scripts,
        };
      })
      .catch((diagnosticError) => ({ diagnosticError: diagnosticError.message }));
    throw new Error(
      [
        `F294 fixture did not hydrate: ${error.message}`,
        `document=${JSON.stringify(documentState)}`,
        ...clientErrors,
        `Next output:\n${serverOutput.join('').slice(-12_000)}`,
      ].join('\n'),
      { cause: error },
    );
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('requestfailed', onRequestFailed);
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
}

async function reloadHydratedFixture(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForHydratedFixture(page);
}

function readToolbarState() {
  const quoteRoot = document.querySelector('[data-testid="f294-density-source"] [data-context-quote-source="message"]');
  const host = document.querySelector('[data-testid="f294-density-source"] [data-message-id="f294-density-message"]');
  const header = document.querySelector('[data-testid="f294-density-source"] [data-testid="message-header"]');
  const bubble = host?.querySelector('[data-testid="message-bubble"]');
  const toolbar = document.querySelector('[data-testid="f294-density-source"] [data-testid="message-actions-toolbar"]');
  if (!quoteRoot || !host || !header || !bubble || !toolbar) throw new Error('F294 density fixture did not render');
  const actionSlot = header.querySelector('[data-message-action-slot]');
  const headerItems = Array.from(
    header.querySelectorAll(':scope > div:first-child > :not([data-message-action-slot])'),
  );
  const author = headerItems[0];
  const timestamp = headerItems[1];
  const hostRect = host.getBoundingClientRect();
  const headerRect = header.getBoundingClientRect();
  const bubbleRect = bubble.getBoundingClientRect();
  const actionSlotRect = actionSlot.getBoundingClientRect();
  const authorRect = author.getBoundingClientRect();
  const timestampRect = timestamp.getBoundingClientRect();
  const style = getComputedStyle(toolbar);
  return {
    hostPaddingTop: getComputedStyle(quoteRoot).paddingTop,
    geometry: {
      host: { top: hostRect.top, height: hostRect.height },
      header: { top: headerRect.top, height: headerRect.height },
      bubble: { top: bubbleRect.top, height: bubbleRect.height },
    },
    toolbarOpacity: Number(style.opacity),
    toolbarPointerEvents: style.pointerEvents,
    actionSlotWidth: actionSlotRect.width,
    authorToTimestampGap: Math.max(timestampRect.left - authorRect.right, authorRect.left - timestampRect.right, 0),
    toolbarHitTarget: (() => {
      const rect = toolbar.getBoundingClientRect();
      const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return target !== null && toolbar.contains(target);
    })(),
    actionAriaLabels: Array.from(toolbar.querySelectorAll('button[aria-label]')).map((button) =>
      button.getAttribute('aria-label'),
    ),
    actionTitles: Array.from(toolbar.querySelectorAll('button[title]')).map((button) => button.getAttribute('title')),
  };
}

function assertStableMessageGeometry(resting, current, state) {
  for (const region of ['host', 'header', 'bubble']) {
    for (const metric of ['top', 'height']) {
      const delta = Math.abs(current.geometry[region][metric] - resting.geometry[region][metric]);
      assert.ok(delta <= 1, `${state} changed ${region}.${metric} by ${delta}px`);
    }
  }
}

function readAdjacentMessageCollision() {
  const rows = Array.from(
    document.querySelectorAll('[data-testid="f294-density-source"] [data-context-quote-source="message"]'),
  );
  const previous = rows[0];
  const current = rows[1];
  const previousFooter = previous?.querySelector('[data-testid="message-metadata"]');
  const currentHeader = current?.querySelector('[data-testid="message-header"]');
  const currentAuthor = currentHeader?.querySelector(':scope > div:first-child > span:first-child');
  const currentToolbar = current?.querySelector(
    '[data-testid="message-actions-toolbar"], [data-testid="message-actions-compact-trigger"]',
  );
  if (!previousFooter || !currentHeader || !currentAuthor || !currentToolbar) {
    throw new Error('adjacent F294 message fixture did not render');
  }
  const footerRect = previousFooter.getBoundingClientRect();
  const headerRect = currentHeader.getBoundingClientRect();
  const toolbarRect = currentToolbar.getBoundingClientRect();
  const overlaps = (left, right) =>
    left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
  const horizontalGap = (left, right) => Math.max(left.left - right.right, right.left - left.right, 0);
  const headerContentRects = Array.from(
    currentHeader.querySelectorAll(':scope > div:first-child > :not([data-message-action-slot])'),
  ).map((element) => element.getBoundingClientRect());
  const headerContentOverlaps = headerContentRects.some((rect) => overlaps(toolbarRect, rect));
  return {
    footer: { left: footerRect.left, right: footerRect.right, top: footerRect.top, bottom: footerRect.bottom },
    header: { left: headerRect.left, right: headerRect.right, top: headerRect.top, bottom: headerRect.bottom },
    toolbar: {
      left: toolbarRect.left,
      right: toolbarRect.right,
      top: toolbarRect.top,
      bottom: toolbarRect.bottom,
    },
    overlapsPreviousMetadata: overlaps(toolbarRect, footerRect),
    headerContentOverlaps,
    toolbarToHeaderGap: Math.min(...headerContentRects.map((rect) => horizontalGap(toolbarRect, rect))),
  };
}

let server;
let serverOutput;
let browser;
let browserContext;
let baseUrl;
let testDistDirPath;
let testTsconfigPath;

before(async () => {
  const port = await findFreePort();
  testDistDirPath = await mkdtemp(path.join(WEB_ROOT, '.next-test-f294-'));
  const testDistDir = path.basename(testDistDirPath);
  testTsconfigPath = path.join(WEB_ROOT, `tsconfig.${testDistDir.slice(1)}.json`);
  await writeFile(
    testTsconfigPath,
    `${JSON.stringify(
      {
        extends: './tsconfig.json',
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', `${testDistDir}/types/**/*.ts`],
        exclude: ['node_modules', 'worker'],
      },
      null,
      2,
    )}\n`,
  );
  const nextDevEnvironment = createTestChildEnvironment({
    CAT_CAFE_WEB_TEST_DIST_DIR: testDistDir,
    CAT_CAFE_WEB_TEST_TSCONFIG: path.basename(testTsconfigPath),
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_ENV: 'development',
  });
  assertNoTestRunnerEnvironment(nextDevEnvironment, 'the Next dev child');
  assert.match(
    nextDevEnvironment.CAT_CAFE_WEB_TEST_DIST_DIR,
    /^\.next-test-f294-/,
    'the Next dev child must not share the production .next directory',
  );
  serverOutput = [];
  server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: WEB_ROOT,
    env: nextDevEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => serverOutput.push(chunk.toString()));
  server.stderr.on('data', (chunk) => serverOutput.push(chunk.toString()));
  baseUrl = `http://127.0.0.1:${port}/dev/f294-quote-plane-fixtures`;
  await waitForPage(baseUrl, server, serverOutput);
  const browserEnvironment = createTestChildEnvironment();
  assertNoTestRunnerEnvironment(browserEnvironment, 'the Chromium child');
  browser = await chromium.launch({ headless: true, env: browserEnvironment });
  browserContext = await browser.newContext();
  await stubProvisionalAvatar(browserContext);

  // An HTTP 200 only proves that Next finished the server route. The first real browser load
  // still has to compile and hydrate the 421 kB client graph, which belongs to the suite's cold
  // bootstrap budget rather than the first test's ordinary interaction budget.
  const warmupPage = await browserContext.newPage();
  await warmupPage.setViewportSize({ width: 1440, height: 900 });
  try {
    await gotoHydratedFixture(warmupPage, COLD_COMPILE_TIMEOUT_MS);
  } finally {
    await warmupPage.close();
  }
});

after(async () => {
  if (browserContext) await browserContext.close();
  if (browser) await browser.close();
  if (server) await stopServer(server);
  if (testDistDirPath) await rm(testDistDirPath, { recursive: true, force: true });
  if (testTsconfigPath) await rm(testTsconfigPath, { force: true });
});

test('message actions occupy no resting layout and stay unpainted until asked for', { timeout: 90_000 }, async () => {
  const page = await browserContext.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  try {
    await gotoHydratedFixture(page);

    const resting = await page.evaluate(readToolbarState);
    assert.equal(resting.hostPaddingTop, '0px', 'a resting message must not pad the top for its action bar');
    assert.equal(resting.toolbarOpacity, 0, 'the action bar must not be painted at rest');
    assert.equal(resting.toolbarPointerEvents, 'none', 'an invisible action bar must not swallow pointer events');
    assert.ok(
      resting.actionSlotWidth <= 1,
      `a hidden action anchor must reserve no row width, saw ${resting.actionSlotWidth}px`,
    );
    assert.ok(
      resting.authorToTimestampGap <= 12,
      `author and timestamp must remain one metadata cluster, saw ${resting.authorToTimestampGap}px`,
    );

    await page.locator('[data-testid="f294-density-source"] [data-message-id="f294-density-message"]').hover();
    // transition-opacity animates, so settle before measuring.
    await page.waitForFunction(
      () => {
        const toolbar = document.querySelector(
          '[data-testid="f294-density-source"] [data-testid="message-actions-toolbar"]',
        );
        return toolbar !== null && Number(getComputedStyle(toolbar).opacity) === 1;
      },
      { timeout: 5_000 },
    );
    const hovered = await page.evaluate(readToolbarState);
    assert.equal(hovered.toolbarOpacity, 1, 'the action bar must appear on hover');
    assert.equal(hovered.toolbarPointerEvents, 'auto', 'the revealed action bar must be clickable');
    assert.equal(
      hovered.toolbarHitTarget,
      true,
      'the real message boundary must not paint-clip its revealed action bar',
    );
    assertStableMessageGeometry(resting, hovered, 'hover');
    assert.ok(hovered.actionAriaLabels.includes('多选消息'), 'hover must reveal the multi-select action');
    assert.ok(
      hovered.actionAriaLabels.some((label) => label.startsWith('复制消息 ID:')),
      'hover must keep message identity in the same dock',
    );
    assert.ok(hovered.actionTitles.includes('引用回复'), 'hover must preserve the reply action');
    assert.ok(hovered.actionTitles.includes('创建分支'), 'hover must preserve the unified branch action');
    assert.ok(hovered.actionTitles.includes('删除'), 'hover must preserve the delete action');
    assert.equal(
      hovered.actionAriaLabels.includes('更多消息操作'),
      false,
      'the unified dock must not duplicate branch/delete behind an overflow menu',
    );

    // Moving the pointer away and focusing a hidden action must reveal the same local row for
    // keyboard users, without relying on hover to keep it painted.
    await page.mouse.move(0, 0);
    const selectionButton = page
      .locator('[data-testid="f294-density-source"] [data-context-quote-source="message"]')
      .first()
      .getByRole('button', { name: '多选消息' });
    await selectionButton.focus();
    await page.waitForFunction(
      () => {
        const toolbar = document.querySelector(
          '[data-testid="f294-density-source"] [data-testid="message-actions-toolbar"]',
        );
        return toolbar !== null && Number(getComputedStyle(toolbar).opacity) === 1;
      },
      { timeout: 5_000 },
    );
    const focused = await page.evaluate(readToolbarState);
    assert.equal(focused.toolbarOpacity, 1, 'the action bar must appear on keyboard focus');
    assert.equal(focused.toolbarPointerEvents, 'auto', 'the focused action bar must be operable');
    assertStableMessageGeometry(resting, focused, 'toolbar keyboard focus');

    // A focusable control inside the message body is not a request to paint the action dock.
    const bodyControl = page.locator(
      '[data-testid="f294-density-source"] [data-message-id="f294-density-message"] a[href="https://example.com/f294-body-control"]',
    );
    await bodyControl.focus();
    await page.waitForFunction(
      () => {
        const toolbar = document.querySelector(
          '[data-testid="f294-density-source"] [data-testid="message-actions-toolbar"]',
        );
        return toolbar !== null && Number(getComputedStyle(toolbar).opacity) === 0;
      },
      { timeout: 5_000 },
    );
    const bodyFocused = await page.evaluate(readToolbarState);
    assert.equal(bodyFocused.toolbarOpacity, 0, 'body control focus must not reveal the action dock');
    assert.equal(bodyFocused.toolbarPointerEvents, 'none', 'a hidden dock must not intercept body controls');
    assertStableMessageGeometry(resting, bodyFocused, 'body control focus');

    // Keyboard users reach the same actions without a pointer.
    await selectionButton.focus();
    await selectionButton.click();
    assert.equal(await page.getByTestId('f294-density-enter-count').textContent(), '1');
    assert.equal(await page.getByTestId('f294-density-enter-message').textContent(), 'f294-density-message');

    // Measure what a human selecting the SECOND rendered paragraph actually reports.
    const collision = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="f294-quote-collision"]');
      if (!host) throw new Error('F294 quote-plane collision fixture did not render');
      const paragraphs = Array.from(host.querySelectorAll('p'));
      if (paragraphs.length !== 2) throw new Error(`expected 2 rendered paragraphs, got ${paragraphs.length}`);
      const second = paragraphs[1];
      const range = document.createRange();
      range.selectNodeContents(second);
      const prefix = range.cloneRange();
      prefix.selectNodeContents(host);
      prefix.setEnd(range.startContainer, range.startOffset);
      const start = prefix.toString().length;
      return { text: range.toString(), start, end: start + range.toString().length };
    });

    // Pins DOM_SECOND_PARAGRAPH_RANGE in
    // packages/api/test/message-selection-rich-text-quote.test.js, which asserts the projection
    // plane does NOT put its occurrences at these offsets.
    assert.equal(collision.text, 'foo');
    assert.deepEqual(
      { start: collision.start, end: collision.end },
      { start: 4, end: 7 },
      'the measured DOM offsets of the second rendered paragraph must stay pinned',
    );

    // One browser bubble can be projected from several stored rows. A human range is allowed to
    // cross the paragraph seam, and Selection.toString() supplies the separator the server's v3
    // bubble quote plane validates. This is the real platform fact behind the API regression.
    const crossParagraphText = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="f294-quote-collision"]');
      if (!host) throw new Error('F294 quote-plane collision fixture did not render');
      const paragraphs = Array.from(host.querySelectorAll('p'));
      const firstText = paragraphs[0]
        ? document.createTreeWalker(paragraphs[0], NodeFilter.SHOW_TEXT).nextNode()
        : null;
      const secondText = paragraphs[1]
        ? document.createTreeWalker(paragraphs[1], NodeFilter.SHOW_TEXT).nextNode()
        : null;
      if (!firstText || !secondText) throw new Error('expected two paragraph text nodes');
      const range = document.createRange();
      range.setStart(firstText, 1);
      range.setEnd(secondText, 2);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString() ?? '';
    });
    assert.equal(crossParagraphText, 'oo\n\nfo', 'Chromium must expose a cross-paragraph quote as one selection');
    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    // The renderer decodes character references, so `&copy;` and `©` are the SAME glyph on
    // screen. The readable projection must therefore carry two © for this source.
    const renderedEntities = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="f294-entity-collision"]');
      if (!host) throw new Error('F294 entity fixture did not render');
      return host.textContent ?? '';
    });
    assert.equal(
      (renderedEntities.match(/©/g) ?? []).length,
      2,
      'the production renderer must decode &copy; into a second visible ©',
    );

    // Each grammar fixture must show its visible text twice in the production renderer; the
    // server-side projection asserts the same counts in the API suite.
    const grammarCounts = await page.evaluate(() => {
      const read = (testId) => {
        const host = document.querySelector(`[data-testid="${testId}"]`);
        if (!host) throw new Error(`F294 fixture ${testId} did not render`);
        return host.textContent ?? '';
      };
      const count = (text, visible) => text.split(visible).length - 1;
      return {
        delimiter: count(read('f294-delimiter-collision'), '--'),
        pipeRow: count(read('f294-pipe-row-collision'), '| --- |'),
        invalidReference: count(read('f294-invalid-reference-collision'), '\ufffd'),
      };
    });
    assert.deepEqual(
      grammarCounts,
      { delimiter: 2, pipeRow: 2, invalidReference: 2 },
      'the production renderer must show both occurrences of every grammar fixture',
    );

    // Interface chrome inside the source root is not quotable evidence: selecting a component's
    // own state text must offer no quote action at all.
    const chromeQuoteOffered = await page.evaluate(() => {
      const chrome = document.querySelector('[data-testid="f294-chrome-text"]');
      if (!chrome) throw new Error('F294 chrome fixture did not render');
      const range = document.createRange();
      range.selectNodeContents(chrome);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selection?.toString() ?? '';
    });
    assert.match(chromeQuoteOffered, /正在渲染/, 'the fixture must actually be selected');
    await page.waitForTimeout(200);
    assert.equal(
      await page.getByTestId('message-selection-add-to-chat').count(),
      0,
      'selecting interface chrome must not offer a quote action',
    );
    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    // The renderer numbers footnote labels itself, so `1` is on screen more often than the
    // Markdown source contains it. This is why quoting such messages is refused outright.
    const generatedText = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="f294-generated-text"]');
      if (!host) throw new Error('F294 generated-text fixture did not render');
      return host.textContent ?? '';
    });
    assert.ok(
      (generatedText.match(/1/g) ?? []).length >= 2,
      `the renderer must generate a visible footnote label absent from the source, saw ${JSON.stringify(generatedText)}`,
    );
  } finally {
    await page.close();
  }
});

test('a revealed message toolbar never covers adjacent message chrome', { timeout: 90_000 }, async () => {
  for (const viewport of [
    { width: 360, height: 800 },
    { width: 640, height: 800 },
    { width: 768, height: 900 },
    { width: 1024, height: 900 },
    { width: 1440, height: 900 },
  ]) {
    const page = await browserContext.newPage();
    await page.setViewportSize(viewport);
    try {
      await gotoHydratedFixture(page);
      await page
        .locator('[data-testid="f294-density-source"] [data-message-id="f294-density-followup-message"]')
        .hover();
      await page.waitForFunction(
        () => {
          const rows = document.querySelectorAll(
            '[data-testid="f294-density-source"] [data-context-quote-source="message"]',
          );
          const toolbar = rows[1]?.querySelector(
            '[data-testid="message-actions-toolbar"], [data-testid="message-actions-compact-trigger"]',
          );
          return toolbar !== null && Number(getComputedStyle(toolbar).opacity) === 1;
        },
        { timeout: 5_000 },
      );

      const collision = await page.evaluate(readAdjacentMessageCollision);
      assert.equal(
        collision.overlapsPreviousMetadata,
        false,
        `the current toolbar must not cover the previous metadata at ${viewport.width}px: ${JSON.stringify(collision)}`,
      );
      assert.equal(
        collision.headerContentOverlaps,
        false,
        `the current toolbar must not cover its own author chrome at ${viewport.width}px: ${JSON.stringify(collision)}`,
      );
      assert.ok(
        collision.toolbarToHeaderGap <= 12,
        `the current toolbar must stay attached to its metadata cluster at ${viewport.width}px: ${JSON.stringify(collision)}`,
      );
    } finally {
      await page.close();
    }
  }
});

test(
  'a cross-row paragraph selection keeps the real MessageActions forward affordance',
  { timeout: 90_000 },
  async () => {
    const page = await browserContext.newPage();
    await page.setViewportSize({ width: 360, height: 800 });
    try {
      await gotoHydratedFixture(page);
      const selectedText = await page.evaluate(() => {
        const bubble = document.querySelector('[data-testid="f294-cross-row-bubble"]');
        if (!bubble) throw new Error('cross-row MessageActions fixture did not render');
        const paragraphs = Array.from(bubble.querySelectorAll('p'));
        const firstText = paragraphs[0]?.firstChild;
        const secondText = paragraphs[1]?.firstChild;
        if (!firstText || !secondText) throw new Error('expected two paragraph text nodes');
        const range = document.createRange();
        range.setStart(firstText, 1);
        range.setEnd(secondText, 2);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return selection?.toString() ?? '';
      });
      assert.equal(selectedText, 'oo\n\nfo');

      await page.getByTestId('message-selection-add-to-chat').click();
      const forward = page.getByTestId('context-annotation-forward');
      await forward.waitFor({ state: 'visible' });
      assert.equal(
        await page.getByTestId('context-annotation-comment').inputValue(),
        '',
        'the real annotation editor must own the cross-row selection before forwarding',
      );
      await forward.click();
      await page.getByRole('dialog', { name: '转发到' }).waitFor({ state: 'visible' });

      await page.getByRole('button', { name: '取消转发' }).click();
      await reloadHydratedFixture(page);
      await page.evaluate(() => {
        const first = document.querySelector('[data-testid="f294-cross-row-bubble"] p');
        if (!first) throw new Error('cross-row duplicate fixture did not render');
        const range = document.createRange();
        range.selectNodeContents(first);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      });
      await page.getByTestId('message-selection-add-to-chat').click();
      await page.getByTestId('context-annotation-save').waitFor({ state: 'visible' });
      assert.equal(
        await page.getByTestId('context-annotation-forward').count(),
        0,
        'a paragraph repeated elsewhere in the same rendered bubble must remain fail-closed',
      );
    } finally {
      await page.close();
    }
  },
);

test('a Markdown-rendered CLI table row keeps the real forwarding affordance', { timeout: 90_000 }, async () => {
  const page = await browserContext.newPage();
  await page.setViewportSize({ width: 720, height: 900 });
  try {
    await gotoHydratedFixture(page);
    const selectionEvidence = await page.evaluate(() => {
      const bubble = document.querySelector('[data-testid="f294-cli-markdown-bubble"]');
      const segment = bubble?.querySelector('[data-context-quote-segment-id="stdout"]');
      const row = segment?.querySelector('tbody tr');
      if (!bubble || !segment || !row) throw new Error('Markdown CLI table fixture did not render');
      const range = document.createRange();
      range.selectNodeContents(row);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return {
        text: selection?.toString().trim() ?? '',
        projectionVersion: segment.getAttribute('data-context-quote-projection-version'),
      };
    });

    assert.equal(
      selectionEvidence.text,
      'Hub Browser Preview\tno_matching_client\t不属于本 thread 的修复责任',
      'the browser evidence must be visible cell text, not raw Markdown pipes/backticks',
    );
    assert.equal(selectionEvidence.projectionVersion, '2', 'stdout must explicitly declare its readable plane');

    await page.getByTestId('message-selection-add-to-chat').click();
    const forward = page.getByTestId('context-annotation-forward');
    await forward.waitFor({ state: 'visible' });
    await forward.click();
    await page.getByRole('dialog', { name: '转发到' }).waitFor({ state: 'visible' });
  } finally {
    await page.close();
  }
});

test('a Rich Card final paragraph still exposes the quote affordance', { timeout: 90_000 }, async () => {
  const page = await browserContext.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  try {
    await gotoHydratedFixture(page);
    const selectionEvidence = await page.evaluate(() => {
      const bubble = document.querySelector('[data-testid="f294-rich-last-line-bubble"]');
      const paragraphs = bubble ? Array.from(bubble.querySelectorAll('p')) : [];
      const paragraph = paragraphs.at(-1);
      if (!bubble || !paragraph) throw new Error('Rich Card final-paragraph fixture did not render');
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return {
        text: selection?.toString() ?? '',
        excludedIntersections: Array.from(bubble.querySelectorAll('[data-quote-exclude]'))
          .filter((node) => range.intersectsNode(node))
          .map((node) => node.getAttribute('data-testid') ?? node.tagName),
      };
    });

    assert.equal(selectionEvidence.text, '已执行：最后一行仍然可以引用。');
    await page.getByTestId('message-selection-add-to-chat').waitFor({ state: 'visible' });

    await reloadHydratedFixture(page);
    const boundarySelection = await page.evaluate(() => {
      const bubble = document.querySelector('[data-testid="f294-rich-last-line-bubble"]');
      const paragraph = bubble ? Array.from(bubble.querySelectorAll('p')).at(-1) : null;
      const text = paragraph?.firstChild;
      if (!bubble || !paragraph || !text) throw new Error('Rich Card boundary fixture did not render');
      const range = document.createRange();
      range.setStart(text, 0);
      // A human drag can finish in the blank area after the final rendered line. Chromium then
      // keeps the same visible text but places the DOM endpoint after the RichBlocks wrapper,
      // which also contains the icon-only forwarding dock.
      range.setEnd(bubble, bubble.childNodes.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return {
        text: selection?.toString().trim() ?? '',
        excludedIntersections: Array.from(
          bubble.closest('[data-context-quote-source="message"]')?.querySelectorAll('[data-quote-exclude]') ?? [],
        )
          .filter((node) => range.intersectsNode(node))
          .map((node) => node.getAttribute('data-testid') ?? node.tagName),
      };
    });

    assert.equal(boundarySelection.text, '已执行：最后一行仍然可以引用。');
    assert.ok(
      boundarySelection.excludedIntersections.includes('rich-block-forward-actions'),
      `the platform fixture must retain the boundary-only Range intersection, saw ${JSON.stringify(boundarySelection)}`,
    );
    await page.waitForTimeout(200);
    assert.equal(
      await page.getByTestId('message-selection-add-to-chat').count(),
      1,
      `boundary-only contact with an icon dock must keep the quote affordance: ${JSON.stringify(boundarySelection)}`,
    );
  } finally {
    await page.close();
  }
});

test(
  'touch-only devices expose a compact 44px entry that expands every message action',
  { timeout: 90_000 },
  async () => {
    for (const viewport of [
      { width: 360, height: 800 },
      { width: 768, height: 1024 },
    ]) {
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
      await stubProvisionalAvatar(context);
      const page = await context.newPage();
      try {
        await gotoHydratedFixture(page);

        // Guard the emulation itself: without (hover: none) this test would prove nothing.
        const touchLike = await page.evaluate(() => window.matchMedia('(hover: none) and (pointer: coarse)').matches);
        assert.equal(touchLike, true, 'mobile emulation must report a hoverless coarse pointer');

        const firstRow = page
          .locator('[data-testid="f294-density-source"] [data-context-quote-source="message"]')
          .first();
        const compactEntry = firstRow.getByRole('button', { name: '打开消息操作' });
        await compactEntry.waitFor({ state: 'visible' });
        const entryBox = await compactEntry.boundingBox();
        assert.ok(entryBox, 'the compact action entry must have a rendered hit box');
        assert.ok(entryBox.width >= 44, `compact entry width must be at least 44px, saw ${entryBox.width}`);
        assert.ok(entryBox.height >= 44, `compact entry height must be at least 44px, saw ${entryBox.height}`);

        await compactEntry.tap();
        const expandedDock = page.getByTestId('message-actions-compact-sheet').getByTestId('message-actions-toolbar');
        await expandedDock.waitFor({ state: 'visible' });
        const directTargets = expandedDock.locator('button');
        const targetCount = await directTargets.count();
        assert.ok(targetCount >= 4, 'the compact entry must expand the complete direct action dock');
        for (let index = 0; index < targetCount; index += 1) {
          const box = await directTargets.nth(index).boundingBox();
          assert.ok(box, `expanded action ${index} must have a rendered hit box`);
          assert.ok(box.width >= 44, `expanded action ${index} width must be at least 44px, saw ${box.width}`);
          assert.ok(box.height >= 44, `expanded action ${index} height must be at least 44px, saw ${box.height}`);
        }

        // Tapping the expanded action still targets the originating message.
        await expandedDock.getByRole('button', { name: '多选消息' }).tap();
        assert.equal(await page.getByTestId('f294-density-enter-count').textContent(), '1');
        assert.equal(await page.getByTestId('f294-density-enter-message').textContent(), 'f294-density-message');
      } finally {
        await context.close();
      }
    }
  },
);
