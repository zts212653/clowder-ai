import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { fulfillFixtureApi, ordinaryVideoFixture } from './f309-ordinary-workspace-journey-actions.mjs';
import { createReviewState } from './f309-ordinary-workspace-journey-fixture.mjs';
import { startRealWorkspaceOwner } from './f309-ordinary-workspace-real-owner.mjs';
import { mediaFixture } from './fixtures/f309-artifact-review-media.mjs';

export function registerOrdinaryVideoJourney(suite) {
  test(
    'ordinary MP4 owner endpoint lets Chromium seek to an actually presented frame',
    { timeout: 90_000 },
    async () => {
      const root = await mkdtemp('/tmp/f309-real-video-seek-');
      const owner = await startRealWorkspaceOwner(path.join(root, 'data'));
      const fixtureDir = await mkdtemp(path.join(owner.root, 'f309-real-video-seek-'));
      const context = await suite().browser.newContext();
      const page = await context.newPage();
      const mediaResponses = [];
      page.on('response', (response) => {
        if (response.url().includes('/content-reviews/') && response.url().includes('/media?'))
          mediaResponses.push({ status: response.status(), contentRange: response.headers()['content-range'] });
      });
      try {
        const filename = await mediaFixture(fixtureDir, 'mp4');
        const inventory = await fetch(`${owner.api}/api/workspace/worktrees`).then((response) => response.json());
        const worktree = inventory.worktrees.find((entry) => entry.root === owner.root);
        assert.ok(worktree, 'the real file must be inside the registered F063 owner root');
        const prepared = await fetch(`${owner.api}/api/workspace/content-reviews/prepare`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            locator: { worktreeId: worktree.id, path: `${path.basename(fixtureDir)}/${filename}` },
            operationId: 'open-real-video-seek',
          }),
        });
        assert.equal(prepared.status, 200, prepared.status === 200 ? '' : await prepared.text());
        const { review } = await prepared.json();
        const mediaUrl = `${owner.api}/api/workspace/content-reviews/${review.reviewId}/media?expectedSourceRevision=${encodeURIComponent(review.source.revision)}`;
        await page.setContent('<video controls preload="auto"></video>');
        await page.locator('video').evaluate((video, url) => {
          video.src = url;
        }, mediaUrl);
        await page.waitForFunction(() => {
          const video = document.querySelector('video');
          return video?.readyState >= HTMLMediaElement.HAVE_METADATA && video.seekable.length > 0;
        });
        const initial = await page.locator('video').evaluate((video) => ({
          width: video.videoWidth,
          duration: video.duration,
          seekableEnd: video.seekable.end(0),
        }));
        assert.ok(initial.width > 0 && initial.duration > 2 && initial.seekableEnd > 2, JSON.stringify(initial));
        await page.locator('video').evaluate((video) => {
          window.__f309RealOwnerFrames = [];
          const observe = (_now, frame) => {
            window.__f309RealOwnerFrames.push(frame.mediaTime);
            video.requestVideoFrameCallback(observe);
          };
          video.requestVideoFrameCallback(observe);
          video.pause();
          video.currentTime = 0.8;
        });
        await page.waitForFunction(() => {
          const video = document.querySelector('video');
          return (
            video &&
            !video.seeking &&
            Math.abs(video.currentTime - 0.8) < 0.05 &&
            window.__f309RealOwnerFrames.some((frame) => Math.abs(frame - 0.8) < 0.05)
          );
        });
        assert.ok(
          mediaResponses.some((response) => response.status === 206 && response.contentRange?.startsWith('bytes ')),
          JSON.stringify(mediaResponses),
        );
      } finally {
        await context.close();
        await owner.close();
        await rm(fixtureDir, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test(
    'ordinary Workspace MP4 discussion card seeks to its anchored frame before revealing the mark',
    { timeout: 90_000 },
    async () => {
      const state = createReviewState(await ordinaryVideoFixture());
      state.annotations.push({
        id: 'ordinary-video-annotation',
        anchor: {
          baseRevision: state.fixture.revision,
          anchor: {
            kind: 'video-range',
            streamId: 'ordinary-video-stream',
            startTick: 2500,
            endTick: 2800,
            framePoint: { tick: 2500, x: 320, y: 180 },
          },
        },
        body: '这条普通 MP4 讨论必须回到已定位帧。',
        author: { kind: 'human', actorId: 'operator' },
        createdAt: '2026-09-18T00:00:00.000Z',
        updatedAt: '2026-09-18T00:00:00.000Z',
        state: 'open',
        replies: [],
      });
      const actionKinds = [];
      const { browser, baseUrl } = suite();
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addInitScript(() => window.localStorage.clear());
      const page = await context.newPage();
      const errors = [];
      const failedRequests = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('requestfailed', (request) =>
        failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`),
      );
      await page.route('**/api/**', (route) => fulfillFixtureApi(route, state, actionKinds));

      try {
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
        await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 20_000 });
        await page.locator('[data-chat-container]').waitFor();
        await ensureWorkspaceOpen(page);
        const home = page.getByTestId('workspace-launcher-home');
        await home.getByTestId('workspace-launcher-search').fill('clip');
        await home.getByTestId('workspace-launcher-file-result').filter({ hasText: '文件名' }).click();
        // AC-U1 (F309 feature doc :701) / Phase U plan :30: the file lands in collaboration directly.
        await page.getByTestId('workspace-content-review-surface').waitFor();
        const video = page.getByTestId('workspace-content-review-media');
        await video.waitFor();
        await video.evaluate(
          (element) =>
            new Promise((resolve, reject) => {
              const media = element;
              if (media.readyState >= HTMLMediaElement.HAVE_METADATA) return resolve();
              media.addEventListener('loadedmetadata', resolve, { once: true });
              media.addEventListener('error', () => reject(new Error('ordinary MP4 failed to load')), { once: true });
            }),
        );

        await page.getByRole('button', { name: '打开作品讨论', exact: true }).click();
        await page.getByRole('button', { name: '已定位', exact: true }).click();
        try {
          await page.waitForFunction(() => {
            const media = document.querySelector('[data-testid="workspace-content-review-media"]');
            return media instanceof HTMLVideoElement && Math.abs(media.currentTime - 2.5) < 0.05;
          });
        } catch (error) {
          const playhead = await video.evaluate((element) => ({
            currentTime: element.currentTime,
            duration: element.duration,
            readyState: element.readyState,
            seeking: element.seeking,
            seekable: [
              ...Array.from({ length: element.seekable.length }, (_, index) => [
                element.seekable.start(index),
                element.seekable.end(index),
              ]),
            ],
          }));
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\nvideo: ${JSON.stringify(playhead)}`,
          );
        }
        await page.getByTestId('review-canvas-annotation-mark').waitFor();
        assert.equal(await video.evaluate((element) => Math.abs(element.currentTime - 2.5) < 0.05), true);
        await video.evaluate((element) => {
          element.currentTime = 0;
          element.dispatchEvent(new Event('timeupdate'));
        });
        await page.waitForFunction(() => !document.querySelector('[data-testid="review-canvas-annotation-mark"]'));

        await page.getByRole('button', { name: '已定位', exact: true }).click();
        await page.waitForFunction(() => {
          const media = document.querySelector('[data-testid="workspace-content-review-media"]');
          return media instanceof HTMLVideoElement && Math.abs(media.currentTime - 2.5) < 0.05;
        });
        const annotationMark = page.getByTestId('review-canvas-annotation-mark');
        await annotationMark.waitFor();
        await page.keyboard.press('Escape');
        await page.waitForFunction(
          () => document.activeElement?.getAttribute('data-testid') === 'review-canvas-annotation-mark',
        );
        assert.deepEqual(errors, []);
      } catch (error) {
        const body = await page
          .locator('body')
          .innerText()
          .catch(() => 'unavailable');
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\npage errors: ${errors.join(' | ')}\nfailed requests: ${failedRequests.join(' | ')}\nbody: ${body.slice(0, 4000)}`,
        );
      } finally {
        await context.close();
      }
    },
  );
}
