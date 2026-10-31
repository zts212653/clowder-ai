import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { openChatPage } from './f309-ordinary-workspace-journey-chat-progress.mjs';
import { createReviewState, IMAGE_FIXTURE, reviewView, THREAD_ID } from './f309-ordinary-workspace-journey-fixture.mjs';
import { routeThroughRealOwner, startRealWorkspaceOwner } from './f309-ordinary-workspace-real-owner.mjs';
import { startWorkspaceNetworkProxy } from './f309-workspace-network-proxy.mjs';
import { mediaFixture } from './fixtures/f309-artifact-review-media.mjs';

const evidence = '/tmp/cat-cafe-evidence/f309-artwork-entry';

/** Native chat and file owner; only history/session issuance and the outbound cat send are synthetic. */
export function registerArtworkEntryJourneys(suite) {
  test(
    'artwork entry: v2 uploads enter artwork and external images explain the preview limitation',
    { timeout: 90_000 },
    async () => {
      await mkdir(evidence, { recursive: true });
      const uploadedUrl = '/uploads/artwork-entry.png';
      const asset = {
        contentRef: `prepared-media:${'d'.repeat(64)}`,
        ownerRevision: 1,
        blobDigest: IMAGE_FIXTURE.revision,
        mediaType: 'image/png',
        media: IMAGE_FIXTURE.media,
        sourcePublication: { artifactRef: uploadedUrl, sourceRef: `message:${THREAD_ID}:upload`, revision: '3' },
        ownerReceiptRef: 'fixture-publication-receipt',
      };
      const view = reviewView(createReviewState());
      const { media, mediaType, ...publication } = asset;
      const source = { kind: 'publication', revision: asset.blobDigest, mime: mediaType, media, publication };
      view.review.source = source;
      view.review.contentRef = asset.contentRef;
      view.currentSource = source;
      const messages = [
        {
          from: { kind: 'user', userId: 'operator' },
          id: 'upload',
          type: 'user',
          content: '',
          timestamp: 3,
          contentBlocks: [{ type: 'image', url: uploadedUrl }],
        },
        {
          from: { kind: 'agent', catId: 'codex-terra' },
          id: 'external',
          type: 'assistant',
          catId: 'codex-terra',
          content: '外链',
          timestamp: 4,
          extra: {
            rich: {
              blocks: [
                {
                  kind: 'media_gallery',
                  v: 1,
                  id: 'external',
                  items: [{ url: 'https://external.test/cover.png', alt: '外链图片' }],
                },
              ],
            },
          },
        },
      ];
      // These publication answers are a fixture; the first journey exercises shipped workspace authorization and bytes.
      const opened = await openChatPage(() => ({ ...suite(), baseUrl: `${suite().baseUrl}?shell=v2` }), {
        messages,
        dark: true,
        handleApi: async (_request, url) => {
          if (url.pathname === `/api/threads/${THREAD_ID}/artifacts` || url.pathname === '/api/artifacts') {
            const item = {
              type: 'image',
              name: '原上传图',
              catId: null,
              createdAt: 3,
              sourceMessageId: 'upload',
              url: uploadedUrl,
              publicationItem: { kind: 'content-block', index: 0 },
            };
            return {
              body: {
                threadId: THREAD_ID,
                view: 'works',
                total: 1,
                complete: true,
                artifacts: [{ ...item, threadId: THREAD_ID, threadTitle: '原对话' }],
                workLineage: 'resolved',
              },
            };
          }
          if (url.pathname === '/api/content-publications/resolve')
            return { body: { status: 'resolved', ownerUserId: 'operator', asset } };
          if (url.pathname === '/api/content-reviews/resolve')
            return { body: { ownerUserId: 'operator', contexts: [] } };
          if (
            url.pathname === '/api/content-reviews/prepare' ||
            url.pathname === `/api/content-reviews/${view.review.reviewId}`
          )
            return { body: view };
          if (url.pathname.startsWith('/api/content-publications/'))
            return url.pathname.includes('/media/')
              ? { raw: IMAGE_FIXTURE.bytes, contentType: 'image/png' }
              : { body: { asset, currentOwnerRevision: 1 } };
          return undefined;
        },
      });
      const { context, page, errors } = opened;
      try {
        await page.route('**/uploads/**', (route) =>
          route.fulfill({ contentType: 'image/png', body: IMAGE_FIXTURE.bytes }),
        );
        await page.route('https://external.test/**', (route) =>
          route.fulfill({ contentType: 'image/png', body: IMAGE_FIXTURE.bytes }),
        );
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: '打开作品 图片', exact: true }).click();
        const surface = page.locator('[data-testid="workspace-content-review-surface"]:visible');
        await surface.getByTestId('workspace-content-review-media').waitFor({ timeout: 30_000 });
        await page.screenshot({ path: `${evidence}/v2-upload-dark.png` });
        await surface.getByRole('button', { name: '‹ 聊天', exact: true }).click();
        await page.getByRole('button', { name: 'Enlarge 外链图片', exact: true }).click();
        const preview = page.getByRole('dialog', { name: '外链图片', exact: true });
        await preview.getByText('无法批注', { exact: false }).waitFor();
        await page.screenshot({ path: `${evidence}/v2-external-preview-dark.png` });
        await page.keyboard.press('Escape');
        assert.equal(await preview.count(), 0);
        // Keep the ordinary Home Works card → image preview → annotate journey.
        await ensureWorkspaceOpen(page);
        await page.getByTestId('v2-workspace-home').click();
        const home = page.getByTestId('f307-workspace-home-page');
        await home.waitFor();
        const card = home.getByTestId('workspace-home-artifact-card').filter({ hasText: '原上传图' });
        await card.click();
        const enlarged = page.getByRole('dialog', { name: '原上传图', exact: true });
        await enlarged.waitFor();
        assert.equal(await enlarged.getByRole('button', { name: '批注', exact: true }).count(), 1);
        await enlarged.getByRole('button', { name: '批注', exact: true }).click();
        await surface.getByTestId('workspace-content-review-media').waitFor();
        assert.equal(await surface.locator('textarea').count(), 0);
        await page.screenshot({ path: `${evidence}/studio297-card-1440-dark.png` });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: `${evidence}/studio297-card-390-dark.png` });
        await surface.getByRole('button', { name: /‹.*(首页|Home)/ }).click();
        await card.waitFor();
        assert.deepEqual(errors, []);
      } catch (error) {
        await writeFile(
          `${evidence}/upload-entry-failure.json`,
          JSON.stringify(
            { error: String(error), stack: error.stack, errors, body: await page.locator('body').innerText() },
            null,
            2,
          ),
        );
        await page.screenshot({ path: `${evidence}/upload-entry-failure.png` });
        throw error;
      } finally {
        await context.close();
      }
    },
  );
  test(
    'artwork entry: v2 raw chat media opens the real file owner, circles and returns with its composer intact',
    { timeout: 180_000 },
    async () => {
      await mkdir(evidence, { recursive: true });
      const data = await mkdtemp('/tmp/f309-artwork-entry-data-');
      const owner = await startRealWorkspaceOwner(data);
      let networkProxy;
      const mediaDir = await mkdtemp(path.join(owner.root, 'f309-artwork-entry-'));
      const context = await suite().browser.newContext({ viewport: { width: 1280, height: 900 } });
      const sent = [],
        errors = [];
      try {
        networkProxy = await startWorkspaceNetworkProxy(suite().baseUrl, owner.api);
        const actualReturnedImage = await readFile(
          new URL('../../../../docs/evidence/2026-10-10-f309-5337-parent-alpha/generated.png', import.meta.url),
        );
        await writeFile(path.join(mediaDir, 'cover.png'), actualReturnedImage);
        await writeFile(path.join(mediaDir, 'notes.md'), '# 文档\n\n这一段需要协作批注。\n');
        const audio = Buffer.from(
          'UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          'base64',
        );
        await writeFile(path.join(mediaDir, 'audio.wav'), audio);
        const videoName = await mediaFixture(mediaDir, 'mp4');
        const inventory = await fetch(`${owner.api}/api/workspace/worktrees`).then((response) => response.json());
        const worktree = inventory.worktrees.find((item) => item.root === owner.root);
        assert.ok(worktree);
        const relative = (name) => `${path.basename(mediaDir)}/${name}`;
        const raw = (name) =>
          `/api/workspace/file/raw?${new URLSearchParams({ worktreeId: worktree.id, path: relative(name) })}`;
        const messages = [
          {
            from: { kind: 'user', userId: 'operator' },
            id: 'raw-audio-content',
            type: 'user',
            content: '',
            timestamp: 0,
            contentBlocks: [
              {
                type: 'file',
                url: raw('audio.wav'),
                fileName: 'audio.wav',
                mimeType: 'audio/wav',
                fileSize: audio.length,
              },
            ],
          },
          {
            from: { kind: 'agent', catId: 'codex-terra' },
            id: 'raw-audio-rich',
            type: 'assistant',
            catId: 'codex-terra',
            content: '这是音频文件。',
            timestamp: 0,
            extra: {
              rich: { blocks: [{ kind: 'file', v: 1, id: 'audio', fileName: 'audio.wav', url: raw('audio.wav') }] },
            },
          },
          {
            from: { kind: 'agent', catId: 'codex-terra' },
            id: 'cat-image',
            type: 'assistant',
            catId: 'codex-terra',
            content: '这是工作区里的作品。',
            timestamp: 1,
            extra: {
              rich: {
                blocks: [
                  { kind: 'media_gallery', v: 1, id: 'gallery', items: [{ url: raw('cover.png'), alt: '工作区作品' }] },
                ],
              },
            },
          },
          {
            from: { kind: 'agent', catId: 'codex-terra' },
            id: 'cat-video',
            type: 'assistant',
            catId: 'codex-terra',
            content: '这是视频。',
            timestamp: 2,
            extra: {
              rich: {
                blocks: [
                  { kind: 'file', v: 1, id: 'video', fileName: '片段.mp4', mimeType: 'video/mp4', url: raw(videoName) },
                ],
              },
            },
          },
        ];
        await context.addInitScript(() => localStorage.clear());
        await routeThroughRealOwner(context, owner, {
          extra: async (route, url) => {
            if (url.pathname !== '/api/messages') return false;
            if (route.request().method() === 'POST') sent.push(route.request().postDataJSON());
            await route.fulfill({
              contentType: 'application/json',
              body: JSON.stringify(
                route.request().method() === 'GET' ? { messages, hasMore: false } : { status: 'queued' },
              ),
            });
            return true;
          },
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${networkProxy.baseUrl}?shell=v2`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-testid="workspace-panel-toggle"][data-client-interactive="true"]').waitFor();
        for (const id of ['raw-audio-content', 'raw-audio-rich']) {
          const row = page.locator(`[data-message-id="${id}"]`);
          const download = row.locator('a[download="audio.wav"]');
          await download.waitFor();
          assert.ok((await download.getAttribute('href')).endsWith(raw('audio.wav')));
          assert.equal(await row.getByRole('button', { name: /打开作品/ }).count(), 0);
        }
        const downloadPromise = page.waitForEvent('download');
        await page.locator('[data-message-id="raw-audio-rich"] a[download="audio.wav"]').click();
        const download = await downloadPromise;
        assert.equal(await download.failure(), null);
        assert.equal(download.suggestedFilename(), 'audio.wav');
        assert.deepEqual(await readFile(await download.path()), audio);
        assert.equal(await page.getByRole('dialog').count(), 0);
        await page.screenshot({ path: `${evidence}/v2-raw-audio-download.png` });
        const composer = page.getByLabel('消息输入框');
        await composer.fill('这份未发送的草稿留在这里');
        await page.waitForFunction(
          (id) =>
            new Map(JSON.parse(sessionStorage.getItem('cat-cafe:thread-drafts') ?? '[]')).get(id) ===
            '这份未发送的草稿留在这里',
          THREAD_ID,
        );
        const thumbnail = page.getByRole('button', { name: '打开作品 工作区作品', exact: true });
        await thumbnail.click();
        const surface = page.locator('[data-testid="workspace-content-review-surface"]:visible');
        await surface.getByTestId('workspace-content-review-media').waitFor({ timeout: 30_000 });
        await thumbnail.scrollIntoViewIfNeeded();
        const thumbnailBox = await thumbnail.boundingBox();
        assert.ok(thumbnailBox && thumbnailBox.width < 160, `narrow Chat thumbnail: ${JSON.stringify(thumbnailBox)}`);
        await thumbnail.hover();
        assert.equal(
          await thumbnail.evaluate((button) => {
            const box = button.getBoundingClientRect();
            return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
          }),
          true,
          'the thumbnail center opens the work instead of being intercepted by Copy',
        );
        await thumbnail.click();
        assert.equal(await surface.getAttribute('data-navigation-origin'), 'chat-file-link');
        assert.equal(await page.getByRole('dialog').count(), 0);
        const chatBox = await page.locator('[data-chat-container]').boundingBox();
        const workBox = await surface.boundingBox();
        assert.ok(chatBox && workBox && chatBox.x < workBox.x, 'the running chat stays left of the work');
        assert.ok(chatBox.width / (chatBox.width + workBox.width) < 0.4, 'raw artwork uses the existing 30/70 split');
        const imageBox = await surface.getByTestId('review-media-stage').boundingBox();
        const dock = await surface.getByRole('region', { name: '作品画布工具', exact: true }).boundingBox();
        assert.ok(imageBox && dock && imageBox.x >= workBox.x && imageBox.y >= workBox.y);
        assert.ok(imageBox.x + imageBox.width <= workBox.x + workBox.width + 1);
        assert.ok(
          imageBox.y + imageBox.height <= dock.y + 1,
          'the default full image stays clear of its nearby tool dock',
        );
        assert.ok(dock.y - imageBox.y - imageBox.height <= 24, 'the two image actions stay near the image itself');
        await page.screenshot({ path: `${evidence}/studio297-first-page-1440.png` });
        assert.equal(await surface.locator('textarea').count(), 0, 'the image has no second composer');
        await page.getByRole('button', { name: '圈选', exact: true }).click();
        const box = await page.getByTestId('review-media-stage').boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55);
        await page.mouse.up();
        await page.locator('[data-testid="context-attachment-list"] [data-context-kind="media"]').waitFor();
        assert.equal(await surface.locator('textarea').count(), 0, 'a native region directly joins the existing Chat');
        await page.screenshot({ path: `${evidence}/v2-workspace-circle-chat.png` });
        await surface.getByRole('button', { name: '‹ 聊天', exact: true }).click();
        assert.equal(await composer.inputValue(), '这份未发送的草稿留在这里');
        assert.equal(
          await page.locator('[data-testid="context-attachment-list"] [data-context-kind="media"]').count(),
          1,
        );
        await composer.fill('请修改圈中的地方');
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('[data-testid="context-attachment-list"]'));
        assert.equal(sent.length, 1);
        assert.equal(sent[0].contextAttachments[0].source.locator.path, relative('cover.png'));
        assert.equal(sent[0].content, '请修改圈中的地方');
        assert.equal(sent[0].contextAttachments[0].selections.length, 1);
        await page.getByRole('button', { name: '打开作品', exact: false }).filter({ hasText: '片段.mp4' }).click();
        await surface.locator('video').waitFor();
        await page.screenshot({ path: `${evidence}/v2-workspace-video.png` });
        await surface.getByRole('button', { name: '文件工具', exact: true }).click();
        await page.locator('[data-testid="v2-file-directory"]:visible').click();
        const tree = page.locator('[data-testid="f307-files-owner-surface"]:visible');
        await tree.getByText('cover.png', { exact: true }).click();
        await surface.getByTestId('workspace-content-review-media').waitFor();
        assert.equal(await surface.getAttribute('data-navigation-origin'), 'file-tree');
        await surface.getByRole('button', { name: '文件工具', exact: true }).click();
        await page.locator('[data-testid="v2-file-directory"]:visible').click();
        await tree.getByText('notes.md', { exact: true }).click();
        await surface.getByText('这一段需要协作批注。', { exact: true }).waitFor();
        assert.equal(await surface.getAttribute('data-navigation-origin'), 'file-tree');
        assert.equal(await surface.getByRole('button', { name: '开启协作', exact: false }).count(), 0);
        await page.screenshot({ path: `${evidence}/v2-file-tree-document.png` });
        assert.deepEqual(errors, []);
      } finally {
        await context.unrouteAll({ behavior: 'ignoreErrors' });
        await context.close();
        await networkProxy?.close();
        await owner.close();
        await rm(mediaDir, { recursive: true, force: true });
        await rm(data, { recursive: true, force: true });
      }
    },
  );
}
