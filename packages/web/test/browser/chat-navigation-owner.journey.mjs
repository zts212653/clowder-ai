import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

export function registerNavigationOwnerJourneys({ origin, browser, bundle }) {
  const threadId = 'chat-recovery';
  const records = Array.from({ length: 16 }, (_, index) => ({
    from: { kind: 'agent', catId: 'opus' },
    id: `nav-${index + 1}`,
    type: 'assistant',
    catId: 'opus',
    timestamp: index + 1,
    content: `Navigation message ${index + 1}: ${'A real rendered row. '.repeat(8)}`,
  }));
  async function open({ presentation = 'classic', lateLayout = false } = {}) {
    const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    let releaseLateImage;
    const lateImage = new Promise((resolve) => {
      releaseLateImage = resolve;
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((mode) => localStorage.setItem('cat-cafe:shell-presentation', mode), presentation);
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin, 'never reach a live service');
      if (url.pathname === '/late-navigation.svg')
        return lateImage.then(() =>
          route.fulfill({
            contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="320"><rect width="400" height="320" fill="#91b3a5"/></svg>',
          }),
        );
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
        [data-message-piano] {position:absolute;right:0;top:8px;bottom:8px;width:24px}
        [data-message-piano-key] {position:absolute;right:8px}
        [data-message-piano-key] > div {position:absolute;left:0;right:0}
        [data-message-piano-thumb], [data-message-piano-grab] {position:absolute;right:2px}
        [data-message-piano-thumb] {pointer-events:none;border:1px solid #333}
        [data-message-piano-grab] {z-index:0}
        [data-message-jump-focus="true"] {box-shadow:0 0 0 2px rgb(96 165 250)}
        </style><div id="root"></div><script type="module" src="/proof.js"></script>`,
      });
    });
    await page.goto(`${origin}/${threadId}?navigation=1${lateLayout ? '&late-layout=1' : ''}`, {
      waitUntil: lateLayout ? 'domcontentloaded' : 'load',
    });
    await page.locator('[data-message-id="nav-16"]').waitFor();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-scroll-chat]');
      return el && Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 1;
    });
    return { page, errors, releaseLateImage };
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

  for (const lateLayout of [false, true]) {
    test(
      lateLayout
        ? 'v2 arrival keeps its full hint through native late-image resize and reading correction'
        : 'v2 native navigator click lands on the exact visible highlighted source before its hint expires',
      async () => {
        const { page, errors, releaseLateImage } = await open({ presentation: 'v2', lateLayout });
        try {
          await page.evaluate(() => {
            const samples = [];
            window.navigationHighlightSamples = samples;
            const tokens = new WeakMap();
            let nextToken = 0;
            const token = (node) => {
              if (!tokens.has(node)) tokens.set(node, ++nextToken);
              return tokens.get(node);
            };
            const viewport = document.querySelector('[data-scroll-chat]');
            const resolve = () => viewport.querySelector('[data-message-id="nav-4"]');
            const changes = [];
            window.navigationHighlightNodeChanges = changes;
            const start = performance.now();
            const observer = new MutationObserver((records) => {
              for (const record of records) {
                const nodes =
                  record.type === 'attributes' ? [record.target] : [...record.removedNodes, ...record.addedNodes];
                for (const node of nodes) {
                  if (!(node instanceof HTMLElement)) continue;
                  if (record.type === 'attributes' && !node.matches('[data-message-id="nav-4"]')) continue;
                  const target = node.matches('[data-message-id="nav-4"]')
                    ? node
                    : node.querySelector('[data-message-id="nav-4"]');
                  if (!target) continue;
                  changes.push({
                    time: performance.now() - start,
                    kind: record.type,
                    nodeToken: token(target),
                    currentNodeToken: resolve() ? token(resolve()) : null,
                    isConnected: target.isConnected,
                    oldClass: record.oldValue,
                    currentClass: target.className,
                  });
                }
              }
            });
            observer.observe(viewport, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['data-message-jump-focus'],
              attributeOldValue: true,
            });
            window.navigationHighlightObserver = observer;
            const sample = () => {
              const viewport = document.querySelector('[data-scroll-chat]');
              const target = viewport.querySelector('[data-message-id="nav-4"]');
              if (!target) {
                samples.push({
                  time: performance.now() - start,
                  nodeToken: null,
                  isConnected: false,
                  matchingNodeCount: 0,
                  visible: false,
                  highlighted: false,
                });
                if (performance.now() - start < 4000) requestAnimationFrame(sample);
                return;
              }
              const box = target.getBoundingClientRect(),
                view = viewport.getBoundingClientRect();
              samples.push({
                time: performance.now() - start,
                top: box.top,
                bottom: box.bottom,
                viewportTop: view.top,
                viewportBottom: view.bottom,
                visible: box.bottom > view.top && box.top < view.bottom,
                highlighted: target.dataset.messageJumpFocus === 'true',
                scrollTop: viewport.scrollTop,
                nodeToken: token(target),
                isConnected: target.isConnected,
                matchingNodeCount: viewport.querySelectorAll('[data-message-id="nav-4"]').length,
              });
              if (performance.now() - start < 4000) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          });
          await page.locator('[data-message-piano-key="nav-4"]').click();
          await page.waitForFunction(() => {
            const viewport = document.querySelector('[data-scroll-chat]');
            const target = viewport.querySelector('[data-message-id="nav-4"]');
            const box = target.getBoundingClientRect(),
              view = viewport.getBoundingClientRect();
            const saved = JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:chat-recovery')).state;
            return (
              box.bottom > view.top &&
              box.top < view.bottom &&
              target.dataset.messageJumpFocus === 'true' &&
              saved.messageAnchor?.messageId === 'nav-4'
            );
          });
          let landed = await geometry(page, 'nav-4');
          const beforeLayout = landed;
          if (lateLayout) {
            releaseLateImage();
            await page.waitForFunction(() => {
              const image = document.querySelector('[data-navigation-late-image]');
              return image?.complete && image.naturalHeight === 320;
            });
            await page.waitForFunction((offset) => {
              const viewport = document.querySelector('[data-scroll-chat]');
              const row = viewport.querySelector('[data-message-viewport-id="nav-4"]');
              return Math.abs(row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset) <= 1;
            }, beforeLayout.offset);
            landed = await geometry(page, 'nav-4');
            assert.equal(landed.saved.messageAnchor.messageId, 'nav-4');
            assert(
              Math.abs(landed.offset - beforeLayout.offset) <= 1,
              'the existing reading owner corrects late geometry',
            );
          }
          const evidenceDir = process.env.CAT_CAFE_NAVIGATION_EVIDENCE_DIR;
          const evidenceName = lateLayout ? 'v2-native-layout-highlight' : 'v2-visible-highlight';
          if (evidenceDir) {
            await mkdir(evidenceDir, { recursive: true });
            await page.screenshot({ path: path.join(evidenceDir, `${evidenceName}.png`) });
          }
          await page.waitForFunction(
            () => document.querySelector('[data-message-id="nav-4"]').dataset.messageJumpFocus !== 'true',
          );
          const samples = await page.evaluate(() => window.navigationHighlightSamples);
          const nodeChanges = await page.evaluate(() => {
            window.navigationHighlightObserver.disconnect();
            return window.navigationHighlightNodeChanges;
          });
          const highlighted = samples.filter((sample) => sample.highlighted);
          assert(highlighted.length > 0, 'record an actual visible/highlight frame');
          assert(
            highlighted.every((sample) => sample.visible),
            'the hint starts on a visible target',
          );
          assert(
            highlighted.at(-1).time - highlighted[0].time >= 1400,
            'arrival receives the original 1500ms interval',
          );
          assert.deepEqual(await geometry(page, 'nav-4'), landed, 'highlight expiry never writes reading state');
          assert.deepEqual(errors, []);
          if (evidenceDir)
            await writeFile(
              path.join(evidenceDir, `${evidenceName}.json`),
              JSON.stringify({ beforeLayout, landed, samples, nodeChanges, errors }, null, 2),
            );
        } finally {
          releaseLateImage();
          await page.close();
        }
      },
    );
  }
}
