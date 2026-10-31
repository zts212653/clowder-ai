import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { readAuthorDraft } from './f326-real-works-composer.journey.mjs';
import { decodedSeek } from './f326-screening-journey.harness.mjs';

test(
  'real film chapters, exact chapter alignment, grouped sequences, covers and source dates survive the original Works path',
  { timeout: 300000 },
  async (t) => {
    const web = process.env.F326_DESIGN_WEB,
      api = process.env.F326_DESIGN_API;
    assert.ok(
      (web === 'http://127.0.0.1:3463' && api === 'http://127.0.0.1:3464') ||
        (web === 'http://127.0.0.1:3465' && api === 'http://127.0.0.1:3466') ||
        (web === 'http://127.0.0.1:3461' && api === 'http://127.0.0.1:3462'),
      'Only owned candidate or named Alpha; never runtime',
    );
    const library = JSON.parse(await readFile(process.env.F326_DESIGN_LIBRARY, 'utf8'));
    const evidence = await mkdtemp('/tmp/f326-c-design-browser-');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    const errors = [],
      observations = {};
    let outcome = 'running',
      failure;
    page.on('pageerror', (error) => errors.push(error.message));
    observations.networkFailures = [];
    observations.consoleErrors = [];
    page.on('requestfailed', (request) =>
      observations.networkFailures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }),
    );
    page.on('console', (message) => {
      if (message.type() === 'error') observations.consoleErrors.push(message.text().slice(0, 1000));
    });

    let ownReference, ownAnchor;
    async function cleanOwnDraft() {
      const drafts = await readAuthorDraft(page, library.threadId);
      if (!drafts.length) return;
      assert.equal(drafts.length, 1);
      assert.ok(ownReference);
      assert.equal(drafts[0].source.contentRef, ownReference.contentRef);
      assert.equal(drafts[0].source.ownerRevision, ownReference.ownerRevision);
      assert.ok(drafts[0].selections.every((place) => !place.instruction));
      for (const place of drafts[0].selections)
        assert.deepEqual(place.selection, ownAnchor, 'Retain unfamiliar selections');
      for (const place of drafts[0].selections) {
        await page
          .locator(`[data-selection-id="${place.id}"]`)
          .getByRole('button', { name: /^移除选区 / })
          .click();
      }
      await page.waitForFunction(() =>
        JSON.parse(sessionStorage.getItem('cat-cafe:thread-context-attachment-drafts') || '[]').every(
          ([, items]) => !items.length,
        ),
      );
      await wait(async () => {
        const r = await context.request.get(`${api}/api/threads/${library.threadId}/composer-draft`);
        const { draft } = await r.json();
        return !draft?.contentBlocks?.some((block) => block.type === 'context_attachment');
      });
      observations.composerClean = true;
    }
    t.after(async () => {
      try {
        await cleanOwnDraft();
        await page.screenshot({ path: path.join(evidence, 'last.png'), fullPage: true }).catch(() => {});
        await writeFile(
          path.join(evidence, 'result.json'),
          JSON.stringify(
            { outcome, failure, observations, errors, web, api, threadId: library.threadId, actualYouUse: false },
            null,
            2,
          ),
        );
      } finally {
        await browser.close();
        console.log(`F326 design proof: ${evidence}`);
      }
    });
    try {
      const session = await context.request.get(`${api}/api/session`);
      assert.equal(session.status(), 200);
      const { csrfToken } = await session.json();
      const command = async (command) => {
        const r = await context.request.post(`${api}/api/works/command`, {
          headers: { 'x-csrf-token': csrfToken },
          data: { threadId: library.threadId, command },
        });
        assert.equal(r.status(), 200);
        return r.json();
      };
      const cat = await context.request.get(`${api}/api/threads/${library.threadId}/artifacts?view=works`);
      const catalogue = await cat.json();
      assert.equal(catalogue.artifacts.length, 8);
      await context.addInitScript(() => localStorage.setItem('cat-cafe:shell-presentation', 'v2'));
      await page.goto(`${web}/thread/${library.threadId}`, { waitUntil: 'domcontentloaded' });
      await ensureWorkspaceOpen(page, { readinessTimeoutMs: 90000 });
      await wait(async () => (await readAuthorDraft(page, library.threadId)).length === 0);
      await page
        .locator('section[aria-labelledby="home-works-title"]')
        .getByRole('button', { name: '全部 ›', exact: true })
        .click();
      const panel = page.locator('[data-testid="v2-works-panel"]:visible');
      for (const artifact of catalogue.artifacts) {
        const card = panel.getByTestId('workspace-home-artifact-card').filter({ hasText: artifact.name });
        await card.waitFor();
        assert.ok(artifact.work.versionTimeSource);
        assert.notEqual(artifact.work.versionCreatedAt, artifact.createdAt);
        const time = await page.evaluate((ms) => {
          const d = new Date(ms);
          return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        }, artifact.work.versionCreatedAt);
        assert.ok((await card.locator('..').textContent()).includes(time), `${artifact.name}: ${time}`);
      }
      observations.versionDates = catalogue.artifacts.map((row) => ({
        name: row.name,
        createdAt: row.work.versionCreatedAt,
        source: row.work.versionTimeSource,
        importedAt: row.createdAt,
      }));
      await page.screenshot({ path: path.join(evidence, 'true-version-dates.png'), fullPage: true });
      const work = library.works.find((row) => row.key === 'ai-employment');
      assert.ok(work);
      ownReference = work.versions.at(-1).reference;
      const right = await command({ action: 'read-context', reference: ownReference });
      const left = await command({ action: 'read-context', reference: work.versions[0].reference });
      assert.equal(right.context.chapters.length, 6);
      assert.equal(left.context.chapters.length, 6);
      await panel.getByTestId('workspace-home-artifact-card').filter({ hasText: work.title }).click();
      const surface = page.locator('[data-testid="workspace-content-review-surface"]:visible');
      await surface.waitFor();
      const sidebar = surface.locator('[data-video-work-sidebar]');
      await sidebar.locator('[data-chapter-id="c1"] > button').waitFor();
      assert.equal(await sidebar.locator('[data-chapter-id]').count(), 6);
      assert.ok((await sidebar.textContent()).includes('2:44'));
      assert.equal(
        await surface.getByRole('complementary', { name: '作品讨论', exact: true }).count(),
        0,
        'Discussion starts collapsed',
      );
      const row = right.context.chapters[1];
      await sidebar.locator('[data-chapter-id="c1"] > button').click();
      const video = surface.locator('[data-testid="workspace-review-artwork"] video');
      const tickSeconds = (row, media) => (row.startPts * media.timebase.numerator) / media.timebase.denominator;
      const assetResponse = await context.request.get(
        `${api}/api/content-publications/${encodeURIComponent(ownReference.contentRef)}?ownerRevision=${ownReference.ownerRevision}`,
      );
      const { asset } = await assetResponse.json();
      await observedSeek(video, tickSeconds(row, asset.media));
      assert.ok((await sidebar.locator('[data-chapter-id="c1"] > button').getAttribute('aria-expanded')) === 'true');
      const sentence = right.context.story.find((line) => line.chapterId === 'c1');
      const line = sidebar.locator(`[data-story-id="${sentence.id}"]`);
      await line.getByRole('button').first().click();
      await observedSeek(video, tickSeconds(sentence, asset.media));
      ownAnchor = {
        kind: 'video-range',
        streamId: sentence.streamId,
        startTick: sentence.startPts,
        endTick: sentence.endPts,
        storyEvidence: {
          paragraphId: sentence.id,
          metadataRevision: right.metadataRevision,
          quote: sentence.text || sentence.title,
        },
      };
      await line.getByRole('button', { name: '对这段提意见', exact: true }).click();
      await wait(async () => (await readAuthorDraft(page, library.threadId)).length === 1);
      const draft = await readAuthorDraft(page, library.threadId);
      assert.equal(draft[0].selections[0].selection.storyEvidence.paragraphId, sentence.id);
      await page.screenshot({ path: path.join(evidence, 'chapters-original-composer.png'), fullPage: true });
      await cleanOwnDraft();
      assert.equal(await surface.getByRole('navigation', { name: '影片章节' }).getByRole('button').count(), 6);
      await surface.getByRole('button', { name: '对比版本', exact: true }).click();
      const comparison = surface.getByRole('complementary', { name: '对比版本', exact: true });
      await comparison.getByRole('combobox', { name: '左侧作品版本' }).selectOption('1');
      const selector = comparison.getByRole('combobox', { name: '对齐章节' });
      await selector.waitFor();
      const chapter = right.context.chapters[1];
      await selector.selectOption(chapter.sourceId);
      await comparison.getByRole('button', { name: '两版定位到章首', exact: true }).click();
      const old = comparison.getByLabel('对比原件第 1 版', { exact: true });
      const oldAssetResponse = await context.request.get(
        `${api}/api/content-publications/${encodeURIComponent(ownReference.contentRef)}?ownerRevision=1`,
      );
      const { asset: oldAsset } = await oldAssetResponse.json();
      const expectedOld = tickSeconds(left.context.chapters[1], oldAsset.media),
        expectedNew = tickSeconds(chapter, asset.media);
      observations.chapterAlignment = {
        left: await observedSeek(old, expectedOld),
        right: await observedSeek(video, expectedNew),
        sourceId: chapter.sourceId,
      };
      assert.notEqual(expectedOld, expectedNew);
      assert.equal(await old.getAttribute('controls'), null);
      assert.ok((await comparison.textContent()).includes('第 4 版'));
      assert.ok(!(await comparison.locator('ol > li > strong').allTextContents()).some((label) => /^v\d/.test(label)));
      await page.screenshot({ path: path.join(evidence, 'aligned-independent-chapters.png'), fullPage: true });
      await comparison.getByRole('button', { name: '全屏播放', exact: true }).click();
      await page.waitForFunction(() =>
        document.fullscreenElement?.contains(document.querySelector('video[aria-label="对比原件第 1 版"]')),
      );
      observations.leftFullscreen = await old.evaluate((node) => {
        const host = document.fullscreenElement.getBoundingClientRect();
        const video = node.getBoundingClientRect();
        return {
          hostWidth: host.width,
          hostHeight: host.height,
          videoWidth: video.width,
          videoHeight: video.height,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
        };
      });
      assert.ok(observations.leftFullscreen.videoWidth >= observations.leftFullscreen.viewportWidth - 2);
      assert.ok(observations.leftFullscreen.videoHeight >= observations.leftFullscreen.viewportHeight * 0.8);
      await page.screenshot({ path: path.join(evidence, 'left-player-fullscreen.png'), fullPage: true });
      await comparison.getByRole('button', { name: '退出全屏', exact: true }).click();
      await page.waitForFunction(() => document.fullscreenElement === null);

      await page.setViewportSize({ width: 1100, height: 900 });
      const controls = surface.getByRole('slider');
      observations.narrowControls = await controls.evaluateAll((rows) =>
        rows
          .filter((n) => n.getClientRects().length)
          .map((n) => {
            const b = n.getBoundingClientRect();
            const host = n.closest('[data-artwork-video-player]').getBoundingClientRect();
            return {
              label: n.getAttribute('aria-label'),
              left: b.left,
              right: b.right,
              hostLeft: host.left,
              hostRight: host.right,
            };
          }),
      );
      assert.ok(observations.narrowControls.length >= 4);
      assert.ok(
        observations.narrowControls.every((row) => row.left >= row.hostLeft - 1 && row.right <= row.hostRight + 1),
      );
      await page.screenshot({ path: path.join(evidence, 'narrow-two-players.png'), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      await comparison.getByRole('button', { name: '返回看片', exact: true }).click();
      await sidebar.getByRole('combobox', { name: '故事线或素材' }).selectOption('assets');
      const sequences = sidebar
        .locator('details')
        .filter({ has: page.locator(':scope > summary', { hasText: '帧序列 · 8 组' }) })
        .first();
      await sequences.locator(':scope > summary').click();
      await wait(
        async () =>
          await sequences
            .locator('img')
            .evaluateAll(
              (images) => images.length === 8 && images.every((image) => image.complete && image.naturalWidth > 0),
            ),
      );
      const covers = sidebar
        .locator('details')
        .filter({ has: page.locator(':scope > summary', { hasText: '封面 · 2' }) })
        .first();
      await covers.locator(':scope > summary').click();
      await covers
        .getByRole('button', { name: /^预览 / })
        .first()
        .click();
      await wait(async () => await covers.locator('img').evaluate((node) => node.complete && node.naturalWidth > 0));
      observations.materials = {
        sequences: await sequences.locator('img').count(),
        covers: await covers.locator('li').count(),
        firstCover: await covers.locator('img').getAttribute('src'),
      };
      await page.screenshot({ path: path.join(evidence, 'sequences-and-current-covers.png'), fullPage: true });
      const smallChapterBar = await surface.getByRole('navigation', { name: '影片章节' }).boundingBox();
      const sixChapterViewport = await video.boundingBox();
      observations.sixChapterViewport = sixChapterViewport;
      assert.ok(sixChapterViewport.height > 140);
      await sidebar.getByRole('combobox', { name: '故事线或素材' }).selectOption('story');
      // A seek to the already presented, paused timestamp need not emit another video frame.
      observations.sixChapterFrame = await decodedSeek(video, expectedNew + 1);
      await page.screenshot({ path: path.join(evidence, 'six-chapters.png'), fullPage: true });
      await surface.getByRole('button', { name: '‹ 作品', exact: true }).click();
      const manyChapters = library.works.find((row) => row.key === 'builder-day');
      await panel.getByTestId('workspace-home-artifact-card').filter({ hasText: manyChapters.title }).click();
      const chapterBar = surface.getByRole('navigation', { name: '影片章节' });
      await chapterBar.getByRole('button').nth(48).waitFor();
      assert.equal(await chapterBar.getByRole('button').count(), 49);
      const videoFrame = surface.locator('[data-testid="workspace-review-artwork"] video');
      await videoFrame.waitFor();
      const manyViewport = await videoFrame.boundingBox();
      assert.ok(manyViewport.height > 140, '49 chapters must retain the film viewport');
      observations.manyChapterFrame = await decodedSeek(videoFrame, 5);
      assert.ok(Math.abs((await chapterBar.boundingBox()).height - smallChapterBar.height) < 2);
      assert.ok(await chapterBar.evaluate((node) => node.scrollWidth <= node.clientWidth));
      const lastChapter = chapterBar.getByRole('button').last();
      await lastChapter.focus();
      await chapterBar.getByRole('tooltip').waitFor();
      observations.manyChapterViewport = manyViewport;
      await page.screenshot({ path: path.join(evidence, 'forty-nine-chapters.png'), fullPage: true });
      assert.deepEqual(await readAuthorDraft(page, library.threadId), []);
      assert.deepEqual(errors, []);
      outcome = 'passed';
    } catch (error) {
      outcome = 'failed';
      failure = error.stack;
      throw error;
    }
  },
);
async function wait(predicate) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for the real UI');
}
async function observedSeek(locator, seconds) {
  await wait(async () =>
    locator.evaluate(
      (node, expected) =>
        !node.seeking && node.videoWidth > 0 && node.readyState >= 2 && Math.abs(node.currentTime - expected) < 0.1,
      seconds,
    ),
  );
  return locator.evaluate((node) => ({
    seconds: node.currentTime,
    duration: node.duration,
    seeking: node.seeking,
    readyState: node.readyState,
    width: node.videoWidth,
    height: node.videoHeight,
  }));
}
