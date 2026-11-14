import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

export function registerShortReadingReturnCases({ open, evidence }) {
  for (const sort of ['relevance', 'time']) {
    test(`short reading return: ${sort} restores a captured bottom and consumes only exact success`, async () => {
      const { page, errors } = await open({ width: 1440, height: 900 }, false, false, false, false, false, true);
      const report = {};
      try {
        if (sort === 'time') {
          const response = page.waitForResponse((r) => new URL(r.url()).searchParams.get('messageSort') === 'time');
          await page.getByRole('button', { name: '按时间', exact: true }).click();
          await response;
        }
        await page
          .locator('[data-message-search-result]')
          .first()
          .getByRole('button', { name: /^(?:跳过去|去原处)/ })
          .click();
        await page.waitForFunction(
          () => document.querySelector('nav[aria-label="浏览本次检索结果"] output')?.textContent?.trim() === '1 / 2',
        );
        report.captured = await page.evaluate(() => {
          const viewport = document.querySelector('[data-reading-surface]');
          const id = localStorage.getItem('cat-cafe:message-reading-active:v1');
          const session = JSON.parse(localStorage.getItem(`cat-cafe:message-reading-session:${id}`)).session;
          const [, thread, ref] = /^chat-reading:([^:]+):(.+)$/.exec(session.trip.origin.readingRef);
          const refKey = `cat-cafe:thread-scroll-ref:${thread}:${ref}`;
          return {
            refKey,
            position: JSON.parse(localStorage.getItem(refKey)).state,
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
          };
        });
        assert.deepEqual(report.captured.position, { top: 0, anchor: 'bottom' });
        assert(report.captured.clientHeight > 0);
        assert.equal(report.captured.scrollHeight, report.captured.clientHeight);
        const controls = page.getByRole('navigation', { name: '浏览本次检索结果' });
        await controls.getByRole('button', { name: /回到/ }).click();
        await page.waitForFunction(
          () =>
            document.querySelector('[data-reading-trip-status]')?.getAttribute('data-reading-trip-status') ===
            'completed',
          null,
          { timeout: 4000 },
        );
        await controls.waitFor({ state: 'hidden' });
        assert.equal(await page.locator('[data-reading-surface]').evaluate((el) => el.scrollTop), 0);
        assert.equal(await page.evaluate((key) => localStorage.getItem(key), report.captured.refKey), null);
        assert.deepEqual(errors, []);
        report.complete = true;
      } finally {
        report.pageErrors = errors;
        await writeFile(path.join(evidence, `short-return-${sort}.json`), JSON.stringify(report, null, 2));
        await page.close();
      }
    });
  }
}
