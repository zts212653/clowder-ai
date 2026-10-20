import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { THREAD_ID } from './f309-ordinary-workspace-journey-fixture.mjs';
import { routeThroughRealOwner, startRealWorkspaceOwner } from './f309-ordinary-workspace-real-owner.mjs';
import { startWorkspaceNetworkProxy } from './f309-workspace-network-proxy.mjs';
import { mediaFixture } from './fixtures/f309-artifact-review-media.mjs';

const evidence = '/tmp/cat-cafe-evidence/f309-large-video';

async function largeVideo(directory) {
  const file = path.join(directory, 'large-master.mp4');
  // An optional real user film is copied into the private fixture; the original remains untouched.
  if (process.env.F309_LARGE_VIDEO_SOURCE) await copyFile(process.env.F309_LARGE_VIDEO_SOURCE, file);
  else {
    await copyFile(path.join(directory, 'review-input.mp4'), file);
    const handle = await open(file, 'r+');
    try {
      const { size } = await handle.stat();
      const padding = Buffer.alloc(8);
      padding.writeUInt32BE(65 * 1024 * 1024);
      padding.write('free', 4);
      await handle.write(padding, 0, padding.length, size);
      await handle.truncate(size + 65 * 1024 * 1024);
    } finally {
      await handle.close();
    }
  }
  assert.ok((await stat(file)).size > 64 * 1024 * 1024);
  return file;
}

export function registerLargeWorkspaceVideoJourney(suite) {
  test(
    'large video: raw chat artwork streams and seeks while the snapshot limit stays explicit',
    { timeout: 180_000 },
    async () => {
      await mkdir(evidence, { recursive: true });
      const data = await mkdtemp('/tmp/f309-large-video-data-');
      const owner = await startRealWorkspaceOwner(data);
      const media = await mkdtemp(path.join(owner.root, 'f309-large-video-'));
      const context = await suite().browser.newContext({ viewport: { width: 1440, height: 900 } });
      let proxy, page;
      const posts = [],
        ranges = [],
        errors = [];
      try {
        await mediaFixture(media, 'mp4');
        const large = await largeVideo(media);
        const inventory = await fetch(`${owner.api}/api/workspace/worktrees`).then((response) => response.json());
        const worktree = inventory.worktrees.find((entry) => entry.root === owner.root);
        assert.ok(worktree);
        const raw = (name) =>
          `/api/workspace/file/raw?${new URLSearchParams({ worktreeId: worktree.id, path: `${path.basename(media)}/${name}` })}`;
        const messages = ['large-master.mp4', 'review-input.mp4'].map((name, index) => ({
          from: { kind: 'agent', catId: 'codex-terra' },
          id: `video-${index}`,
          type: 'assistant',
          catId: 'codex-terra',
          content: '请查看这段视频。',
          timestamp: index + 1,
          extra: {
            rich: {
              blocks: [
                { kind: 'file', v: 1, id: `film-${index}`, fileName: name, mimeType: 'video/mp4', url: raw(name) },
              ],
            },
          },
        }));
        proxy = await startWorkspaceNetworkProxy(suite().baseUrl, owner.api);
        await context.addInitScript(() => localStorage.clear());
        await routeThroughRealOwner(context, owner, {
          onReviewPost: (post) => posts.push(post),
          extra: async (route, url) => {
            // Keep bytes on the real HTTP streaming proxy, never Playwright's buffered route.fetch/fulfill.
            if (url.pathname === '/api/workspace/file/raw') {
              await route.continue({ url: `${owner.api}${url.pathname}${url.search}` });
              return true;
            }
            if (url.pathname === '/api/messages') {
              await route.fulfill({ json: { messages, hasMore: false } });
              return true;
            }
            // Deliberately unrelated thread project: file identity comes from its raw URL.
            if (url.pathname === `/api/threads/${THREAD_ID}`) {
              await route.fulfill({
                json: { id: THREAD_ID, title: '跨项目看片', projectPath: '/unrelated/film-project' },
              });
              return true;
            }
            return false;
          },
        });
        page = await context.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('response', (response) => {
          if (new URL(response.url()).pathname === '/api/workspace/file/raw')
            ranges.push({
              status: response.status(),
              range: response.headers()['content-range'],
              requestRange: response.request().headers().range,
            });
        });
        await page.goto(`${proxy.baseUrl}?shell=v2`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-testid="workspace-panel-toggle"][data-client-interactive="true"]').waitFor();
        await page
          .locator('[data-message-id="video-0"]')
          .getByRole('button', { name: 'large-master.mp4 打开作品', exact: true })
          .click();
        const dialog = page.getByRole('dialog');
        await dialog.getByText('这个文件太大，暂时无法批注或协作。', { exact: true }).waitFor();
        const video = dialog.locator('video');
        await video.waitFor();
        await video.evaluate(async (element) => {
          element.muted = true;
          await element.play();
        });
        await page.waitForFunction(() =>
          [...document.querySelectorAll('video')].some((element) => element.currentTime > 0.1),
        );
        await video.evaluate((element) => {
          element.currentTime = element.duration * 0.6;
        });
        await page.waitForFunction(() =>
          [...document.querySelectorAll('video')].some(
            (element) => !element.seeking && element.currentTime >= element.duration * 0.6,
          ),
        );
        await video.evaluate((element) => element.pause());
        assert.ok(posts.some((post) => post.status === 413 && post.response.error.code === 'too_large'));
        assert.ok(ranges.some((response) => response.status === 206 && response.range && response.requestRange));
        await page.screenshot({ path: `${evidence}/large-video-1440.png` });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: `${evidence}/large-video-390.png` });
        await page.setViewportSize({ width: 1440, height: 900 });
        await dialog.getByRole('button', { name: '作品模式', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        const work = page.locator('[data-owner-path$="/large-master.mp4"]:visible');
        const workVideo = work.locator('video');
        await workVideo.waitFor();
        await workVideo.evaluate(async (element) => {
          element.muted = true;
          await element.play();
        });
        await page.waitForFunction(() =>
          [...document.querySelectorAll('[data-owner-path] video')].some((element) => element.currentTime > 0.1),
        );
        await page.screenshot({ path: `${evidence}/large-video-work-mode-1440.png` });
        await work.getByRole('button', { name: '‹ 聊天', exact: true }).click();
        await page
          .locator('[data-message-id="video-1"]')
          .getByRole('button', { name: 'review-input.mp4 打开作品', exact: true })
          .click();
        await page.locator('[data-testid="workspace-content-review-media"]:visible').waitFor();
        assert.ok(posts.some((post) => post.status === 200 && post.response.review.source.mime === 'video/mp4'));
        assert.deepEqual(errors, []);
        await writeFile(
          `${evidence}/native-result.json`,
          JSON.stringify(
            { size: (await stat(large)).size, ranges, prepareStatuses: posts.map((post) => post.status), errors },
            null,
            2,
          ),
        );
      } catch (error) {
        await page?.screenshot({ path: `${evidence}/failure.png` });
        await writeFile(
          `${evidence}/failure.json`,
          JSON.stringify(
            { error: String(error), posts, ranges, errors, text: await page?.locator('body').innerText() },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        await context.unrouteAll({ behavior: 'wait' });
        await context.close();
        await proxy?.close();
        await owner.close();
        await rm(media, { recursive: true, force: true });
        await rm(data, { recursive: true, force: true });
      }
    },
  );
}
