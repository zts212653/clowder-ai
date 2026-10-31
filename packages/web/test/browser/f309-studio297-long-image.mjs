import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { THREAD_ID } from './f309-ordinary-workspace-journey-fixture.mjs';
import { routeThroughRealOwner, startRealWorkspaceOwner } from './f309-ordinary-workspace-real-owner.mjs';
import { startWorkspaceNetworkProxy } from './f309-workspace-network-proxy.mjs';

const evidence = process.env.F309_LONG_IMAGE_EVIDENCE_DIR ?? '/tmp/cat-cafe-evidence/f309-studio297-long';
const sha = '43bd6445884b1825c75f417e8437334f52776dc8606b950826bd71c2cd93563c';
// Same bytes as Studio Human035's first image, explicitly supplied for this private viewport test.
// The original message/upload and parent's owners are never touched; this is a separate authentic F063 file owner.
export function registerStudio297LongImageJourneys(suite) {
  for (const presentation of [
    { name: 'desktop-light', viewport: { width: 1280, height: 900 }, dark: false },
    { name: '390-dark', viewport: { width: 390, height: 844 }, dark: true },
  ])
    test(
      `image long: original035 bytes at 100% scroll to the last line and keep exact region coordinates ${presentation.name}`,
      { timeout: 90_000 },
      async () => {
        await mkdir(evidence, { recursive: true });
        const data = await mkdtemp('/tmp/f309-long-owner-');
        const owner = await startRealWorkspaceOwner(data);
        const dir = await mkdtemp(path.join(owner.root, 'f309-long-private-'));
        const context = await suite().browser.newContext({ viewport: presentation.viewport });
        let proxy;
        const errors = [],
          sent = [];
        try {
          const bytes = await readFile(
            new URL(
              '../../../../docs/evidence/2026-10-12-f309-studio297-image/fixtures/original035-long.png',
              import.meta.url,
            ),
          );
          assert.equal(createHash('sha256').update(bytes).digest('hex'), sha);
          assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [840, 1552]);
          await writeFile(path.join(dir, 'original035-long.png'), bytes);
          const inventory = await fetch(`${owner.api}/api/workspace/worktrees`).then((response) => response.json());
          const worktree = inventory.worktrees.find((item) => item.root === owner.root);
          assert.ok(worktree);
          const relative = `${path.basename(dir)}/original035-long.png`;
          const url = `/api/workspace/file/raw?${new URLSearchParams({ worktreeId: worktree.id, path: relative })}`;
          const messages = [
            {
              from: { kind: 'user', userId: 'operator' },
              id: 'private-long-source',
              type: 'user',
              content: '',
              timestamp: 1,
              contentBlocks: [{ type: 'image', url }],
            },
          ];
          proxy = await startWorkspaceNetworkProxy(suite().baseUrl, owner.api);
          await context.addInitScript((dark) => {
            localStorage.clear();
            if (dark) localStorage.setItem('theme', 'dark');
          }, presentation.dark);
          await routeThroughRealOwner(context, owner, {
            extra: async (route, requestUrl) => {
              if (requestUrl.pathname !== '/api/messages') return false;
              if (route.request().method() === 'POST') sent.push(route.request().postDataJSON());
              await route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ messages, hasMore: false }),
              });
              return true;
            },
          });
          const page = await context.newPage();
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(`${proxy.baseUrl}?shell=v2`, { waitUntil: 'domcontentloaded' });
          await page.locator('[data-testid="workspace-panel-toggle"][data-client-interactive="true"]').waitFor();
          const composer = page.getByLabel('消息输入框');
          await composer.fill('长图原草稿\n不替我发送');
          await page.getByRole('button', { name: '打开作品 图片', exact: true }).click();
          const surface = page.locator('[data-testid="workspace-content-review-surface"]:visible');
          await surface.getByTestId('workspace-content-review-media').waitFor({ timeout: 30_000 });
          const image = surface.locator('img');
          await image.evaluate((element) => element.decode());
          assert.deepEqual(
            await image.evaluate((element) => [element.naturalWidth, element.naturalHeight]),
            [840, 1552],
          );
          const scaleMenu = surface.getByLabel('作品缩放和平移', { exact: true });
          await scaleMenu.click();
          await surface.getByRole('button', { name: '100%', exact: true }).click({ timeout: 4000 });
          await scaleMenu.click();
          const stage = surface.getByTestId('review-media-stage');
          const viewport = surface.getByRole('region', { name: '作品画面', exact: true });
          const start = await stage.boundingBox(),
            bounds = await viewport.boundingBox();
          assert.ok(start && bounds);
          assert.ok(Math.abs(start.x - bounds.x) <= 1, '100% starts at the original left edge');
          assert.ok(
            Math.abs(start.y - bounds.y) <= 1,
            `100% starts at the original first line: ${JSON.stringify({ start, bounds })}`,
          );
          assert.equal(Math.round(start.width), 840);
          assert.equal(Math.round(start.height), 1552);
          await page.screenshot({ path: `${evidence}/original035-100-first-${presentation.name}.png` });
          const outerPosition = () =>
            page.evaluate(() => {
              const rect = (selector) => {
                const node = document.querySelector(selector);
                const box = node?.getBoundingClientRect();
                return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
              };
              const scrollParents = [];
              for (
                let node = document.querySelector('section[aria-label="作品画面"]')?.parentElement;
                node;
                node = node.parentElement
              )
                scrollParents.push({
                  tag: node.tagName,
                  testId: node.dataset.testid,
                  top: node.scrollTop,
                  left: node.scrollLeft,
                });
              return {
                window: { x: window.scrollX, y: window.scrollY },
                visualViewport: window.visualViewport
                  ? {
                      top: window.visualViewport.offsetTop,
                      left: window.visualViewport.offsetLeft,
                      pageTop: window.visualViewport.pageTop,
                      pageLeft: window.visualViewport.pageLeft,
                    }
                  : null,
                chat: rect('[data-thread-chat-surface]'),
                host: rect('[data-testid="contextual-workspace-host"]'),
                chrome: rect('[data-testid="v2-workspace-chrome"]'),
                scrollParents,
              };
            });
          const beforeWheel = await outerPosition();
          await page.evaluate(() => {
            window.f309CanvasWheelEvents = [];
            document.addEventListener(
              'wheel',
              (event) => {
                const viewport = document.querySelector('section[aria-label="作品画面"]');
                if (viewport?.contains(event.target))
                  window.f309CanvasWheelEvents.push({
                    cancelable: event.cancelable,
                    prevented: event.defaultPrevented,
                  });
              },
              { passive: true },
            );
          });
          await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          await page.mouse.wheel(0, 4000);
          await page.waitForFunction(() => {
            const stage = document.querySelector('[data-testid="review-media-stage"]')?.getBoundingClientRect();
            const viewport = document.querySelector('section[aria-label="作品画面"]')?.getBoundingClientRect();
            return stage && viewport && Math.abs(stage.bottom - viewport.bottom) <= 1;
          });
          const end = await stage.boundingBox();
          const dock = await surface.getByRole('region', { name: '作品画布工具', exact: true }).boundingBox();
          assert.ok(end && dock);
          assert.equal(Math.round(end.height), 1552, 'ordinary scrolling does not zoom the long image');
          assert.ok(end.y + end.height <= dock.y, 'the final original line is above the tool dock');
          await page.screenshot({ path: `${evidence}/original035-100-last-${presentation.name}.png` });
          const afterWheel = await outerPosition();
          const wheelEvents = await page.evaluate(() => window.f309CanvasWheelEvents);
          await writeFile(
            `${evidence}/original035-outer-${presentation.name}.json`,
            JSON.stringify({ beforeWheel, afterWheel, wheelEvents }, null, 2),
          );
          assert.ok(
            wheelEvents.length > 0 && wheelEvents.every((event) => event.prevented),
            'the image cancels its native wheel gesture',
          );
          assert.deepEqual(
            afterWheel.visualViewport,
            beforeWheel.visualViewport,
            'the visual viewport stays with the original shell',
          );
          assert.deepEqual(
            afterWheel.window,
            beforeWheel.window,
            'scrolling the image keeps the outer window in place',
          );
          assert.deepEqual(
            afterWheel.scrollParents,
            beforeWheel.scrollParents,
            'canvas scrolling cannot leak to its outer owners',
          );
          for (const key of ['chat', 'host', 'chrome'])
            assert.deepEqual(
              afterWheel[key],
              beforeWheel[key],
              `scrolling the image keeps the original ${key} frame in place`,
            );
          const footer = await page.locator('[data-thread-chat-footer]').boundingBox();
          assert.ok(footer);
          assert.ok(
            dock.x + dock.width <= footer.x || footer.x + footer.width <= dock.x || dock.y + dock.height <= footer.y,
            `all canvas controls remain above the original composer: ${JSON.stringify({ dock, footer })}`,
          );
          await surface.getByRole('button', { name: '圈选', exact: true }).click();
          const from = { x: bounds.x + 30, y: bounds.y + bounds.height - 130 };
          const to = { x: bounds.x + 100, y: bounds.y + bounds.height - 70 };
          await page.mouse.move(from.x, from.y);
          await page.mouse.down();
          await page.mouse.move(to.x, to.y);
          await page.mouse.up();
          await page
            .locator('[data-testid="context-attachment-list"] [data-context-kind="media"]')
            .waitFor({ state: 'attached' });
          const attachment = await page.evaluate((id) => {
            const entries = JSON.parse(sessionStorage.getItem('cat-cafe:thread-context-attachment-drafts') ?? '[]');
            return entries.find(([thread]) => thread === id)?.[1]?.find((item) => item.kind === 'media');
          }, THREAD_ID);
          assert.equal(attachment.source.locator.path, relative);
          const region = attachment.selections.at(-1).selection;
          assert.equal(region.kind, 'image-region');
          for (const [key, expected] of Object.entries({ x: from.x - end.x, y: from.y - end.y, width: 70, height: 60 }))
            assert.ok(Math.abs(region[key] - expected) <= 2, `${key} names the original pixel after scrolling`);
          await writeFile(
            `${evidence}/original035-${presentation.name}.json`,
            JSON.stringify(
              {
                sourceRef: 'thread:thread_mulzdwvps2dh01b3#0001791900532983-000035-ab72b003',
                originalSha256: sha,
                privateFile: relative,
                start,
                end,
                bounds,
                dock,
                region,
                sentCount: sent.length,
              },
              null,
              2,
            ),
          );
          await surface.getByRole('button', { name: '‹ 聊天', exact: true }).click();
          assert.equal(await composer.inputValue(), '长图原草稿\n不替我发送');
          assert.equal(sent.length, 0);
          assert.deepEqual(errors, []);
        } catch (error) {
          const page = context.pages()[0];
          if (page) {
            await page.screenshot({ path: `${evidence}/original035-failure-${presentation.name}.png` });
            await writeFile(
              `${evidence}/original035-failure-${presentation.name}.json`,
              JSON.stringify(
                {
                  error: String(error),
                  url: page.url(),
                  body: await page.locator('body').innerText(),
                  viewportControls: await page
                    .locator('[aria-label="作品缩放和平移"]')
                    .evaluateAll((items) => items.map((item) => item.parentElement?.outerHTML)),
                  actions: await page
                    .locator('[data-testid="workspace-content-review-surface"] button')
                    .evaluateAll((items) => items.map((item) => [item.textContent, item.getAttribute('aria-label')])),
                  errors,
                  sent,
                  geometry: await page.evaluate(() => {
                    const selectors = [
                      '[data-thread-chat-footer]',
                      '[data-testid="chat-input-composer-row"]',
                      '[data-testid="contextual-workspace-host"]',
                      '[aria-label="作品画布工具"]',
                    ];
                    return selectors.map((selector) => {
                      const node = document.querySelector(selector);
                      if (!node) return { selector, missing: true };
                      const rect = node.getBoundingClientRect();
                      const style = getComputedStyle(node);
                      return {
                        selector,
                        rect: rect.toJSON(),
                        clientHeight: node.clientHeight,
                        scrollHeight: node.scrollHeight,
                        height: style.height,
                        minHeight: style.minHeight,
                        flex: style.flex,
                        margin: style.margin,
                        padding: style.padding,
                        border: style.borderWidth,
                      };
                    });
                  }),
                },
                null,
                2,
              ),
            );
          }
          // Diagnose native summary activation separately, without changing the production page or its owner.
          const control = await context.newPage();
          await control.setContent(
            '<details><summary aria-label="output control"><output>45%</output><span>⌄</span></summary><button>100%</button></details><details><summary aria-label="span control"><span>45%</span><span>⌄</span></summary><button>100%</button></details>',
          );
          await control.getByLabel('output control').click();
          const outputOpened = await control
            .locator('details')
            .nth(0)
            .evaluate((element) => element.open);
          await control.getByLabel('span control').click();
          const spanOpened = await control
            .locator('details')
            .nth(1)
            .evaluate((element) => element.open);
          await writeFile(
            `${evidence}/summary-native-control-${presentation.name}.json`,
            JSON.stringify({ outputOpened, spanOpened }, null, 2),
          );
          await control.close();
          throw error;
        } finally {
          await context.unrouteAll({ behavior: 'ignoreErrors' });
          await context.close();
          await proxy?.close();
          await owner.close();
          await rm(dir, { recursive: true, force: true });
          await rm(data, { recursive: true, force: true });
        }
      },
    );
}
