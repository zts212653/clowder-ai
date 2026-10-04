import assert from 'node:assert/strict';
import { test } from 'node:test';

const missing = (timelineOrderAt) => ({
  top: 3000,
  anchor: 'offset',
  messageAnchor: { messageId: 'scroll-55', viewportOffsetPx: -20, timelineOrderAt },
});

export function registerReadingLandingJourneys(context) {
  const key = `cat-cafe:thread-scroll:${context.threadId}`;
  async function open(state, deleted = true, short = false) {
    const page = await context.browser().newPage({ viewport: { width: 1440, height: 900 } });
    let records = Array.from({ length: 80 }, (_, index) => ({
      id: `scroll-${index + 1}`,
      type: 'assistant',
      catId: 'codex-astra',
      timestamp: index + 1,
      content: `Reading message ${index + 1}\n${'Long conversation evidence. '.repeat(40)}`,
    }));
    const errors = [],
      cursors = [];
    const remove = () => {
      records = records.filter((message) => message.id !== 'scroll-55');
    };
    if (deleted) remove();
    if (short) records = records.filter((message) => message.timestamp >= 79);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, context.origin);
      assert.equal(route.request().method(), 'GET');
      if (url.pathname === '/proof.js')
        return route.fulfill({ contentType: 'text/javascript', body: context.bundle() });
      if (url.pathname.startsWith('/api/')) {
        let body = { userId: 'fixture-owner', tasks: [], cats: [], activeInvocations: [], queue: [] };
        if (url.pathname === '/api/messages') {
          const cursor = url.searchParams.get('before');
          cursors.push(cursor);
          body =
            url.searchParams.get('threadId') === 'chat-other'
              ? { messages: [{ ...records[0], id: 'other' }], hasMore: false }
              : {
                  messages: cursor
                    ? records.filter((message) => message.timestamp <= 30)
                    : records.filter((message) => message.timestamp > 30),
                  hasMore: !cursor && !short,
                };
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><style>[data-message-viewport-boundary]{content-visibility:auto}article{box-sizing:border-box}</style><div id="root"></div><script type="module" src="/proof.js"></script>',
      });
    });
    if (state)
      await page.addInitScript(
        ([key, state]) => {
          if (!sessionStorage.getItem('seeded')) {
            localStorage.setItem(key, JSON.stringify({ v: 1, state }));
            sessionStorage.setItem('seeded', '1');
          }
        },
        [key, state],
      );
    await page.goto(`${context.origin}/${context.threadId}?scroll=1`);
    await page.locator('[data-message-id="scroll-80"]').waitFor();
    await page.waitForTimeout(750);
    return { page, remove, cursors, errors };
  }
  async function sample(page) {
    return page.locator('[data-scroll-chat]').evaluate((el, key) => {
      const viewport = el.getBoundingClientRect();
      const row = [...el.querySelectorAll('[data-message-viewport-id]')].find(
        (node) => node.getBoundingClientRect().bottom > viewport.top,
      );
      return {
        id: row?.dataset.messageViewportId,
        offset: row?.getBoundingClientRect().top - viewport.top,
        top: el.scrollTop,
        gap: el.scrollHeight - el.clientHeight - el.scrollTop,
        saved: JSON.parse(localStorage.getItem(key))?.state,
      };
    }, key);
  }
  for (const [name, state, expectedId, short] of [
    ['deleted with coordinate', missing(55), 'scroll-56'],
    ['legacy without coordinate', missing(undefined), undefined],
    ['no newer survivor', missing(1000), undefined],
    ['no record control', undefined, undefined],
    ['short page without scrolling space', missing(undefined), undefined, true],
  ]) {
    test(`absent reading anchor: cold landing and durable reload / ${name}`, async () => {
      const { page, cursors, errors } = await open(state, true, short);
      try {
        const landed = await sample(page);
        console.log(JSON.stringify({ name, landed, olderFetches: cursors.filter(Boolean).length }));
        if (expectedId) {
          assert.equal(landed.id, expectedId);
          assert.ok(Math.abs(landed.offset + 20) <= 1, JSON.stringify(landed));
          assert.equal(landed.saved.messageAnchor.messageId, expectedId);
        } else {
          assert.ok(landed.gap <= 1, JSON.stringify(landed));
          assert.equal(landed.saved.anchor, 'bottom');
        }
        assert.equal(cursors.filter(Boolean).length, 0);
        await page.reload();
        await page.locator('[data-message-id="scroll-80"]').waitFor();
        await page.waitForTimeout(750);
        const reloaded = await sample(page);
        assert.equal(reloaded.id, landed.id);
        assert.ok(Math.abs(reloaded.offset - landed.offset) <= 1, JSON.stringify({ landed, reloaded }));
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  }
  test('deleted reading anchor: real owner deletion, Other thread, Back and reload', async () => {
    const { page, remove, errors } = await open(undefined, false);
    try {
      await page.locator('[data-scroll-chat]').evaluate((el) => {
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
        const target = el.querySelector('[data-message-viewport-id="scroll-55"]');
        el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top + 20;
      });
      await page.waitForTimeout(100);
      assert.equal((await sample(page)).saved.messageAnchor.messageId, 'scroll-55');
      await page.getByRole('button', { name: 'Delete reading message', exact: true }).click();
      remove();
      await page.getByRole('button', { name: 'Other thread', exact: true }).click();
      await page.locator('[data-message-id="other"]').waitFor();
      await page.goBack();
      await page.locator('[data-message-id="scroll-56"]').waitFor();
      await page.waitForTimeout(750);
      const back = await sample(page);
      assert.equal(back.id, 'scroll-56');
      assert.ok(Math.abs(back.offset + 20) <= 1, JSON.stringify(back));
      assert.equal(back.saved.messageAnchor.messageId, 'scroll-56');
      await page.reload();
      await page.locator('[data-message-id="scroll-56"]').waitFor();
      await page.waitForTimeout(750);
      const reloaded = await sample(page);
      assert.equal(reloaded.id, back.id);
      assert.ok(Math.abs(reloaded.offset - back.offset) <= 1, JSON.stringify({ back, reloaded }));
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}
