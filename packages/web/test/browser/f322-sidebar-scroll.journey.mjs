import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createChatProofHarness } from './f322-chat-proof-harness.mjs';

// A remembered position can outlive the taller/expanded list that produced it.
// After a real wheel gesture, background snapshots must respect the new place.
export async function runSidebarScrollJourney(t, browser, built, evidence) {
  for (const [count, mixed] of [
    [40, false],
    [260, false],
    [260, true],
  ]) {
    const label = `${count}${mixed ? '-mixed' : ''}`;
    await t.test(`${label}: live updates cannot resume an unreachable scroll restore after browsing`, async () => {
      const context = await browser.newContext();
      await context.addInitScript(() => sessionStorage.setItem('cat-cafe:sidebar:scrollTop', '99999'));
      const harness = createChatProofHarness(context, built, evidence, [], (api) => {
        for (let index = api.threads.length; index < count; index++)
          api.threads.push({
            ...api.threads[3],
            id: `scroll-${index}`,
            title: `长对话标题 ${index}：检查素材、确认结构并保留正在阅读的位置`,
            lastActiveAt: api.threads[3].lastActiveAt - index * 60_000,
          });
        api.threads.forEach((thread, index) => {
          thread.unreadCount = !mixed && index === 1 ? 1 : 0;
          thread.hasUserMention = false;
          thread.presence =
            !mixed && index === 1 ? { status: 'working', cats: ['codex61-sol'], activeSince: 1 } : { status: 'idle' };
          if (mixed)
            thread.title =
              index % 3 === 0 ? `短标题 ${index}` : `长对话标题 ${index}：检查素材、确认结构并保留正在阅读的位置`;
        });
        api.preferences.groups = mixed
          ? []
          : Array.from({ length: count / 2 }, (_, index) => ({
              id: `scroll-${index}`,
              name: `322 工作分组 ${index}`,
              threadIds: api.threads.slice(index * 2, index * 2 + 2).map((thread) => thread.id),
            }));
        api.preferences.open = Object.fromEntries(api.preferences.groups.map((group) => [`group:${group.id}`, false]));
      });
      const proof = await harness.openProof();
      const { page, api } = proof;
      const samples = [];
      let anchor, frames;
      try {
        const surface = page.getByTestId('sidebar-thread-list');
        await surface.hover();
        const initial = await surface.evaluate((node) => node.scrollTop);
        assert.ok(initial > 137, 'the shorter list clamped an unreachable remembered position');
        await page.mouse.wheel(0, -137);
        await page.waitForFunction(
          (initial) => document.querySelector('[data-testid="sidebar-thread-list"]').scrollTop < initial - 10,
          initial,
        );
        if (mixed) await page.waitForTimeout(650);
        const before = await surface.evaluate((node) => node.scrollTop);
        samples.push({ stage: 'after-wheel', top: before });
        if (mixed) {
          anchor = await surface.evaluate((node) => {
            const top =
              node.querySelector('[data-scroll-occluder="true"]')?.getBoundingClientRect().bottom ??
              node.getBoundingClientRect().top;
            const rows = [...node.querySelectorAll('[data-thread-id]')];
            const first = rows.find((row) => row.getBoundingClientRect().bottom > top);
            const heights = [...new Set(rows.map((row) => row.getBoundingClientRect().height))];
            return { id: first?.dataset.threadId, y: first?.getBoundingClientRect().top, heights };
          });
          assert.ok(anchor.id, 'the real virtual viewport has a visible thread anchor');
          assert.ok(anchor.heights.length >= 2, 'this viewport contains both single-line and wrapped title heights');
          await page.evaluate(({ id }) => {
            window._mixedSidebarFrames = [];
            window._mixedSidebarCapturing = true;
            const capture = () => {
              const row = document.querySelector(`[data-thread-id="${id}"]`);
              window._mixedSidebarFrames.push({ y: row?.getBoundingClientRect().top });
              if (window._mixedSidebarCapturing) requestAnimationFrame(capture);
            };
            requestAnimationFrame(capture);
          }, anchor);
        }
        // No further wheel, click, focus or navigation occurs in this interval.
        for (let update = 0; update < 6; update++) {
          if (!mixed) api.threads[1].unreadCount = 1 + ((update + 1) % 3);
          const response = page.waitForResponse((response) => response.url().includes('/api/threads?view=sidebar'));
          await page.evaluate(() => window.dispatchEvent(new Event('online')));
          await response;
          await page.evaluate(
            () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          const top = await surface.evaluate((node) => node.scrollTop);
          samples.push({ stage: `update-${update}`, top });
          if (!mixed)
            assert.ok(Math.abs(top - before) <= 1, `background update moved sidebar from ${before} to ${top}`);
        }
        // Also cross the height-hold deadline without leaving the sidebar.
        await page.waitForTimeout(650);
        const settled = await surface.evaluate((node) => node.scrollTop);
        samples.push({ stage: 'settled', top: settled });
        if (mixed) {
          frames = await page.evaluate(() => {
            window._mixedSidebarCapturing = false;
            return window._mixedSidebarFrames;
          });
          assert.ok(frames.length > 0);
          for (const frame of frames)
            assert.ok(
              frame.y !== undefined && Math.abs(frame.y - anchor.y) <= 1,
              `the same thread moved from y${anchor.y} to y${frame.y}`,
            );
        } else assert.ok(Math.abs(settled - before) <= 1, `settled sidebar moved from ${before} to ${settled}`);
        assert.equal(await surface.getByTestId('virtual-attention-list').count(), count === 260 ? 1 : 0);
        await page.screenshot({ path: path.join(evidence, `scroll-${label}-settled.png`) });
      } finally {
        writeFileSync(
          path.join(evidence, `scroll-${label}.json`),
          JSON.stringify(
            { samples, anchor, frames, requests: api.requests, errors: proof.errors, unexpected: proof.unexpected },
            null,
            2,
          ),
        );
        await harness.closeProof(proof);
        await context.close();
      }
    });
  }
}
