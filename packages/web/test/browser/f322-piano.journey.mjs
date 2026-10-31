import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closePianoPage, openPianoPage } from './f322-piano-harness.mjs';
import { CURRENT_THREAD, DRAFT } from './fixtures/f322-chat-real-page-data.mjs';
import { observePianoArrival } from './fixtures/f322-piano-arrival.mjs';
import { buildPianoPage } from './fixtures/f322-piano-build.mjs';
import { measurePianoPage, observePianoPointerOwnership, pianoThumbHitTest } from './fixtures/f322-piano-metrics.mjs';

const savedKey = `cat-cafe:thread-scroll:${CURRENT_THREAD}`;
async function landed(page, id) {
  await page.waitForFunction(
    ({ id, savedKey }) => {
      const chat = document.querySelector('[data-chat-container]');
      const row = chat?.querySelector(`[data-message-id="${id}"]`);
      const saved = JSON.parse(localStorage.getItem(savedKey) || 'null')?.state;
      if (!row || saved?.messageAnchor?.messageId !== id) return false;
      const box = row.getBoundingClientRect(),
        view = chat.getBoundingClientRect();
      return box.bottom > view.top && box.top < view.bottom && row.dataset.messageJumpFocus === 'true';
    },
    { id, savedKey },
  );
}
async function readingAnchor(page, id) {
  return page.evaluate(
    ({ id, savedKey }) => {
      const chat = document.querySelector('[data-chat-container]');
      const row = chat.querySelector(`[data-message-viewport-id="${id}"]`);
      return {
        offset: row.getBoundingClientRect().top - chat.getBoundingClientRect().top,
        state: JSON.parse(localStorage.getItem(savedKey) || 'null')?.state,
      };
    },
    { id, savedKey },
  );
}
function assertRuler(m, count, pane) {
  assert.equal(m.paneWidth, pane);
  assert.equal(m.keys.length, count);
  assert.equal(m.rows.length, count);
  assert.equal(m.tabStops, 1);
  assert.equal(m.scrollbar, 'none');
  assert.equal(m.overflow, false);
  assert.ok(m.contentRight < m.trackLeft, 'the reading column reserves space for the track');
  assert.equal(m.draft, DRAFT);
  assert.deepEqual(
    m.keys.map((key) => key.id),
    m.rows.map((row) => row.id),
  );
  for (const [index, key] of m.keys.entries()) {
    const row = m.rows[index];
    assert.ok(
      Math.abs(key.top - (row.top / m.contentHeight) * m.trackHeight) < 1,
      `${key.id} shares the actual content ruler`,
    );
    assert.equal(key.tabIndex, -1);
    assert.ok(key.height > 0);
  }
  assert.ok(m.thumbHeight >= 3);
}
export async function runPianoJourneys(t, browser) {
  const built = await buildPianoPage();
  const evidence = process.env.CAT_CAFE_PIANO_EVIDENCE_DIR ?? path.join(os.tmpdir(), `f322-piano-${process.pid}`);
  await mkdir(evidence, { recursive: true });
  const measurements = [];
  const lifecycle = [];
  async function capture(proof, name, settledMeasurement) {
    const metrics = settledMeasurement ?? (await proof.page.evaluate(measurePianoPage));
    const arrival = await proof.page.evaluate(() => window.pianoArrivalTrace ?? null);
    measurements.push({ name, ...metrics, reads: proof.reads, errors: proof.errors, arrival });
    await proof.page.screenshot({ path: path.join(evidence, `${name}.png`) });
    return metrics;
  }
  async function run(name, options, action) {
    await t.test(name, async () => {
      const proof = await openPianoPage(browser, built, options);
      const failures = [];
      let actionPassed = false;
      let cleanupPassed = false;
      try {
        await action(proof);
        actionPassed = true;
      } catch (error) {
        failures.push(error);
        await capture(proof, `${name}-failure`)
          .then(() => writeFile(path.join(evidence, `${name}-failure.txt`), String(error.stack ?? error)))
          .catch((captureFailure) => failures.push(captureFailure));
      }
      try {
        await closePianoPage(proof);
        cleanupPassed = true;
      } catch (cleanupFailure) {
        failures.push(cleanupFailure);
      }
      lifecycle.push({ name, actionPassed, cleanupPassed });
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, `${name}: action, capture or cleanup failed`);
    });
  }
  try {
    for (const [count, pane, compact, base] of [
      [24, 900, false, 'light'],
      [240, 400, true, 'dark'],
      [900, 320, true, 'light'],
      [24, 400, false, 'dark'],
    ]) {
      const name = `${count}-${pane}-${base}`;
      await run(name, { count, pane, compact, base }, async (proof) => {
        const { page } = proof;
        await page.locator('[data-message-piano-ready="true"]').first().waitFor();
        const settledFrame = await page.waitForFunction(measurePianoPage, count);
        const m = await capture(proof, name, await settledFrame.jsonValue());
        await settledFrame.dispose();
        assertRuler(m, count, pane);
        if (count === 900) assert.ok(m.deferred > 0, 'drawing does not eagerly mount all rows');
        assert.equal(
          proof.reads.some((read) => read.before),
          false,
          'drawing never loads earlier history',
        );
        const track = page.getByRole('listbox');
        await track.focus();
        await page.keyboard.press('Home');
        for (let n = 0; n < 3; n++) await page.keyboard.press('ArrowDown');
        assert.match(await track.getAttribute('aria-activedescendant'), /piano-4$/);
        await page.evaluate(observePianoArrival, { id: 'piano-4', savedKey });
        await page.keyboard.press('Enter');
        await landed(page, 'piano-4');
        await capture(proof, `${name}-keyboard-source`);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('[data-chat-container]').evaluate((el) => document.activeElement === el), true);
        assert.equal(await page.locator('textarea').inputValue(), DRAFT);
      });
    }
    await run('native-click-back-refresh-wheel-drag', { count: 240, pane: 400, compact: true }, async (proof) => {
      const { page } = proof;
      await page.evaluate(observePianoArrival, { id: 'piano-60', savedKey });
      await page.locator('[data-message-piano-key="piano-60"]').click();
      await landed(page, 'piano-60');
      const before = await readingAnchor(page, 'piano-60');
      await capture(proof, 'native-click-source');
      await page.getByRole('button', { name: 'Other thread', exact: true }).click();
      await page.locator('[data-message-id="other-message"]').waitFor();
      await page.goBack();
      for (const cold of [false, true]) {
        if (cold) await page.reload();
        await page.waitForFunction(
          ({ id, offset }) => {
            const chat = document.querySelector('[data-chat-container]');
            const row = chat?.querySelector(`[data-message-viewport-id="${id}"]`);
            return row && Math.abs(row.getBoundingClientRect().top - chat.getBoundingClientRect().top - offset) <= 2;
          },
          { id: 'piano-60', offset: before.offset },
        );
        assert.equal((await readingAnchor(page, 'piano-60')).state.messageAnchor.messageId, 'piano-60');
        assert.equal(await page.locator('textarea').inputValue(), DRAFT);
        await capture(proof, cold ? 'native-cold-refresh-source' : 'native-back-source');
      }
      const chat = page.locator('[data-chat-container]'),
        track = page.getByRole('listbox');
      const top = await chat.evaluate((el) => el.scrollTop);
      await track.hover({ position: { x: 18, y: 200 } });
      await page.mouse.wheel(0, -150);
      await page.waitForFunction((top) => document.querySelector('[data-chat-container]').scrollTop < top, top);
      const hit = await page.evaluate(pianoThumbHitTest);
      await writeFile(path.join(evidence, 'native-thumb-hit.json'), JSON.stringify(hit, null, 2));
      assert.ok(
        hit.points.every((point) => point.dragTarget),
        'the painted thumb center and body must receive native drag presses',
      );
      const priorDrag = await chat.evaluate((el) => el.scrollTop);
      await page.evaluate(observePianoPointerOwnership);
      await page.mouse.move(hit.center.x, hit.center.y);
      await page.mouse.down();
      await page.mouse.move(hit.center.x, hit.center.y + 20, { steps: 4 });
      await page.mouse.up();
      await page.waitForFunction((top) => document.querySelector('[data-chat-container]').scrollTop > top, priorDrag);
      const pointerTrace = await page.evaluate(() => {
        window.stopPianoPointerOwnership();
        return window.pianoPointerOwnership;
      });
      await writeFile(path.join(evidence, 'native-thumb-pointer.json'), JSON.stringify(pointerTrace, null, 2));
      assert.equal(pointerTrace.pointerDown.length, 1);
      assert.equal(
        pointerTrace.pointerDown[0].captured,
        true,
        'the existing owner drag port captures the native press',
      );
      assert.deepEqual(pointerTrace.highlightAdded, [], 'drag release must not trigger a message jump');
      await track.focus();
      const beforePage = await chat.evaluate((el) => el.scrollTop);
      await page.keyboard.press('PageDown');
      await page.waitForFunction((top) => document.querySelector('[data-chat-container]').scrollTop > top, beforePage);
      await page.keyboard.press('End');
      assert.match(await track.getAttribute('aria-activedescendant'), /piano-240$/);
      await page.getByRole('button', { name: '到最新', exact: true }).click();
      await page.waitForFunction(() => {
        const chat = document.querySelector('[data-chat-container]');
        return chat.scrollHeight - chat.scrollTop - chat.clientHeight <= 1;
      });
      assert.equal((await readingAnchor(page, 'piano-240')).state.anchor, 'bottom');
      await capture(proof, 'native-reading-owner');
    });
    await run(
      'unloaded-history-is-not-drawn',
      { count: 80, pane: 400, compact: true, partial: true },
      async (proof) => {
        const { page } = proof;
        await page.getByRole('img', { name: '更早的消息尚未加载' }).waitFor();
        assert.equal(await page.locator('[data-message-piano-key]').count(), 16);
        assert.equal(
          proof.reads.some((read) => read.before),
          false,
        );
        await page.getByRole('listbox').focus();
        await page.keyboard.press('Home');
        await page.keyboard.press('Enter');
        await landed(page, 'piano-65');
        assert.equal(
          proof.reads.some((read) => read.before),
          false,
          'a loaded-key jump does not load history',
        );
        // Actual user paging goes through beginUserScroll/handleScroll. Home
        // selects the first loaded key; it is not an unbounded history loader.
        await page.keyboard.press('PageDown');
        await page.keyboard.press('PageUp');
        await page.locator('[data-message-piano-key="piano-1"]').waitFor();
        assert.ok(
          proof.reads.some((read) => read.before),
          'only the original reading owner loads history',
        );
        assert.equal(await page.locator('[data-message-piano-key]').count(), 80);
        await capture(proof, 'history-prepend');
      },
    );
    await run(
      'late-image-keeps-the-reading-anchor',
      { count: 24, pane: 400, compact: true, lateImage: true },
      async (proof) => {
        const { page } = proof;
        const track = page.getByRole('listbox');
        await track.focus();
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await landed(page, 'piano-24');
        const before = await readingAnchor(page, 'piano-24');
        const geometry = await page.evaluate(measurePianoPage);
        proof.releaseImage();
        await page.waitForFunction(() => {
          const image = document.querySelector('img[src$="/late-image.svg"]');
          return image?.complete && image.naturalHeight === 300;
        });
        await page.waitForFunction(
          (height) => document.querySelector('[data-chat-container]').scrollHeight > height,
          geometry.contentHeight,
        );
        await page.waitForFunction((offset) => {
          const chat = document.querySelector('[data-chat-container]');
          const target = chat.querySelector('[data-message-viewport-id="piano-24"]');
          return Math.abs(target.getBoundingClientRect().top - chat.getBoundingClientRect().top - offset) <= 2;
        }, before.offset);
        assert.equal((await readingAnchor(page, 'piano-24')).state.messageAnchor.messageId, 'piano-24');
        assert.equal(await page.locator('textarea').inputValue(), DRAFT);
        assert.equal(
          proof.reads.some((read) => read.before),
          false,
        );
        await capture(proof, 'late-image-reading');
      },
    );
    await run(
      'cold-classic-retains-original-navigation',
      { count: 24, pane: 400, presentation: 'classic' },
      async (proof) => {
        assert.equal(await proof.page.locator('[data-message-piano]').count(), 0);
        assert.equal(await proof.page.locator('[data-message-navigator] button').count(), 18);
        assert.notEqual(
          await proof.page.locator('[data-chat-container]').evaluate((el) => getComputedStyle(el).scrollbarWidth),
          'none',
        );
        await proof.page.locator('[data-message-navigator] button').first().click();
        await proof.page.waitForFunction(
          (key) => JSON.parse(localStorage.getItem(key) || 'null')?.state.anchor === 'offset',
          savedKey,
        );
        await capture(proof, 'classic-retained');
      },
    );
  } finally {
    await writeFile(path.join(evidence, 'measurements.json'), `${JSON.stringify(measurements, null, 2)}\n`);
    await writeFile(path.join(evidence, 'lifecycle.json'), `${JSON.stringify(lifecycle, null, 2)}\n`);
  }
}
