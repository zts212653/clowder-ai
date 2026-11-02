import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

export function registerMessageReadingVisibilityCases({ open, evidence }) {
  for (const width of [1440, 390]) {
    for (const tall of [false, true]) {
      test(`reader initial landing: ${width}px ${tall ? 'tall' : 'short'} first/next/previous`, async () => {
        const { page, errors } = await open({ width, height: 900 }, false, false, false, tall);
        const samples = [];
        try {
          if (tall) {
            await page.getByRole('button', { name: '关闭消息搜索', exact: true }).click();
            await page
              .locator('[data-message-id="old-0"]')
              .getByRole('button', { name: /^展开（还有 \d+ 行）$/ })
              .click();
            await page.waitForFunction(() => {
              const target = document.querySelector('[data-message-id="old-0"]');
              return (
                target.getBoundingClientRect().height > document.querySelector('[data-reading-surface]').clientHeight
              );
            });
            await page.getByRole('button', { name: '查找消息', exact: true }).click();
            await page.getByRole('textbox', { name: '搜索消息' }).fill('琴键');
            await page.getByRole('button', { name: '搜索', exact: true }).click();
            await page.locator('[data-message-search-result]').first().waitFor();
          }
          await page
            .locator('[data-message-search-result]')
            .first()
            .getByRole('button', { name: /^(?:跳过去|去原处)/ })
            .click();
          const controls = page.getByRole('navigation', { name: '浏览本次检索结果', exact: true });
          for (const [step, index, id] of [
            ['first', 0, 'old-0'],
            ['next', 1, 'old-3'],
            ['previous', 0, 'old-0'],
          ]) {
            if (step !== 'first')
              await controls.getByRole('button', { name: step === 'next' ? '下一处结果' : '上一处结果' }).click();
            await page.waitForFunction((index) => {
              const key = localStorage.getItem('cat-cafe:message-reading-active:v1');
              const session =
                key && JSON.parse(localStorage.getItem(`cat-cafe:message-reading-session:${key}`)).session;
              return session?.trip.status === 'ready' && !session.trip.pending && session.trip.settledIndex === index;
            }, index);
            const sample = await page.locator(`[data-message-id="${id}"]`).evaluate((target) => {
              const viewport = document.querySelector('[data-reading-surface]').getBoundingClientRect();
              const toolbar = document.querySelector('nav[aria-label="浏览本次检索结果"]').getBoundingClientRect();
              const rect = target.getBoundingClientRect();
              const hit = document.elementFromPoint((rect.left + rect.right) / 2, rect.top + 8);
              return {
                target: rect.toJSON(),
                viewport: viewport.toJSON(),
                toolbar: toolbar.toJSON(),
                openingUnobstructed: Boolean(hit && target.contains(hit)),
              };
            });
            samples.push({ step, index, ...sample });
            assert(sample.toolbar.bottom <= sample.viewport.top + 1, JSON.stringify(sample));
            assert(sample.target.top >= sample.viewport.top - 1, JSON.stringify(sample));
            assert(sample.target.top < sample.viewport.bottom - 20, JSON.stringify(sample));
            if (sample.target.height <= sample.viewport.height) {
              assert(sample.target.bottom <= sample.viewport.bottom + 1, JSON.stringify(sample));
            }
            assert(sample.openingUnobstructed, JSON.stringify(sample));
          }
          await controls.getByRole('button', { name: /^(?:回到刚才|‹ 回到「)/ }).click();
          await page.waitForFunction(
            () =>
              document.querySelector('[data-reading-trip-status]')?.getAttribute('data-reading-trip-status') ===
              'completed',
          );
          assert.deepEqual(errors, []);
        } finally {
          await writeFile(
            path.join(evidence, `initial-landing-${width}-${tall ? 'tall' : 'short'}.json`),
            JSON.stringify(samples, null, 2),
          );
          await page.close();
        }
      });
    }
  }
}
