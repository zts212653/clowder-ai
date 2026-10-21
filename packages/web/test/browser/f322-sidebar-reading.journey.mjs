import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realSurfaceApiResponse } from './f307-real-surface-fixtures.mjs';
import { createChatProofHarness } from './f322-chat-proof-harness.mjs';
import { startNativeHost } from './f322-native-reply-next.mjs';
import { buildChatProof } from './fixtures/f322-chat-real-page-build.mjs';
import { createChatProofApi } from './fixtures/f322-chat-real-page-data.mjs';

// Real Sidebar clicks and per-frame Chromium geometry. HTTP is isolated; these
// are compiled production components, not Alpha/runtime user data.
export async function runSidebarReadingJourney(t, browser) {
  const evidence = process.env.F322_SIDEBAR_READING_EVIDENCE_DIR ?? path.join(os.tmpdir(), 'f322-sidebar-reading');
  mkdirSync(evidence, { recursive: true });
  const built = await buildChatProof();
  for (const [count, deep, keepFacts] of [
    [11, false, false],
    [260, false, false],
    [260, true, false],
    [11, false, true],
  ]) {
    const label = `${count}-${deep ? 'scrolled' : 'top'}${keepFacts ? '-working-decision' : ''}`;
    await t.test(
      `${label}: read space compacts inside the list and the next physical click navigates correctly`,
      async () => {
        const context = await browser.newContext();
        const targetIndex = deep ? 30 : 2;
        let targetId;
        const harness = createChatProofHarness(context, built, evidence, [], (api) => {
          for (let index = api.threads.length; index < count; index++)
            api.threads.push({
              ...api.threads[3],
              id: `extra-${index}`,
              title: `History ${index}`,
              lastActiveAt: api.threads[3].lastActiveAt - index * 60_000,
            });
          targetId = api.threads[targetIndex].id;
          api.threads.forEach((thread, index) => {
            thread.unreadCount = (deep && index <= targetIndex) || index === targetIndex ? 1 : 0;
            thread.hasUserMention = false;
            thread.presence = index === targetIndex ? { status: 'done', cats: ['codex61-sol'] } : { status: 'idle' };
          });
          // This compile-only host does not remount the chat route. Keep its
          // initial conversation inside the group so the next row is a new route.
          api.preferences.groups = deep
            ? []
            : [{ id: 'gap', name: 'Gap group', threadIds: [0, 2, 3, 4].map((i) => api.threads[i].id) }];
          api.preferences.open = { 'group:gap': false };
          if (keepFacts) {
            api.threads[3].presence = { status: 'working', cats: ['codex61-sol'] };
            api.decisions.push({
              decisionRef: 'f306.runtime_interaction:gap',
              kind: 'judgment',
              summary: 'Choose',
              linkedNeedsMe: [],
              choiceRequest: {
                interactionId: 'gap',
                revision: 1,
                requesterCatId: 'codex61-sol',
                createdAt: 1,
                title: 'Choose',
                questions: [{ id: 'pick', header: 'Choice', question: 'Which?' }],
                cardRef: { threadId: api.threads[4].id, messageId: 'm', blockId: 'b' },
              },
            });
          }
          const respond = api.respond;
          api.respond = (request, url) => {
            if (url.pathname.endsWith('/read/latest')) {
              const thread = api.threads.find((row) => url.pathname === `/api/threads/${row.id}/read/latest`);
              if (thread) {
                thread.unreadCount = 0;
                if (thread.presence.status === 'done') thread.presence = { status: 'idle' };
              }
              return { contentType: 'application/json', body: JSON.stringify({ advanced: true, caughtUp: true }) };
            }
            return respond(request, url);
          };
        });
        const proof = await harness.openProof();
        const { page, api } = proof;
        let before, immediate, physicalTarget, frames;
        try {
          const surface = page.getByTestId('sidebar-thread-list');
          const target = surface.locator(`[data-thread-id="${targetId}"]`);
          if (deep) {
            await surface.hover();
            for (let step = 0; step < 8 && !(await target.count()); step++) {
              await page.mouse.wheel(0, 400);
              await page.evaluate(
                () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
              );
            }
          }
          const link = deep ? target.locator('[role="link"]') : target;
          await link.hover();
          before = await target.evaluate((button) => {
            const wrapper = button.closest('[data-sidebar-row-key]');
            const surface = wrapper.closest('[data-testid="sidebar-thread-list"]');
            const rows = [...surface.querySelectorAll('[data-sidebar-row-key]')];
            const next = rows[rows.indexOf(wrapper) + 1];
            const box = (node) => {
              const r = node.getBoundingClientRect();
              return { x: r.x, y: r.y, h: r.height };
            };
            return {
              key: wrapper.dataset.sidebarRowKey,
              nextKey: next.dataset.sidebarRowKey,
              nextId: next.querySelector('[data-thread-id]')?.getAttribute('data-thread-id'),
              wrapper: box(wrapper),
              next: box(next),
              scrollTop: surface.scrollTop,
            };
          });
          assert.ok(before.nextId);
          if (deep) assert.ok(before.scrollTop > 40, 'exercise a newly virtual-mounted row after real scrolling');
          await page.screenshot({ path: path.join(evidence, `${label}-before.png`) });
          await page.evaluate(({ key, nextKey }) => {
            const frames = [];
            window.__sidebarGapFrames = frames;
            window.__sidebarGapDone = false;
            const started = performance.now();
            const sample = () => {
              const find = (wanted) =>
                [...document.querySelectorAll('[data-sidebar-row-key]')].find(
                  (node) => node.dataset.sidebarRowKey === wanted,
                );
              const row = find(key),
                next = find(nextKey),
                slot = row?.closest('[data-virtual-row-key]');
              frames.push({
                ms: performance.now() - started,
                content: row?.firstElementChild?.getBoundingClientRect().height,
                wrapper: row?.getBoundingClientRect().height,
                slot: slot?.getBoundingClientRect().height ?? null,
                nextY: next?.getBoundingClientRect().y,
                scrollTop: row?.closest('[data-testid="sidebar-thread-list"]')?.scrollTop,
                preview: row?.querySelector('[data-testid="collapsed-group-peek"]')?.textContent ?? null,
              });
              if (performance.now() - started < 1400) requestAnimationFrame(sample);
              else window.__sidebarGapDone = true;
            };
            requestAnimationFrame(sample);
          }, before);
          await link.click();
          await page.waitForURL((url) => url.pathname === `/thread/${targetId}`);
          await page.evaluate(
            () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          immediate = await page.evaluate(
            (key) =>
              [...document.querySelectorAll('[data-sidebar-row-key]')]
                .find((node) => node.dataset.sidebarRowKey === key)
                ?.getBoundingClientRect().y,
            before.nextKey,
          );
          assert.ok(Math.abs(immediate - before.next.y) <= 1, `immediate target moved ${immediate - before.next.y}px`);
          physicalTarget = await page.evaluate(
            ({ x, y }) =>
              document
                .elementFromPoint(x + 80, y + 12)
                ?.closest('[data-thread-id]')
                ?.getAttribute('data-thread-id'),
            before.next,
          );
          assert.equal(physicalTarget, before.nextId);
          await page.mouse.click(before.next.x + 80, before.next.y + 12);
          await page.waitForURL((url) => url.pathname === `/thread/${before.nextId}`);
          await page.mouse.move(before.next.x + 90, before.next.y + 14);
          await page.waitForFunction(() => window.__sidebarGapDone);
          frames = await page.evaluate(() => window.__sidebarGapFrames);
          const final = frames.at(-1);
          assert.ok(final.wrapper - final.content <= 1, `empty wrapper remains: ${JSON.stringify(final)}`);
          assert.ok(
            final.slot === null || final.slot - final.content <= 2,
            `empty virtual slot remains: ${JSON.stringify(final)}`,
          );
          assert.ok(final.wrapper < before.wrapper.h, 'reading actually reclaimed height, without pointerleave');
          if (keepFacts) {
            await surface.locator('[data-peek-reason="decision"][data-thread-id="composer-proof-4"]').waitFor();
            assert.equal(
              await surface.locator('[data-peek-reason="unread"][data-thread-id="composer-proof-2"]').count(),
              0,
            );
            assert.match(await surface.getByTestId('group-status-line').innerText(), /1 只在干活/);
          } else assert.equal(final.preview, null);
          if (count === 260) assert.equal(await surface.getByTestId('virtual-attention-list').count(), 1);
          await page.screenshot({ path: path.join(evidence, `${label}-settled.png`) });
          await page.mouse.move(500, 500);
          await page.evaluate(
            () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          const afterLeave = await surface.locator(`[data-thread-id="${before.nextId}"]`).count();
          assert.ok(afterLeave, 'the next conversation remains reachable after releasing ordering');
        } finally {
          frames = await page.evaluate(() => window.__sidebarGapFrames ?? []);
          writeFileSync(path.join(evidence, `${label}-frames.json`), JSON.stringify(frames, null, 2));
          writeFileSync(
            path.join(evidence, `${label}-measurement.json`),
            JSON.stringify(
              {
                before,
                immediate,
                physicalTarget,
                requests: api.requests,
                errors: proof.errors,
                unexpected: proof.unexpected,
              },
              null,
              2,
            ),
          );
          await page.screenshot({ path: path.join(evidence, `${label}-final.png`) });
          await harness.closeProof(proof);
          await context.close();
        }
      },
    );
  }
}

// One real Next route transition protects the seam that the component fixture's
// navigation boundary cannot cover. API/provider responses remain isolated.
export async function runNativeSidebarReadingJourney(browser) {
  const evidence = process.env.F322_SIDEBAR_READING_EVIDENCE_DIR ?? path.join(os.tmpdir(), 'f322-sidebar-reading');
  mkdirSync(evidence, { recursive: true });
  const host = await startNativeHost();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const api = createChatProofApi(Date.now(), false, false);
  const errors = [];
  const greenId = 'composer-proof-2';
  let before, after;
  api.preferences.groups = [];
  api.threads.forEach((row, index) => {
    row.title = `Native sidebar ${index}`;
    row.unreadCount = index === 2 ? 1 : 0;
    row.hasUserMention = false;
    row.presence = index === 2 ? { status: 'done', cats: ['codex61-sol'] } : { status: 'idle' };
  });
  for (let index = 11; index < 260; index++)
    api.threads.push({
      ...api.threads[3],
      id: `native-${index}`,
      title: `History ${index}`,
      lastActiveAt: 1,
    });
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await host.ready();
    await page.addInitScript(() => {
      localStorage.setItem('cat-cafe:shell-presentation', 'v2');
      localStorage.setItem('cat-cafe:sidebar:active-tab', 'pinned');
    });
    await page.route('**/api/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      assert.equal(url.origin, host.url, 'native API cannot reach runtime');
      if (url.pathname === `/api/threads/${greenId}/read/latest`) {
        api.threads[2].unreadCount = 0;
        api.threads[2].presence = { status: 'idle' };
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ advanced: true, caughtUp: true }),
        });
      }
      const own = api.respond(request, url);
      if (own) return route.fulfill(own);
      const fixture = realSurfaceApiResponse(request, false);
      return route.fulfill({
        status: fixture?.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(fixture?.body ?? {}),
      });
    });
    await page.goto(`${host.url}/thread/composer-proof-0`);
    const sidebar = page.getByTestId('sidebar-thread-list');
    const green = sidebar.locator(`[data-thread-id="${greenId}"]`);
    await green.getByTestId('thread-row-done').waitFor();
    await green.locator('[role="link"]').hover();
    const next = sidebar.locator('[data-thread-id="composer-proof-0"]');
    before = await next.boundingBox();
    await page.screenshot({ path: path.join(evidence, 'native-before.png') });
    await green.locator('[role="link"]').click();
    await page.waitForURL(`${host.url}/thread/${greenId}`);
    await green.getByTestId('thread-row-done').waitFor({ state: 'detached' });
    await page.screenshot({ path: path.join(evidence, 'native-read.png') });
    after = await next.boundingBox();
    assert.ok(Math.abs(after.y - before.y) <= 1, `native Next click moved the following row ${after.y - before.y}px`);
    await page.mouse.click(before.x + 80, before.y + 12);
    await page.waitForURL(`${host.url}/thread/composer-proof-0`);
    assert.deepEqual(errors, []);
  } finally {
    writeFileSync(
      path.join(evidence, 'native-measurement.json'),
      JSON.stringify({ url: host.url, before, after, errors, requests: api.requests }, null, 2),
    );
    await context.close();
    await host.close();
  }
}
