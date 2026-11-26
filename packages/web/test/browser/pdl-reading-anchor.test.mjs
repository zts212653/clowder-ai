import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';

const source = await readFile(new URL('../../public/pdl/engine/core.js', import.meta.url), 'utf8');
const identity = source.slice(source.indexOf('function nodeId('), source.indexOf('function streamVer('));
const anchoring = source.slice(source.indexOf('const KEYED_SEL ='), source.indexOf('function streamTop()'));

test('native resize anchoring preserves a tall visible unit and keeps bottom-following', async (t) => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const mode of ['reading', 'replaced', 'bottom', 'ordinary', 'whole-unit']) {
      await t.test(mode, async () => {
        const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
        try {
          await page.setContent(
            '<style>.scroll{height:400px;overflow:auto;overflow-anchor:none}.stick-end{display:flex;flex-direction:column-reverse}.scroll>div{flex:none}[data-id]{box-sizing:border-box}</style>' +
              `<div id="viewport" class="scroll ${mode === 'ordinary' ? '' : 'stick-end'}"><div>` +
              '<section data-id="before" style="height:200px"></section>' +
              `<section data-id="reading" style="height:${mode === 'whole-unit' ? 150 : 1600}px">Reading</section>` +
              '<section data-id="following" style="height:150px"></section>' +
              '<section data-id="live" style="height:150px">Live</section></div></div>',
          );
          await page.addScriptTag({ content: identity + anchoring });
          await page.evaluate((kind) => {
            const s = document.getElementById('viewport');
            window.observer = new ResizeObserver(() => anchorKeep(s));
            window.observer.observe(s.firstElementChild);
            s.scrollTop = kind === 'bottom' ? 0 : kind === 'ordinary' ? 800 : kind === 'whole-unit' ? -200 : -800;
          }, mode);
          await page.waitForTimeout(100);
          const before = await page.evaluate(() => {
            const s = document.getElementById('viewport'),
              n = s.querySelector('[data-id="reading"]');
            return {
              y: n.getBoundingClientRect().top - s.getBoundingClientRect().top,
              refs: anchorTake(s).refs?.map((r) => r.id) ?? [],
            };
          });
          if (mode === 'replaced')
            await page.evaluate(() => {
              const n = document.querySelector('[data-id="reading"]');
              n.replaceWith(n.cloneNode(true));
            });
          for (let i = 1; i <= 8; i++) {
            await page.evaluate(
              ({ height, ordinary }) => {
                document.querySelector(ordinary ? '[data-id="before"]' : '[data-id="live"]').style.height =
                  height + 'px';
              },
              { height: (mode === 'ordinary' ? 200 : 150) + i * 60, ordinary: mode === 'ordinary' },
            );
            await page.waitForTimeout(30);
          }
          const after = await page.evaluate(() => {
            const s = document.getElementById('viewport'),
              n = s.querySelector('[data-id="reading"]');
            return { y: n.getBoundingClientRect().top - s.getBoundingClientRect().top, top: s.scrollTop };
          });
          if (mode === 'bottom') assert.ok(Math.abs(after.top) < 2, JSON.stringify(after));
          else {
            assert.ok(Math.abs(after.y - before.y) < 2, `${mode}: ${JSON.stringify({ before, after })}`);
            if (mode === 'whole-unit') assert.equal(before.refs[0], 'reading', 'prefer the fully visible unit');
          }
        } finally {
          await page.close();
        }
      });
    }
  } finally {
    await browser.close();
  }
});
