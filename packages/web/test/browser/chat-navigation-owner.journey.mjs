import assert from 'node:assert/strict';
import { test } from 'node:test';

export function registerNavigationOwnerJourneys({ origin, browser, bundle }) {
  const threadId = 'chat-recovery';
  const records = Array.from({ length: 16 }, (_, index) => ({
    id: `nav-${index + 1}`,
    type: 'assistant',
    catId: 'opus',
    timestamp: index + 1,
    content: `Navigation message ${index + 1}: ${'A real rendered row. '.repeat(8)}`,
  }));
  async function open() {
    const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin, 'never reach a live service');
      if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: bundle() });
      if (url.pathname.startsWith('/api/')) {
        const body =
          url.pathname === '/api/messages'
            ? {
                messages:
                  url.searchParams.get('threadId') === 'chat-other' ? [{ ...records[0], id: 'other' }] : records,
                hasMore: false,
              }
            : { cats: [], tasks: [], queue: [], activeInvocations: [] };
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><style>
        [data-navigation-control] {position:absolute;right:2px;top:0;width:20px;height:600px}
        [data-navigation-control] > div, [data-navigation-control] .cursor-pointer {height:600px;position:relative}
        [data-navigation-control] button {position:absolute;width:10px;height:10px;padding:0;transform:translate(-50%,-50%)}
        </style><div id="root"></div><script type="module" src="/proof.js"></script>`,
      });
    });
    await page.goto(`${origin}/${threadId}?navigation=1`);
    await page.locator('[data-message-id="nav-16"]').waitFor();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-scroll-chat]');
      return el && Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 1;
    });
    return { page, errors };
  }
  async function geometry(page, id) {
    return page.evaluate((id) => {
      const el = document.querySelector('[data-scroll-chat]');
      const row = el.querySelector(`[data-message-viewport-id="${id}"]`);
      const saved = JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:chat-recovery')).state;
      return { top: el.scrollTop, offset: row.getBoundingClientRect().top - el.getBoundingClientRect().top, saved };
    }, id);
  }
  test('navigator message jump becomes a reading anchor across Back and cold refresh', async () => {
    const { page, errors } = await open();
    try {
      await page.locator('[data-navigation-control] button').nth(3).click();
      await page.waitForFunction(() => {
        const saved = JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:chat-recovery')).state;
        return saved.anchor === 'offset' && saved.messageAnchor?.messageId === 'nav-4';
      });
      const before = await geometry(page, 'nav-4');
      assert.equal(before.saved.anchor, 'offset');
      assert(Math.abs(before.offset - before.saved.messageAnchor.viewportOffsetPx) <= 1);
      await page.getByRole('button', { name: 'Other thread', exact: true }).click();
      await page.locator('[data-message-id="other"]').waitFor();
      await page.goBack();
      await page.waitForFunction(
        (top) => Math.abs(document.querySelector('[data-scroll-chat]').scrollTop - top) <= 1,
        before.top,
      );
      assert.deepEqual(await geometry(page, 'nav-4'), before);
      await page.reload();
      await page.waitForFunction(
        (top) => Math.abs(document.querySelector('[data-scroll-chat]').scrollTop - top) <= 1,
        before.top,
      );
      assert.deepEqual(await geometry(page, 'nav-4'), before);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
  test('navigator wheel and background clicks update reading geometry through the user-input owner', async () => {
    const { page, errors } = await open();
    try {
      const track = page.locator('[data-navigation-control] .cursor-pointer');
      await track.hover({ position: { x: 10, y: 150 } });
      const before = await page.locator('[data-scroll-chat]').evaluate((el) => el.scrollTop);
      await page.mouse.wheel(0, -200);
      await page.waitForFunction((top) => document.querySelector('[data-scroll-chat]').scrollTop < top, before);
      const afterWheel = await page.locator('[data-scroll-chat]').evaluate((el) => el.scrollTop);
      assert.equal(afterWheel, before - 200);
      assert.equal(
        await page.evaluate(
          () => JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:chat-recovery')).state.anchor,
        ),
        'offset',
      );
      await track.click({ position: { x: 15, y: 150 } });
      const saved = await page.evaluate(
        () => JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:chat-recovery')).state,
      );
      assert.equal(saved.anchor, 'offset');
      assert.equal(saved.top, await page.locator('[data-scroll-chat]').evaluate((el) => el.scrollTop));
      assert(saved.top < afterWheel);
      const row = await geometry(page, saved.messageAnchor.messageId);
      assert(Math.abs(row.offset - saved.messageAnchor.viewportOffsetPx) <= 1);
      assert.equal(await page.evaluate(() => window.scrollY), 0, 'wheel must not scroll the page');
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}
