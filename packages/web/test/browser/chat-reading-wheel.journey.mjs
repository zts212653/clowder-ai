import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

async function dragHeldScrollbar(page, viewport, sample, observations) {
  await page.addStyleTag({
    content: `
    [data-scroll-chat] { scrollbar-gutter: stable; }
    [data-scroll-chat]::-webkit-scrollbar { width: 16px; }
    [data-scroll-chat]::-webkit-scrollbar-thumb { background: #888; }
  `,
  });
  await viewport.evaluate((el) => {
    window.__heldScrollbarEvents = [];
    for (const type of ['pointerdown', 'pointerup', 'pointermove', 'scroll', 'scrollend']) {
      el.addEventListener(type, (event) => {
        window.__heldScrollbarEvents.push({ type, trusted: event.isTrusted, top: el.scrollTop });
      });
    }
  });
  const thumb = await viewport.evaluate((el) => {
    const bounds = el.getBoundingClientRect();
    const gutter = el.offsetWidth - el.clientWidth;
    return {
      gutter,
      x: bounds.right - gutter / 2,
      y: bounds.top + (el.scrollTop / el.scrollHeight) * el.clientHeight + el.clientHeight ** 2 / el.scrollHeight / 2,
    };
  });
  assert.ok(thumb.gutter > 0, 'the real native scrollbar must be available for this drag');
  await page.mouse.move(thumb.x, thumb.y);
  await page.mouse.down();
  let releaseBefore;
  try {
    await page.waitForFunction(() =>
      window.__heldScrollbarEvents.some((event) => event.type === 'pointerdown' && event.trusted),
    );
    // Human delay before moving, and pauses between drag segments, are part of
    // the failure story. No scrollTop assignment or synthetic pointer input.
    await page.waitForTimeout(300);
    for (const distance of [4, 8, 12]) {
      const before = await sample();
      await page.mouse.move(thumb.x, thumb.y - distance);
      await page.waitForTimeout(150);
      const moved = await sample();
      assert.ok(
        moved.top < before.top - 1,
        `each resumed thumb drag must move upward: ${JSON.stringify({
          thumb,
          distance,
          before,
          moved,
          events: await page.evaluate(() => window.__heldScrollbarEvents),
        })}`,
      );
      await page.getByRole('button', { name: 'Passive update', exact: true }).evaluate((button) => button.click());
      await page.waitForTimeout(100);
      const passive = await sample();
      assert.equal(
        passive.markerTop,
        moved.markerTop,
        'layout while the thumb is still held must keep its new position',
      );
      observations.push(moved, passive);
    }
    // The thumb has moved several records. Pin the new top-visible reading
    // message for release/reflow, rather than an old record farther down whose
    // intervening content-visibility estimates can legitimately change height.
    const readingId = await viewport.evaluate((el) => {
      const bounds = el.getBoundingClientRect();
      return document
        .elementFromPoint(bounds.left + 32, bounds.top + 1)
        ?.closest('[data-message-viewport-id]')
        ?.getAttribute('data-message-viewport-id');
    });
    assert.ok(readingId, 'the final drag position must contain a real reading message');
    releaseBefore = await sample(readingId);
  } finally {
    await page.mouse.up();
  }
  await page.waitForTimeout(100);
  const releaseAfter = await sample(releaseBefore.markerId);
  observations.push(releaseBefore, releaseAfter);
  assert.equal(
    releaseAfter.markerTop,
    releaseBefore.markerTop,
    `releasing the thumb must preserve the new reading message: ${JSON.stringify({ releaseBefore, releaseAfter, events: await page.evaluate(() => window.__heldScrollbarEvents) })}`,
  );
  const events = await page.evaluate(() => window.__heldScrollbarEvents);
  assert.ok(
    events.some((event) => event.type === 'scroll' && event.trusted),
    'the drag must produce real native scrolling',
  );
  observations.push({ events });
}

export function registerReadingWheelJourneys(context) {
  for (const { mode, delta, earlyEnd, heldPointer = false } of [
    { mode: 'offset', delta: -32, earlyEnd: null },
    { mode: 'near-bottom', delta: -2, earlyEnd: null },
    { mode: 'offset', delta: -32, earlyEnd: 'before-observation' },
    { mode: 'offset', delta: 32, earlyEnd: 'before-observation' },
    { mode: 'near-bottom', delta: -2, earlyEnd: 'before-observation' },
    { mode: 'offset', delta: -32, earlyEnd: 'before-pixels' },
    { mode: 'offset', delta: 32, earlyEnd: 'before-pixels' },
    { mode: 'offset', delta: -32, earlyEnd: null, heldPointer: true },
  ]) {
    const direction = delta < 0 ? 'upward' : 'downward';
    const ending = earlyEnd ? ` with scrollend ${earlyEnd}` : '';
    const control = heldPointer ? 'held scrollbar' : 'wheels';
    test(`trusted ${mode} ${direction} ${control} keep their pixels across passive commits${ending}`, async () => {
      const nativeBrowser = heldPointer ? await context.launchNativeScrollbarBrowser() : null;
      const page = await (nativeBrowser ?? context.browser()).newPage({ viewport: { width: 1000, height: 900 } });
      const errors = [];
      const observations = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => {
        window.__readingWheelInputs = [];
        document.addEventListener('wheel', (event) => {
          window.__readingWheelInputs.push({ trusted: event.isTrusted, deltaY: event.deltaY });
          if (window.__readingEarlyEnd === 'before-pixels' && event.target instanceof Element) {
            event.target.closest('[data-scroll-chat]')?.dispatchEvent(new Event('scrollend'));
          }
        });
        // Replay a queued completion at the native-pixel/React-observation
        // boundary. The wheel default action and resulting layout remain real.
        document.addEventListener(
          'scroll',
          (event) => {
            if (
              window.__readingEarlyEnd === 'before-observation' &&
              event.target instanceof HTMLElement &&
              event.target.matches('[data-scroll-chat]')
            ) {
              event.target.dispatchEvent(new Event('scrollend'));
            }
          },
          true,
        );
      });
      const records = Array.from({ length: 80 }, (_, index) => ({
        id: `scroll-${index + 1}`,
        from: { kind: 'agent', catId: 'codex-astra' },
        catId: 'codex-astra',
        type: 'assistant',
        content: `Reading message ${index + 1}`,
        timestamp: index + 1,
      }));
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        assert.equal(url.origin, context.origin);
        assert.equal(route.request().method(), 'GET');
        if (url.pathname === '/proof.js') {
          return route.fulfill({ contentType: 'text/javascript', body: context.bundle() });
        }
        if (url.pathname.startsWith('/api/')) {
          return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(
              url.pathname === '/api/messages'
                ? { messages: records, hasMore: false }
                : { userId: 'fixture-owner', tasks: [], cats: [], activeInvocations: [], queue: [] },
            ),
          });
        }
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><style>[data-message-viewport-boundary]{display:flow-root;content-visibility:auto}article{box-sizing:border-box}</style><div id="root"></div><script type="module" src="/proof.js"></script>',
        });
      });
      const evidenceDir = process.env.CHAT_SCROLL_EVIDENCE_DIR;
      if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
      try {
        await page.goto(`${context.origin}/${context.threadId}?scroll=1&revalidateAtScroll=1`);
        await page.locator('[data-message-id="scroll-80"]').waitFor();
        await page.waitForTimeout(750);
        const viewport = page.locator('[data-scroll-chat]');
        await viewport.hover();
        if (mode === 'offset') {
          await page.mouse.wheel(0, -400);
          await page.waitForTimeout(350);
        }
        await page.evaluate((enabled) => {
          window.__readingEarlyEnd = enabled;
        }, earlyEnd);
        const markerId = await viewport.evaluate((el) => {
          const bounds = el.getBoundingClientRect();
          return document
            .elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
            ?.closest('[data-message-viewport-id]')
            ?.getAttribute('data-message-viewport-id');
        });
        assert.ok(markerId, 'a real visible message is the reading coordinate');
        const sample = (readingId = markerId) =>
          viewport.evaluate(
            (el, id) => ({
              top: el.scrollTop,
              height: el.scrollHeight,
              markerId: id,
              markerTop: el.querySelector(`[data-message-viewport-id="${id}"]`).getBoundingClientRect().top,
              revalidations: Number(el.dataset.revalidationCount ?? 0),
            }),
            readingId,
          );
        const before = await sample();
        observations.push(before);
        if (heldPointer) await dragHeldScrollbar(page, viewport, sample, observations);
        for (let index = 0; !heldPointer && index < 4; index += 1) {
          await page.mouse.wheel(0, delta);
          await page.waitForTimeout(350);
          const after = await sample();
          observations.push(after);
          const previous = observations.at(-2);
          if (delta < 0)
            assert.ok(after.revalidations > previous.revalidations, 'the real store committed before React scroll');
          // Offscreen content-visibility estimates can shrink while scrolling.
          // The visible message must move by the wheel delta after compensation.
          assert.ok(
            Math.abs(after.markerTop - previous.markerTop + delta) <= 0.5,
            'every gesture moves the visible reading message by its native delta',
          );
        }
        await page.getByRole('button', { name: 'Passive update', exact: true }).click();
        await page.waitForTimeout(350);
        const settled = observations.findLast((item) => item.markerTop !== undefined);
        const passive = await sample(settled.markerId);
        assert.equal(
          passive.markerTop,
          settled.markerTop,
          'a later update does not reclaim the visible reading position',
        );
        observations.push(passive);
        const inputs = await page.evaluate(() => window.__readingWheelInputs);
        assert.ok(inputs.every((input) => input.trusted));
        if (!heldPointer) assert.ok(inputs.length >= 4 && inputs.slice(-4).every((input) => input.deltaY === delta));
        assert.deepEqual(errors, []);
      } finally {
        if (evidenceDir) {
          const name = `${mode}-${direction}${earlyEnd ? `-${earlyEnd}` : ''}-${heldPointer ? 'scrollbar' : 'wheel'}`;
          await page.screenshot({ path: path.join(evidenceDir, `${name}.png`) });
          writeFileSync(path.join(evidenceDir, `${name}.json`), JSON.stringify({ observations, errors }));
        }
        await page.close();
        await nativeBrowser?.close();
      }
    });
  }
}
