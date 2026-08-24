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
import { createServer } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');

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
  // This page pulls the full Markdown renderer (KaTeX included); its first dev compile is
  // slow, and the browser guards each own a whole Next dev server.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited before readiness:\n${output.join('')}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
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

function readToolbarState() {
  const host = document.querySelector('[data-testid="f294-density-source"] [data-context-quote-source="message"]');
  const bubble = document.querySelector('[data-testid="f294-density-source"] [data-message-id="f294-density-message"]');
  const toolbar = document.querySelector('[data-testid="f294-density-source"] div.absolute');
  if (!host || !bubble || !toolbar) throw new Error('F294 density fixture did not render');
  const hostRect = host.getBoundingClientRect();
  const bubbleRect = bubble.getBoundingClientRect();
  const style = getComputedStyle(toolbar);
  return {
    reservedRowHeight: bubbleRect.top - hostRect.top,
    hostPaddingTop: getComputedStyle(host).paddingTop,
    toolbarOpacity: Number(style.opacity),
    toolbarPointerEvents: style.pointerEvents,
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

let server;
let serverOutput;
let browser;
let baseUrl;

before(async () => {
  const port = await findFreePort();
  serverOutput = [];
  server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: WEB_ROOT,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => serverOutput.push(chunk.toString()));
  server.stderr.on('data', (chunk) => serverOutput.push(chunk.toString()));
  baseUrl = `http://127.0.0.1:${port}/dev/f294-quote-plane-fixtures`;
  await waitForPage(baseUrl, server, serverOutput);
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await stopServer(server);
});

test('message actions occupy no resting layout and stay unpainted until asked for', { timeout: 90_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    const resting = await page.evaluate(readToolbarState);
    assert.equal(resting.reservedRowHeight, 0, 'a resting message must not reserve a row for its action bar');
    assert.equal(resting.hostPaddingTop, '0px', 'a resting message must not pad the top for its action bar');
    assert.equal(resting.toolbarOpacity, 0, 'the action bar must not be painted at rest');
    assert.equal(resting.toolbarPointerEvents, 'none', 'an invisible action bar must not swallow pointer events');

    await page.locator('[data-testid="f294-density-source"] [data-message-id="f294-density-message"]').hover();
    // transition-opacity animates, so settle before measuring.
    await page.waitForFunction(
      () => {
        const toolbar = document.querySelector('[data-testid="f294-density-source"] div.absolute');
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
    assert.equal(hovered.reservedRowHeight, 0, 'revealing the action bar must not reflow the message');
    assert.ok(hovered.actionAriaLabels.includes('多选消息'), 'hover must reveal the multi-select action');
    assert.ok(hovered.actionTitles.includes('引用回复'), 'hover must preserve the reply action');
    assert.ok(hovered.actionTitles.includes('删除'), 'hover must preserve the delete action');
    assert.ok(hovered.actionAriaLabels.includes('更多消息操作'), 'hover must preserve the overflow action');

    // Keyboard users reach the same actions without a pointer.
    await page.getByRole('button', { name: '多选消息' }).click();
    assert.equal(await page.getByTestId('f294-density-enter-count').textContent(), '1');

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

test(
  'a cross-row paragraph selection keeps the real MessageActions forward affordance',
  { timeout: 90_000 },
  async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
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
      await page.reload({ waitUntil: 'networkidle' });
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
  const page = await browser.newPage({ viewport: { width: 720, height: 900 } });
  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
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

    await page.reload({ waitUntil: 'networkidle' });
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

test('touch-only devices keep every per-message action reachable', { timeout: 90_000 }, async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // Guard the emulation itself: without (hover: none) this test would prove nothing.
    const touchLike = await page.evaluate(() => window.matchMedia('(hover: none) and (pointer: coarse)').matches);
    assert.equal(touchLike, true, 'mobile emulation must report a hoverless coarse pointer');

    const state = await page.evaluate(readToolbarState);
    assert.equal(state.toolbarOpacity, 1, 'a touch-only device has no hover, so actions must be visible');
    assert.equal(state.toolbarPointerEvents, 'auto', 'a touch-only device must be able to tap the actions');
    assert.ok(state.reservedRowHeight > 0, 'a permanently visible toolbar must reserve its own row on touch');

    // Tapping a real action works without any hover or keyboard focus.
    await page.getByRole('button', { name: '多选消息' }).tap();
    assert.equal(await page.getByTestId('f294-density-enter-count').textContent(), '1');
  } finally {
    await context.close();
  }
});
