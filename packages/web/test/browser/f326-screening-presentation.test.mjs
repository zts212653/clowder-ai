import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createScreeningJourney, decodedSeek, openPreparedProject } from './f326-screening-journey.harness.mjs';

// Read the same retained project. Only this browser's persisted theme preference is preconfigured.
test(
  'F326 retained opinion survives preview restart; real dark and narrow screening layouts',
  { timeout: 300000 },
  async (t) => {
    const journey = await createScreeningJourney();
    const manifest = JSON.parse(await readFile(process.env.F326_BROWSER_MANIFEST, 'utf8'));
    const sent = JSON.parse(await readFile('/tmp/f326-b-human-send-receipt.json', 'utf8'));
    const result = { outcome: 'running', assertions: [] };
    let failure;
    t.after(async () => {
      await journey.page.screenshot({ path: path.join(journey.evidence, 'last.png'), fullPage: true }).catch(() => {});
      await writeFile(
        path.join(journey.evidence, 'result.json'),
        JSON.stringify({ ...result, failure: failure?.message, calls: journey.calls, errors: journey.errors }, null, 2),
      );
      await journey.close();
      console.log(`F326 presentation evidence: ${journey.evidence}`);
    });
    try {
      const base = `/api/video-projects/${encodeURIComponent(manifest.contentRef)}`;
      const before = await journey.request(`${base}/review`);
      const original = before.review.annotations.filter(
        (annotation) => annotation.projectMessage?.source.messageId === sent.userMessageId,
      );
      assert.equal(original.length, 1);
      assert.equal(original[0].projectHistory.at(-1).kind, 'reopened');
      const synced = await Promise.all(
        Array.from({ length: 3 }, () => journey.request(`${base}/review/synchronize`, { threadId: sent.threadId })),
      );
      const after = await journey.request(`${base}/review`);
      assert.deepEqual(
        after.review,
        before.review,
        'Concurrent retry imports neither duplicate nor erase the original journal',
      );
      result.synchronize = synced.map(({ imported, hasMore, cursor }) => ({ imported, hasMore, cursor }));
      const { page, context } = journey;
      await page.setViewportSize({ width: 1440, height: 900 });
      result.initialEntry = await openPreparedProject(journey, manifest);
      assert.equal(result.initialEntry, 'workspace-home');
      const desktop = page.locator(`[data-video-project="${manifest.contentRef}"]`);
      await decodedSeek(desktop.locator('video'), 1429 / 30);
      const scenes = desktop.getByRole('navigation', { name: '场次', exact: true });
      assert.deepEqual(await scenes.locator('button').allTextContents(), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
      const shots = desktop.getByRole('navigation', { name: '镜头', exact: true });
      await shots.locator('img').first().waitFor();
      await shots
        .locator('img')
        .first()
        .evaluate((image) => image.decode());
      const thumbnail = await shots
        .locator('img')
        .first()
        .evaluate((image) => ({ width: image.naturalWidth, src: image.src }));
      assert.ok(thumbnail.width > 0 && thumbnail.src.includes('ownerRevision=1'));
      assert.equal(await desktop.getByRole('button', { name: /标记问题/ }).count(), 1);
      await desktop.getByRole('button', { name: /标记问题/ }).click();
      const queue = desktop.getByRole('button', { name: '记到原输入框', exact: true });
      const queueBox = await queue.boundingBox(),
        filmBox = await desktop.locator('video').boundingBox();
      assert.ok(
        queueBox.y >= filmBox.y + filmBox.height - 2 && queueBox.y + queueBox.height < 900,
        'Mark controls must be immediately below the film and inside the actual first viewport',
      );
      await desktop.getByRole('button', { name: '这个镜头', exact: true }).click();
      assert.equal(
        await desktop.getByRole('button', { name: '这个镜头', exact: true }).getAttribute('aria-pressed'),
        'true',
      );
      await desktop.getByRole('button', { name: '取消', exact: true }).click();
      await desktop.getByRole('button', { name: '查看上次修改', exact: true }).click();
      const changed = desktop.getByRole('region', { name: '查看修改', exact: true });
      await changed.waitFor();
      const changeBox = await changed.boundingBox();
      assert.ok(
        changeBox.y <= filmBox.y + 4 && changeBox.y > 0 && changeBox.y < 450,
        'Modification replaces the film, rather than opening below the page',
      );
      assert.equal(await desktop.getByRole('region', { name: '成片播放器', exact: true }).count(), 0);
      const originalJump = changed.getByRole('button', { name: '在原片中查看 · 0:47.6', exact: true });
      await originalJump.waitFor();
      assert.ok((await changed.innerText()).includes('修改尚未生成成片'));
      await page.waitForFunction(() => {
        const images = [...document.querySelectorAll('[aria-label="查看修改"] section[aria-label$="画稿"] img')];
        return images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0);
      });
      await changed.locator('section[aria-label$="画稿"] img').evaluateAll(async (images) => {
        await Promise.all(images.map((image) => image.decode()));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await page.screenshot({ path: path.join(journey.evidence, '00-desktop-modification.png'), fullPage: false });
      await page.evaluate(() => {
        window.f326OriginalJumpFrames = [];
        const observer = new MutationObserver(() => {
          const video = document.querySelector('[aria-label="成片播放器"] video');
          if (!video) return;
          observer.disconnect();
          const capture = (_now, metadata) => {
            window.f326OriginalJumpFrames.push(metadata.mediaTime);
            if (Math.abs(metadata.mediaTime - 1429 / 30) > 0.001) video.requestVideoFrameCallback(capture);
          };
          video.requestVideoFrameCallback(capture);
        });
        observer.observe(document.body, { subtree: true, childList: true });
      });
      await originalJump.click();
      await desktop.getByRole('region', { name: '成片播放器', exact: true }).waitFor();
      await page.waitForFunction(() => {
        const video = document.querySelector('[aria-label="成片播放器"] video');
        return (
          video?.readyState >= 2 &&
          !video.seeking &&
          window.f326OriginalJumpFrames?.some((time) => Math.abs(time - 1429 / 30) < 0.001)
        );
      });
      result.originalJumpFrames = await page.evaluate(() => window.f326OriginalJumpFrames);
      await desktop.getByRole('navigation', { name: '镜头', exact: true }).locator('img').first().waitFor();
      await desktop
        .getByRole('navigation', { name: '镜头', exact: true })
        .locator('img')
        .evaluateAll(async (images) => {
          await Promise.all(images.map((image) => image.decode()));
        });
      await page.screenshot({ path: path.join(journey.evidence, '00-desktop-review.png'), fullPage: false });
      result.desktop = { thumbnail, queueBox, filmBox, changeBox, actualOriginalAppearance: 1429 / 30 };
      await context.addInitScript(() => {
        localStorage.setItem('theme', 'dark');
        localStorage.setItem(
          'cat-cafe:themes',
          JSON.stringify({ version: '2026-06-10-dark-token-init', activeId: 'dark', custom: [], builtInOverrides: {} }),
        );
      });
      result.darkEntry = await openPreparedProject(journey, manifest);
      assert.equal(result.darkEntry, 'retained-surface', 'Reload restores the same frozen project surface');
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      const surface = page.locator(`[data-video-project="${manifest.contentRef}"]`);
      const textarea = page.locator('textarea[placeholder*="输入消息"]').first();
      assert.equal(await textarea.count(), 1);
      await textarea.evaluate((element) => {
        element.dataset.f326RetainedComposer = 'original';
      });
      await page.getByRole('button', { name: '整窗查看作品', exact: true }).click();
      const video = surface.locator('video');
      // The restored playhead is already on C08c. A paused same-time seek emits no new decoder callback.
      await decodedSeek(video, 1420 / 30);
      result.decoded = await decodedSeek(video, 1429 / 30);
      await surface.getByRole('navigation', { name: '镜头', exact: true }).locator('img').first().waitFor();
      await surface
        .getByRole('navigation', { name: '镜头', exact: true })
        .locator('img')
        .evaluateAll(async (images) => {
          await Promise.all(images.map((image) => image.decode()));
        });
      const colors = await surface.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          text: style.color,
          paper: getComputedStyle(element.querySelector('[aria-label="问题与经过"]')).backgroundColor,
        };
      });
      assert.notEqual(colors.background, 'rgba(0, 0, 0, 0)');
      result.colors = colors;
      await page.screenshot({ path: path.join(journey.evidence, '01-dark-wide.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      const boxes = {
        player: await surface.getByRole('region', { name: '成片播放器' }).boundingBox(),
        panel: await surface.getByRole('complementary', { name: '问题与经过' }).boundingBox(),
        surface: await surface.boundingBox(),
      };
      assert.ok(boxes.surface.width <= 390 && boxes.player.width <= 390);
      assert.ok(
        boxes.panel.y > boxes.player.y + boxes.player.height - 5,
        'Narrow work areas stack the journal below the film',
      );
      assert.ok(
        await surface.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        'No horizontal overflow in the actual narrow screening surface',
      );
      const sceneButtons = await surface
        .getByRole('navigation', { name: '场次' })
        .locator('button')
        .evaluateAll((buttons) =>
          buttons.map((button) => ({
            width: button.getBoundingClientRect().width,
            height: button.getBoundingClientRect().height,
          })),
        );
      assert.ok(
        sceneButtons.every((box) => box.width >= 24 && box.height <= 40),
        'Numbered scene buttons stay compact and their hover labels retain actual scene names',
      );
      assert.equal(
        await page.locator('textarea[data-f326-retained-composer="original"]').count(),
        1,
        'Full-window and resize keep the original Chat composer instance',
      );
      await page.screenshot({ path: path.join(journey.evidence, '02-dark-narrow.png'), fullPage: true });
      result.boxes = boxes;
      result.assertions.push(
        'restart retained original Human/Cat/reopen history; concurrent synchronization 3/3 succeeds without ledger mutation; real dark decoded C08c; narrow layout stacks without overflow; original composer instance retained',
      );
      assert.deepEqual(journey.errors, []);
      await surface.getByRole('button', { name: '查看上次修改', exact: true }).click();
      const previousModification = surface.getByRole('region', { name: '查看修改', exact: true });
      await page.waitForFunction(() => {
        const images = [...document.querySelectorAll('[aria-label="查看修改"] section[aria-label$="画稿"] img')];
        return images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0);
      });
      assert.ok((await previousModification.innerText()).includes('修改尚未生成成片'));
      await previousModification.getByRole('button', { name: '返回审片', exact: true }).click();
      result.assertions.push(
        'Human-reopened issue still exposes the last actual artwork modification, without changing its pending status or inventing a new result',
      );
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => localStorage.setItem('cat-cafe:shell-language', 'en'));
      result.englishEntry = await openPreparedProject(journey, manifest);
      assert.equal(result.englishEntry, 'retained-surface');
      const english = page.locator(`[data-video-project="${manifest.contentRef}"]`);
      await english.getByRole('button', { name: /Mark an issue/ }).waitFor();
      assert.equal(await english.getByRole('combobox', { name: 'Film version', exact: true }).count(), 1);
      const versions = english.getByRole('combobox', { name: 'Film version', exact: true });
      const [prior, final] = manifest.descriptors;
      assert.equal(await versions.inputValue(), final.screening.id);
      await english
        .getByRole('combobox', { name: 'Compare with an earlier version (selected version stays right)', exact: true })
        .selectOption(prior.screening.id);
      const comparison = english.getByRole('region', { name: 'Compare two films', exact: true });
      await comparison.getByRole('button', { name: 'Play both', exact: true }).click();
      await page.waitForFunction(() => {
        const videos = [...document.querySelectorAll('[aria-label="Compare two films"] video')];
        return videos.length === 2 && videos.every((video) => !video.paused && video.currentTime > 0.15);
      });
      await comparison.getByRole('button', { name: 'Pause both', exact: true }).click();
      result.comparisonTimes = await comparison
        .locator('video')
        .evaluateAll((videos) => videos.map((v) => v.currentTime));
      assert.ok(Math.abs(result.comparisonTimes[0] - result.comparisonTimes[1]) < 0.15);
      assert.match(await comparison.innerText(), /\d+:\d\d \/ \d+:\d\d/);
      await page.screenshot({ path: path.join(journey.evidence, '03-dark-english-comparison.png'), fullPage: false });
      await versions.selectOption(prior.screening.id);
      await comparison.waitFor({ state: 'hidden' });
      await english.getByRole('region', { name: 'Film player', exact: true }).waitFor();
      assert.equal(
        await english
          .getByRole('combobox', {
            name: 'Compare with an earlier version (selected version stays right)',
            exact: true,
          })
          .count(),
        0,
        'Selecting the earliest right-side film clears the pair and the unavailable earlier selector',
      );
      await versions.selectOption(final.screening.id);
      await english.getByRole('region', { name: 'Film player', exact: true }).waitFor();
      await english.getByRole('button', { name: 'View previous modification', exact: true }).click();
      const englishChange = english.getByRole('region', { name: 'View modification', exact: true });
      await englishChange.getByRole('button', { name: 'View in original film · 0:47.6', exact: true }).waitFor();
      assert.ok((await englishChange.innerText()).includes('This modification has not been rendered yet.'));
      await page.waitForFunction(() => {
        const images = [
          ...document.querySelectorAll('[aria-label="View modification"] section[aria-label$="artwork"] img'),
        ];
        return images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0);
      });
      await page.screenshot({ path: path.join(journey.evidence, '03-dark-english.png'), fullPage: false });
      assert.deepEqual(
        (await journey.request(`${base}/review`)).review,
        before.review,
        'Every display action preserves the full canonical opinion and original history',
      );
      assert.ok(
        !journey.requests.some((request) => request.method === 'POST' && /\/api\/messages(?:\?|$)/.test(request.url)),
        'Design inspection never sends a Human or model message',
      );
      assert.deepEqual(journey.errors, []);
      result.outcome = 'pass';
    } catch (error) {
      failure = error;
      result.outcome = 'fail';
      throw error;
    }
  },
);
