import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = await readFile(path.join(WEB_ROOT, 'public/pdl/engine/core.js'), 'utf8');
// Exercise both production scroll owners with native Chromium scrolling. History delivery is
// controlled so an obsolete load can finish after a newer user destination.
const start = source.indexOf('let JUMP_WAIT = null;');
const end = source.indexOf('function jumpCheck()', start);
assert.ok(start >= 0 && end > start);
const scrollStart = source.indexOf('function streamScrollTo(top)');
const scrollEnd = source.indexOf('/* 跳到某条消息', scrollStart);
assert.ok(scrollStart >= 0 && scrollEnd > scrollStart);
const productionJump = source.slice(scrollStart, scrollEnd) + source.slice(start, end);

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
        await page.evaluate(() => scrollToMessage('msg-5'));
        if (target === 'msg-80') await page.waitForTimeout(80);
        await page.evaluate((mid) => scrollToMessage(mid), target);
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

test('a newer scroll owner cancels both scrolling and pending history jumps', async (t) => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const scenario of ['scroll-latest', 'load-message', 'load-latest', 'load-empty', 'load-sync']) {
      await t.test(scenario, async () => {
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
              'const marks=[], results=[]; let resume; function land(el,mid){marks.push(mid);}' +
              'function addOld(){const el=document.createElement("div");el.dataset.mid="msg-old";el.textContent="Older message";document.querySelector("[data-stream]").prepend(el);}\n' +
              productionJump,
          });
          await page.evaluate(() =>
            document.querySelector('[data-mid="msg-50"]').scrollIntoView({ block: 'center', behavior: 'instant' }),
          );
          await page.waitForTimeout(100);
          await page.evaluate((kind) => {
            if (kind === 'scroll-latest') scrollToMessage('msg-5');
            else {
              STREAM_OLDER.load =
                kind === 'load-empty'
                  ? () => false
                  : kind === 'load-sync'
                    ? (cb) => {
                        addOld();
                        cb();
                        return true;
                      }
                    : (cb) => {
                        resume = cb;
                        return true;
                      };
              scrollToMessage('msg-old', (ok) => results.push(ok));
            }
          }, scenario);
          if (scenario === 'scroll-latest') await page.waitForTimeout(80);
          await page.evaluate((kind) => {
            if (kind === 'load-message') scrollToMessage('msg-50');
            else if (kind === 'load-latest' || kind === 'scroll-latest') streamScrollTo(null);
            if (resume) {
              addOld();
              resume();
            }
          }, scenario);
          await page.waitForTimeout(2200);
          const result = await page.evaluate(() => {
            const s = document.getElementById('stream'),
              r = s.getBoundingClientRect();
            const m = s.querySelector('[data-mid="msg-50"]').getBoundingClientRect();
            return {
              marks,
              results,
              scrollTop: s.scrollTop,
              pending: JUMP_WAIT !== null,
              distance: Math.abs((m.top + m.bottom) / 2 - (r.top + r.bottom) / 2),
            };
          });
          if (scenario === 'load-message') {
            assert.deepEqual(result.marks, ['msg-50'], `${scenario}: ${JSON.stringify(result)}`);
            assert.ok(result.distance < 2, `${scenario}: ${JSON.stringify(result)}`);
          } else if (scenario === 'load-empty') {
            assert.deepEqual(result.results, [false]);
          } else if (scenario === 'load-sync') {
            assert.deepEqual(result.marks, ['msg-old']);
            assert.deepEqual(result.results, [true]);
          } else {
            assert.deepEqual(result.marks, [], `${scenario}: ${JSON.stringify(result)}`);
            // Chromium may finish one native animation frame after a direct scrollTop write.
            // The latest row must remain in view; the retired owner must not pull back to msg-5/msg-old.
            assert.ok(Math.abs(result.scrollTop) < 120, `${scenario}: ${JSON.stringify(result)}`);
          }
          assert.equal(result.pending, false, `${scenario}: stale owner: ${JSON.stringify(result)}`);
        } finally {
          await page.close();
        }
      });
    }
  } finally {
    await browser.close();
  }
});
