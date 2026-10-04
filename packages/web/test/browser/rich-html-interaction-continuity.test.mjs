import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { registerScriptContentRegression } from './html-widget-script-content.cases.mjs';
import {
  CLI_SIGNATURE,
  createContinuityHarness,
  WIDGET_SELECTOR,
} from './rich-html-interaction-continuity.harness.mjs';

const harness = createContinuityHarness();
const { activeWidget, openFixture } = harness;

before(harness.start);
after(harness.stop);
registerScriptContentRegression(harness);

async function sampleStableReadingTarget(page, expectedOffset = null) {
  return page.evaluate(
    (expectedOffset) =>
      new Promise((resolve, reject) => {
        const deadline = performance.now() + 10_000;
        let previous;
        let stableFrames = 0;
        const read = () => {
          const chat = document.querySelector('[data-thread-chat-density="full"] [data-chat-container]');
          const rows = [...(chat?.querySelectorAll('[data-message-viewport-id]') ?? [])];
          const targetIndex = rows.findIndex((row) => row.dataset.messageViewportId === 'continuity-filler-3');
          const target = rows[targetIndex];
          const deferredBeforeTarget = rows
            .slice(0, targetIndex + 1)
            .some((row) => row.hasAttribute('data-deferred-message-id'));
          const saved = JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:rich-html-continuity-a') ?? '{}').state;
          const sample = target
            ? {
                top: chat.scrollTop,
                offset: target.getBoundingClientRect().top - chat.getBoundingClientRect().top,
                saved,
              }
            : null;
          return { sample, deferredBeforeTarget };
        };
        const tick = () => {
          const { sample, deferredBeforeTarget } = read();
          const saved = sample?.saved;
          const offset = expectedOffset ?? saved?.messageAnchor?.viewportOffsetPx;
          const ready =
            sample &&
            !deferredBeforeTarget &&
            saved?.anchor === 'offset' &&
            saved.messageAnchor?.messageId === 'continuity-filler-3' &&
            saved.messageAnchor.viewportOffsetPx === offset &&
            sample.offset === offset;
          stableFrames =
            ready && previous?.top === sample.top && previous?.offset === sample.offset ? stableFrames + 1 : 0;
          previous = sample;
          // Capture the assertion's values in the same frame that establishes readiness.
          // A separate evaluate can land between a deferred mount and its correction RAF.
          if (stableFrames >= 2) return resolve(sample);
          if (performance.now() >= deadline) {
            return reject(
              new Error(
                `Reading target did not settle: ${JSON.stringify({ expectedOffset, deferredBeforeTarget, sample })}`,
              ),
            );
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    expectedOffset,
  );
}

test('real ThreadChatSurface navigator owns its reading target across thread return and refresh', async () => {
  const page = await openFixture();
  try {
    console.info(`[author-preview] cwd=${process.cwd()} url=${page.url()} path=dot-jump→ThreadB→ThreadA→refresh`);
    await page.locator('[data-message-navigator] button').nth(3).click();
    const before = await sampleStableReadingTarget(page);
    assert.equal(before.offset, before.saved.messageAnchor.viewportOffsetPx);
    await page.getByTestId('switch-thread-b').click();
    await page
      .locator('[data-testid="rich-html-interaction-continuity-fixture"][data-active-thread="rich-html-continuity-b"]')
      .waitFor();
    await page.getByTestId('switch-thread-a').click();
    assert.equal((await sampleStableReadingTarget(page, before.offset)).offset, before.offset);
    await page.reload();
    assert.equal((await sampleStableReadingTarget(page, before.offset)).offset, before.offset);
  } finally {
    await page.close();
  }
});

test('real cat-ball navigation stays local while content below the main reading anchor grows', async () => {
  const page = await openFixture({ query: '?independent=1' });
  try {
    console.info(
      `[author-preview] cwd=${process.cwd()} url=${page.url()} path=main-jump+cat-ball-dot/background/wheel`,
    );
    const panel = page.getByRole('dialog', { name: '猫猫球 对话气泡', exact: true });
    await panel.waitFor();
    const main = page.locator('[data-thread-chat-density="full"]');
    const panelScroll = panel.locator('[data-chat-container]');
    await page.evaluate(() =>
      localStorage.setItem(
        'cat-cafe:thread-scroll:independent-ball',
        JSON.stringify({ v: 1, state: { top: 777, anchor: 'offset' } }),
      ),
    );
    await main.locator('[data-message-navigator] button').nth(3).click();
    const panelBefore = await panelScroll.evaluate((el) => el.scrollTop);
    await panel.locator('[data-message-navigator] button').nth(4).click();
    await page.waitForFunction(
      (top) => document.querySelector('[role="dialog"] [data-chat-container]').scrollTop > top,
      panelBefore,
    );
    const geometryBefore = await sampleStableReadingTarget(page);
    assert.equal(geometryBefore.saved.anchor, 'offset');
    // Below-target growth must not invalidate the owned reading tuple. Total content
    // height can change as offscreen content mounts, independently of panel input.
    const heightBeforeGrowth = await page.evaluate(() => {
      const chat = document.querySelector('[data-thread-chat-density="full"] [data-chat-container]');
      const target = chat.querySelector('[data-message-viewport-id="continuity-filler-3"]');
      const tail = chat.querySelector('[data-message-viewport-id="rich-html-widget-message"]');
      if (!(target.compareDocumentPosition(tail) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        throw new Error('controlled growth must be below the reading target');
      }
      const height = chat.scrollHeight;
      const spacer = document.createElement('div');
      spacer.style.height = '68px';
      tail.append(spacer);
      return height;
    });
    await page.waitForFunction(
      (height) =>
        document.querySelector('[data-thread-chat-density="full"] [data-chat-container]').scrollHeight > height,
      heightBeforeGrowth,
    );
    const track = panel.locator('[data-message-navigator] .cursor-pointer');
    await track.click({ position: { x: 15, y: 180 } });
    await panelScroll.evaluate((el) => {
      if (el.scrollHeight <= el.clientHeight) throw new Error('independent panel must overflow');
    });
    const clickedTop = await panelScroll.evaluate((el) => el.scrollTop);
    assert(clickedTop > panelBefore, 'background click must move the independent panel');
    await track.hover({ position: { x: 15, y: 100 } });
    await page.mouse.wheel(0, -50);
    await page.waitForFunction(
      (top) => document.querySelector('[role="dialog"] [data-chat-container]').scrollTop < top,
      clickedTop,
    );
    assert.deepEqual(
      await page.evaluate(() => JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:independent-ball')).state),
      { top: 777, anchor: 'offset' },
    );
    const geometryAfter = await sampleStableReadingTarget(page, geometryBefore.offset);
    console.info('[cat-ball-layout-probe]', JSON.stringify({ before: geometryBefore, after: geometryAfter }));
    assert.deepEqual(geometryAfter, geometryBefore);
  } finally {
    await page.close();
  }
});

test('real ChatContainer keeps the reading viewport stable when HTML disclosure changes height', async () => {
  const page = await openFixture();
  try {
    const widget = await activeWidget(page);
    const trigger = widget.getByRole('button', { name: '展开完整内容' });
    const before = await page.evaluate((selector) => {
      const chat = document.querySelector('[data-chat-container]');
      const target = document.querySelector(selector);
      if (!(chat instanceof HTMLElement) || !(target instanceof HTMLElement)) throw new Error('fixture missing');
      chat.scrollTop = chat.scrollHeight - chat.clientHeight - 12;
      chat.dispatchEvent(new Event('scroll', { bubbles: true }));
      return {
        scrollTop: chat.scrollTop,
        bottomGap: chat.scrollHeight - chat.clientHeight - chat.scrollTop,
        widgetTop: target.getBoundingClientRect().top,
      };
    }, WIDGET_SELECTOR);
    assert.ok(before.bottomGap <= 24, `fixture must begin inside the bottom-follow threshold: ${before.bottomGap}`);
    await trigger.waitFor({ state: 'visible' });
    await trigger.click();
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute('data-html-widget-expanded') === 'true',
      WIDGET_SELECTOR,
    );
    await page.waitForTimeout(100);
    const after = await page.evaluate((selector) => {
      const chat = document.querySelector('[data-chat-container]');
      const target = document.querySelector(selector);
      if (!(chat instanceof HTMLElement) || !(target instanceof HTMLElement)) throw new Error('fixture missing');
      return { scrollTop: chat.scrollTop, widgetTop: target.getBoundingClientRect().top };
    }, WIDGET_SELECTOR);
    assert.ok(
      Math.abs(after.widgetTop - before.widgetTop) <= 32,
      `HTML disclosure moved the reading anchor by ${after.widgetTop - before.widgetTop}px (scroll ${before.scrollTop}→${after.scrollTop})`,
    );

    const collapse = widget.getByRole('button', { name: '收起完整内容' });
    await collapse.scrollIntoViewIfNeeded();
    const collapseTop = await collapse.evaluate((button) => button.getBoundingClientRect().top);
    await collapse.click();
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute('data-html-widget-expanded') === 'false',
      WIDGET_SELECTOR,
    );
    await page.waitForTimeout(100);
    const collapsedTop = await widget
      .getByRole('button', { name: '展开完整内容' })
      .evaluate((button) => button.getBoundingClientRect().top);
    assert.ok(
      Math.abs(collapsedTop - collapseTop) <= 32,
      `HTML collapse moved its disclosure trigger by ${collapsedTop - collapseTop}px`,
    );
  } finally {
    await page.close();
  }
});

test('real ChatContainer keeps an inner HTML details summary in place while it expands and collapses', async () => {
  const page = await openFixture();
  try {
    const widget = await activeWidget(page);
    await widget.getByRole('button', { name: '展开完整内容' }).click();
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute('data-html-widget-expanded') === 'true',
      WIDGET_SELECTOR,
    );
    await page.waitForTimeout(100);

    const childFrame = page.frames().find((frame) => frame.parentFrame() === page.mainFrame());
    assert.ok(childFrame, 'sandbox child frame must exist');
    const summary = childFrame.getByText('为什么不是一张 Demo 卡？', { exact: true });
    await summary.waitFor({ state: 'visible' });
    const childSummaryTop = await summary.evaluate((element) => element.getBoundingClientRect().top);
    const before = await page.evaluate(
      ({ childTop, selector }) => {
        const chat = document.querySelector('[data-chat-container]');
        const iframe = document.querySelector(`${selector} iframe`);
        if (!(chat instanceof HTMLElement) || !(iframe instanceof HTMLIFrameElement)) {
          throw new Error('fixture missing');
        }
        const chatRect = chat.getBoundingClientRect();
        chat.scrollTop += iframe.getBoundingClientRect().top + childTop - (chatRect.top + 180);
        chat.dispatchEvent(new Event('scroll', { bubbles: true }));
        return {
          chatBottom: chatRect.bottom,
          chatTop: chatRect.top,
          summaryTop: iframe.getBoundingClientRect().top + childTop,
        };
      },
      { childTop: childSummaryTop, selector: WIDGET_SELECTOR },
    );
    assert.ok(
      before.summaryTop >= before.chatTop && before.summaryTop <= before.chatBottom,
      `fixture must place the inner summary inside the Chat viewport: ${JSON.stringify(before)}`,
    );
    const summaryTopBefore = before.summaryTop;

    await summary.click();
    await childFrame.locator('[data-inner-disclosure][open]').waitFor();
    await page.waitForTimeout(100);
    const summaryTopAfterExpand = await page.evaluate(
      ({ selector, childTop }) => {
        const iframe = document.querySelector(`${selector} iframe`);
        if (!(iframe instanceof HTMLIFrameElement)) throw new Error('iframe missing');
        return iframe.getBoundingClientRect().top + childTop;
      },
      {
        selector: WIDGET_SELECTOR,
        childTop: await summary.evaluate((element) => element.getBoundingClientRect().top),
      },
    );
    assert.ok(
      Math.abs(summaryTopAfterExpand - summaryTopBefore) <= 32,
      `inner HTML disclosure moved the clicked summary by ${summaryTopAfterExpand - summaryTopBefore}px`,
    );

    await summary.click();
    await childFrame.locator('[data-inner-disclosure]:not([open])').waitFor();
    await page.waitForTimeout(100);
    const summaryTopAfterCollapse = await page.evaluate(
      ({ selector, childTop }) => {
        const iframe = document.querySelector(`${selector} iframe`);
        if (!(iframe instanceof HTMLIFrameElement)) throw new Error('iframe missing');
        return iframe.getBoundingClientRect().top + childTop;
      },
      {
        selector: WIDGET_SELECTOR,
        childTop: await summary.evaluate((element) => element.getBoundingClientRect().top),
      },
    );
    assert.ok(
      Math.abs(summaryTopAfterCollapse - summaryTopBefore) <= 32,
      `inner HTML collapse moved the clicked summary by ${summaryTopAfterCollapse - summaryTopBefore}px`,
    );
  } finally {
    await page.close();
  }
});

test('HTML disclosure is session-scoped by thread, stable bubble, block, and content identity', async () => {
  const page = await openFixture();
  try {
    let widget = await activeWidget(page);
    await widget.getByRole('button', { name: '展开完整内容' }).click();
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute('data-html-widget-expanded') === 'true',
      WIDGET_SELECTOR,
    );

    await page.getByTestId('switch-thread-b').click();
    await page.locator('[data-active-thread="rich-html-continuity-b"]').waitFor();
    widget = await activeWidget(page);
    assert.equal(
      await widget.getAttribute('data-html-widget-expanded'),
      'false',
      'same blockId must not leak into Thread B',
    );

    await page.getByTestId('switch-thread-a').click();
    await page.locator('[data-active-thread="rich-html-continuity-a"]').waitFor();
    widget = await activeWidget(page);
    assert.equal(
      await widget.getAttribute('data-html-widget-expanded'),
      'true',
      'Thread A remount must keep expansion',
    );

    await page.getByTestId('replace-widget-content').click();
    await page.locator('[data-widget-version="A-v2"]').waitFor();
    widget = await activeWidget(page);
    assert.equal(
      await widget.getAttribute('data-html-widget-expanded'),
      'false',
      'changed source content must not inherit',
    );
  } finally {
    await page.close();
  }
});

test('sandboxed Rich HTML keeps native selection and copy local without inventing a quote source', async () => {
  const page = await openFixture();
  try {
    const widget = await activeWidget(page);
    assert.equal(await widget.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
    assert.equal((await widget.locator('iframe').getAttribute('sandbox'))?.includes('allow-same-origin'), false);
    await widget.getByRole('button', { name: '展开完整内容' }).click();
    const childFrame = page.frames().find((frame) => frame.parentFrame() === page.mainFrame());
    assert.ok(childFrame, 'sandbox child frame must exist');
    const target = childFrame.locator('[data-native-selection]');
    await target.waitFor({ state: 'visible' });
    await target.scrollIntoViewIfNeeded();
    const iframeBox = await widget.locator('iframe').boundingBox();
    const textRect = await target.evaluate((element) => {
      const node = element.firstChild;
      if (!node?.textContent) throw new Error('native selection text node missing');
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects());
      const first = rects[0];
      const last = rects.at(-1);
      if (!first || !last) throw new Error('native selection glyph rects missing');
      return {
        start: { x: first.left + 1, y: first.top + first.height / 2 },
        end: { x: last.right - 1, y: last.top + last.height / 2 },
      };
    });
    assert.ok(iframeBox, 'native selection iframe must have a real hit box');
    await page.mouse.move(iframeBox.x + textRect.start.x, iframeBox.y + textRect.start.y);
    await page.mouse.down();
    await page.mouse.move(iframeBox.x + textRect.end.x, iframeBox.y + textRect.end.y, { steps: 12 });
    await page.mouse.up();
    const selected = (await childFrame.evaluate(() => window.getSelection()?.toString() ?? '')).trim();
    assert.equal(
      selected,
      'Sandbox native selection remains copyable.',
      `native pointer geometry iframe=${JSON.stringify(iframeBox)} text=${JSON.stringify(textRect)}`,
    );
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
    const copied = await page.evaluate(() =>
      Promise.race([
        navigator.clipboard.readText(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard read timed out')), 2_000)),
      ]),
    );
    assert.equal(copied.trim(), selected);
    assert.equal(
      await page.getByTestId('message-selection-add-to-chat').count(),
      0,
      'opaque iframe text has no replayable parent quote projection and must fail closed',
    );
  } finally {
    await page.close();
  }
});

test('real mouse selection on the final CLI signature exposes quote and forward, but excluded text still refuses', async () => {
  const page = await openFixture();
  try {
    await page.setViewportSize({ width: 1093, height: 798 });
    const message = page.locator('[data-message-id="continuity-cli-final-message"]');
    await page.evaluate(() => {
      const chat = document.querySelector('[data-chat-container]');
      if (!(chat instanceof HTMLElement)) throw new Error('chat container missing');
      chat.scrollTop = chat.scrollHeight;
      chat.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await message.scrollIntoViewIfNeeded();
    if ((await message.locator('[data-context-quote-segment-id="stdout"]').count()) === 0) {
      await message.getByRole('button', { name: /CLI Output/ }).click();
      await message.locator('[data-context-quote-segment-id="stdout"]').waitFor({ state: 'visible' });
    }
    await message.getByText(CLI_SIGNATURE, { exact: true }).scrollIntoViewIfNeeded();
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const geometry = await message.evaluate((root, signature) => {
      const segment = root.querySelector('[data-context-quote-segment-id="stdout"]');
      if (!segment) throw new Error('stdout segment missing');
      const walker = document.createTreeWalker(segment, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.textContent?.includes(signature)) node = walker.nextNode();
      if (!node?.textContent) throw new Error('signature text missing');
      const start = node.textContent.indexOf(signature);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + signature.length);
      const rects = Array.from(range.getClientRects());
      const first = rects[0];
      const last = rects.at(-1);
      if (!first || !last) throw new Error('signature glyph rects missing');
      const segmentRect = segment.getBoundingClientRect();
      return {
        start: { x: first.left + 1, y: first.top + first.height / 2 },
        // Mirror the reported last-line gesture: the pointer can land just below stdout's
        // painted box even though Chromium selects no message text beyond the signature.
        end: { x: last.right + 8, y: segmentRect.bottom + 3 },
      };
    }, CLI_SIGNATURE);
    await page.mouse.move(geometry.start.x, geometry.start.y);
    await page.mouse.down();
    await page.mouse.move(geometry.end.x, geometry.end.y, { steps: 16 });
    await page.mouse.up();
    const selected = (await page.evaluate(() => window.getSelection()?.toString() ?? '')).trim();
    assert.equal(selected, CLI_SIGNATURE, `real pointer selection must match the visible final line, got ${selected}`);

    const quote = page.getByTestId('message-selection-add-to-chat');
    await quote.waitFor({ state: 'visible' });
    await quote.click();
    await page.getByTestId('context-annotation-editor').waitFor({ state: 'visible' });
    const forward = page.getByTestId('context-annotation-forward');
    await forward.waitFor({ state: 'visible' });
    await forward.click();
    const dialog = page.getByRole('dialog', { name: '转发到' });
    await dialog.waitFor({ state: 'visible' });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();

    const excludedMessage = page.locator('[data-message-id="continuity-excluded-selection-message"]');
    await excludedMessage.scrollIntoViewIfNeeded();
    const excludedGeometry = await excludedMessage.evaluate((root) => {
      const paragraph = root.querySelector('p');
      const excluded = root.querySelector('[data-testid="mermaid-diagram"][data-quote-exclude]');
      if (!paragraph || !excluded) throw new Error('excluded selection fixture missing');
      const textWalker = document.createTreeWalker(excluded, NodeFilter.SHOW_TEXT);
      let excludedText = textWalker.nextNode();
      while (excludedText && !excludedText.textContent?.trim()) excludedText = textWalker.nextNode();
      const paragraphRange = document.createRange();
      paragraphRange.selectNodeContents(paragraph);
      const excludedRange = document.createRange();
      if (!excludedText?.textContent) throw new Error('excluded rendered text missing');
      excludedRange.selectNodeContents(excludedText);
      const paragraphRect = paragraphRange.getBoundingClientRect();
      const excludedRect = excludedRange.getBoundingClientRect();
      return {
        start: { x: paragraphRect.left + 2, y: paragraphRect.top + paragraphRect.height / 2 },
        end: { x: excludedRect.right - 2, y: excludedRect.top + excludedRect.height / 2 },
        excludedText: excludedText.textContent.trim(),
      };
    });
    await page.mouse.move(excludedGeometry.start.x, excludedGeometry.start.y);
    await page.mouse.down();
    await page.mouse.move(excludedGeometry.end.x, excludedGeometry.end.y, {
      steps: 18,
    });
    await page.mouse.up();
    const crossSelected = (await page.evaluate(() => window.getSelection()?.toString() ?? '')).trim();
    assert.ok(
      crossSelected.includes(excludedGeometry.excludedText),
      `fixture must truly select excluded copy: ${crossSelected}`,
    );
    await page.waitForTimeout(100);
    assert.equal(await page.getByTestId('message-selection-add-to-chat').count(), 0);
  } finally {
    await page.close();
  }
});
