import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = await readFile(path.join(WEB_ROOT, 'public/pdl/engine/core.js'), 'utf8');
// Exercise the production scroll owner with native Chromium scrolling. Projection and data loading
// are outside this race: both message targets are already drawn and no host requests are needed.
const start = source.indexOf('let JUMP_WAIT = null;');
const end = source.indexOf('function jumpCheck()', start);
assert.ok(start >= 0 && end > start);
const productionJump = source.slice(start, end);

test('the latest message jump wins, including an immediately completed destination', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const target of ['msg-50', 'msg-80']) {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      try {
        await page.setContent(
          '<style>#stream{height:500px;overflow:auto;display:flex;flex-direction:column-reverse;overflow-anchor:none}' +
            '[data-stream]{flex:none}[data-mid]{height:120px;scroll-margin:0}</style>' +
            '<div id="stream"><div data-stream="chat">' +
            Array.from({ length: 100 }, (_, i) => `<div data-mid="msg-${i}">Message ${i}</div>`).join('') +
            '</div></div>',
        );
        await page.addScriptTag({
          content:
            'const ENGINE_PARTS={}, STREAM_OLDER={load:null}; function motionOff(){return false;}' +
            'const marks=[]; function land(el,mid){marks.push(mid);}\n' +
            productionJump,
        });
        await page.evaluate(() => {
          document.querySelector('[data-mid="msg-50"]').scrollIntoView({ block: 'center', behavior: 'instant' });
        });
        await page.waitForTimeout(100);
        await page.evaluate((mid) => {
          scrollToMessage('msg-5');
          scrollToMessage(mid);
        }, target);
        // Allow the obsolete smooth-scroll's scrollend to fire as well. Merely observing the new
        // target once would miss the old listener moving the viewport back afterwards.
        await page.waitForTimeout(2200);
        const result = await page.evaluate((mid) => {
          const view = document.getElementById('stream').getBoundingClientRect();
          const message = document.querySelector(`[data-mid="${mid}"]`).getBoundingClientRect();
          return { marks, distance: Math.abs((message.top + message.bottom) / 2 - (view.top + view.bottom) / 2) };
        }, target);
        assert.deepEqual(result.marks, [target], `obsolete jump completed after ${target}: ${JSON.stringify(result)}`);
        assert.ok(result.distance < 2, `last destination moved out of place: ${JSON.stringify(result)}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});
