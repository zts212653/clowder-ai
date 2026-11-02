import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createNativeArtworkFixture, digest } from './f309-artwork-lightbox-native-fixture.mjs';
import { openDocumentSession } from './f309-ordinary-document-session.mjs';
import { WEB_ROOT } from './f309-ordinary-workspace-journey-fixture.mjs';
import {
  startF309OrdinaryWorkspaceJourney,
  stopF309OrdinaryWorkspaceJourney,
} from './f309-ordinary-workspace-journey-runtime.mjs';
import { checkF326MediaPreviews } from './f326-c-media-previews.mjs';
import { decodedSeek } from './f326-screening-journey.harness.mjs';

export function registerF326C7ArtworkToolsJourney() {
  const evidence = process.env.F326_C7_EVIDENCE_DIR ?? '/tmp/f326-c7-artwork-tools';
  test(
    'same image/video toolbar and exact draft/sent frame deletion without refresh',
    { timeout: 300000 },
    async () => {
      await mkdir(evidence, { recursive: true });
      const fixture = await createNativeArtworkFixture('mp4', evidence);
      let suite, session;
      const result = {
        checkout: {
          cwd: path.resolve(WEB_ROOT, '../..'),
          headSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: WEB_ROOT, encoding: 'utf8' }).trim(),
        },
        outcome: 'running',
        boundaries: [
          'private real content/message owners, shipped soft-delete API and original Chat UI',
          'synthetic Human session/send issuer; no real model dispatch or production C7 acceptance',
        ],
        actualYouUse: false,
        privateApiOrigin: fixture.owner.api,
        input: {
          path: process.env.F309_ORIGINAL_FILM_PATH ?? 'isolated generated video',
          sha256: digest(fixture.original),
          bytes: fixture.original.length,
        },
      };
      try {
        const sourceCovers =
          process.env.F326_C_MEDIA_COVER_LANDSCAPE && process.env.F326_C_MEDIA_COVER_PORTRAIT
            ? [process.env.F326_C_MEDIA_COVER_LANDSCAPE, process.env.F326_C_MEDIA_COVER_PORTRAIT]
            : process.env.F326_C7_COVER_DIR
              ? ['cat-planet-cover-landscape-1920x1080.png', 'cat-planet-cover-portrait-1080x1440.png'].map((name) =>
                  path.join(process.env.F326_C7_COVER_DIR, name),
                )
              : ['antig-opus.png', 'codex.png'].map((name) => path.resolve(WEB_ROOT, '../../assets/avatars', name));
        const imageNames = sourceCovers.map((_source, i) => `c7-cover-${i}.png`);
        for (const [i, source] of sourceCovers.entries())
          await copyFile(source, path.join(path.dirname(fixture.absolute), imageNames[i]));
        const files = [fixture.filename, ...imageNames].map((fileName, i) => ({
          kind: 'file',
          v: 1,
          id: `c7-media-${i}`,
          fileName,
          mimeType: i === 0 ? 'video/mp4' : 'image/png',
          url: `/api/workspace/file/raw?${new URLSearchParams({ worktreeId: fixture.source.locator.worktreeId, path: `${path.dirname(fixture.relative)}/${fileName}` })}`,
        }));
        const publication = fixture.owner.messages.append({
          userId: 'operator',
          threadId: fixture.owner.thread.id,
          from: { kind: 'agent', catId: fixture.owner.catId },
          mentions: [],
          timestamp: Date.now(),
          content: 'Isolated original video and two images',
          extra: { rich: { v: 1, blocks: files } },
        });
        suite = await startF309OrdinaryWorkspaceJourney({ apiUrl: fixture.owner.api });
        session = await openDocumentSession(() => suite, fixture.owner, {
          width: 1440,
          shell: 'v2',
          beforeNavigate: (context) =>
            // Match the fixture's declared synthetic session for legacy POST body identity.
            context.addInitScript(
              (userId) => localStorage.setItem('cat-cafe-userId', userId),
              fixture.owner.thread.createdBy,
            ),
        });
        await fixture.captureSend(session.context);
        const { page } = session;
        result.url = page.url();
        const original = page.locator(`[data-message-id="${publication.id}"]`);
        await original
          .getByRole('button', { name: /打开作品/ })
          .first()
          .click();
        const dialog = page.locator('[role="dialog"]').filter({ has: page.getByTestId('artwork-lightbox-owner') });
        const surface = dialog.getByTestId('workspace-content-review-surface');
        const video = surface.locator('video[data-testid="workspace-content-review-media"]');
        await video.waitFor();
        const duration = await video.evaluate((node) =>
          node.readyState >= 1
            ? node.duration
            : new Promise((resolve) =>
                node.addEventListener('loadedmetadata', () => resolve(node.duration), { once: true }),
              ),
        );
        result.frame = await decodedSeek(video, Math.min(5, duration / 3));
        const toolbar = dialog.getByTestId('artwork-annotation-toolbar');
        const geometry = async () =>
          toolbar.evaluate(
            (node, stage) => ({
              height: node.getBoundingClientRect().height,
              centerOffset:
                (node.getBoundingClientRect().left + node.getBoundingClientRect().right) / 2 -
                stage.x -
                stage.width / 2,
              buttons: [...node.querySelectorAll(':scope > button')].map((button) => ({
                text: button.textContent,
                icon: button.querySelectorAll('svg').length,
                height: button.getBoundingClientRect().height,
                fontSize: getComputedStyle(button).fontSize,
                fontWeight: getComputedStyle(button).fontWeight,
              })),
            }),
            await surface.getByTestId('review-media-stage').boundingBox(),
          );
        result.videoTools = await geometry();
        assert.deepEqual(
          result.videoTools.buttons.map((x) => x.text),
          ['选时间段', '圈这一帧'],
        );
        assert.ok(result.videoTools.buttons.every((x) => x.icon === 1));
        await page.screenshot({ path: path.join(evidence, 'video-zh.png') });
        // The brush lives in the same group's menu. Its centre must be the real pointer target,
        // not something painted over it (gallery strip) or clipped away by the composer panel.
        const more = toolbar.locator('summary[aria-label="更多视频工具"]');
        await more.click();
        const brushInMenu = toolbar.getByRole('button', { name: '画笔', exact: true });
        await brushInMenu.waitFor();
        result.videoMoreBrush = await brushInMenu.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return {
            hit: node.contains(at),
            target: at ? `${at.tagName.toLowerCase()}${at.dataset.testid ? `[${at.dataset.testid}]` : ''}` : null,
            box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
          };
        });
        await page.screenshot({ path: path.join(evidence, 'video-more-zh.png') });
        assert.ok(result.videoMoreBrush.hit, JSON.stringify(result.videoMoreBrush));
        await more.click();
        const language = async (value) =>
          page.evaluate((value) => {
            localStorage.setItem('cat-cafe:shell-language', value);
            window.dispatchEvent(new CustomEvent('cat-cafe:shell-language-sync'));
          }, value);
        await language('en');
        await toolbar.getByRole('button', { name: 'Circle frame', exact: true }).waitFor();
        await page.screenshot({ path: path.join(evidence, 'video-en.png') });
        await dialog.getByTestId('artwork-gallery-thumbnails').getByRole('button').nth(1).click();
        await surface.locator('img[data-testid="workspace-content-review-media"]').evaluate((img) => img.decode());
        await toolbar.getByRole('button', { name: 'Brush', exact: true }).waitFor();
        result.imageTools = await geometry();
        assert.ok(Math.abs(result.videoTools.centerOffset) < 2, JSON.stringify(result.videoTools));
        assert.ok(Math.abs(result.imageTools.centerOffset) < 2, JSON.stringify(result.imageTools));
        assert.deepEqual(
          result.imageTools.buttons.map((x) => x.text),
          ['Select', 'Brush'],
        );
        assert.equal(result.videoTools.height, result.imageTools.height);
        const appearance = ({ text, ...style }) => style;
        assert.deepEqual(result.videoTools.buttons.map(appearance), result.imageTools.buttons.map(appearance));
        await page.screenshot({ path: path.join(evidence, 'image-en.png') });
        await language('zh');
        await toolbar.getByRole('button', { name: '画笔', exact: true }).waitFor();
        await page.screenshot({ path: path.join(evidence, 'image-zh.png') });
        await dialog.getByTestId('artwork-gallery-thumbnails').getByRole('button').first().click();
        // Returning to the video restores its saved playhead after loadedmetadata.
        // Let that owner finish before the next seek, rather than racing it with a DOM write.
        await page.waitForFunction(() => {
          const node = document.querySelector('[role="dialog"] video[data-testid="workspace-content-review-media"]');
          return node && node.readyState >= 2 && node.seekable.length > 0 && !node.seeking;
        });
        result.returnedFrame = await decodedSeek(video, Math.min(6, duration / 2));
        const circle = async (left, right, words = '隔离验证标记') => {
          await toolbar.getByRole('button', { name: '圈这一帧', exact: true }).click();
          const rect = await surface.getByTestId('review-media-stage').boundingBox();
          assert.ok(rect?.height > 100);
          await page.mouse.move(rect.x + rect.width * left, rect.y + rect.height * 0.25);
          await page.mouse.down();
          await page.mouse.move(rect.x + rect.width * right, rect.y + rect.height * 0.55, { steps: 6 });
          await page.mouse.up();
          await page.getByRole('textbox', { name: '这处的话', exact: true }).fill(words);
          await page.getByRole('button', { name: '保留', exact: true }).click();
        };
        await circle(0.2, 0.4, '这只猫的表情再明显一点');
        const secondSeconds = Math.min(42, duration * 0.5);
        await decodedSeek(video, secondSeconds);
        await circle(0.6, 0.8, '报告标题停留久一点');
        result.mediaPreviews = await checkF326MediaPreviews({
          page,
          surface,
          toolbar,
          dialog,
          video,
          evidence,
          duration,
          circle,
          language,
        });
        const group = page.getByTestId('gallery-composer-group');
        const marks = surface.getByTestId('review-pending-chat-mark');
        assert.equal(await marks.count(), 2);
        const ids = await marks.evaluateAll((nodes) => nodes.map((n) => n.dataset.selectionId));
        await group.getByRole('button', { name: `打开图 1 · 第 ${ids[0]} 处`, exact: true }).click();
        // Opening a place is asynchronous. Wait for the selected presentation, not the previous surface's marks.
        await surface
          .locator(`[data-testid="review-pending-chat-mark"][data-selection-id="${ids[0]}"][data-active="true"]`)
          .waitFor();
        const draftVideo = await video.elementHandle();
        await page.waitForFunction(
          ({ video, seconds }) => !video.seeking && Math.abs(video.currentTime - seconds) < 1 / 30,
          { video: draftVideo, seconds: Math.min(6, duration / 2) },
        );
        await toolbar.getByRole('button', { name: '圈这一帧', exact: true }).waitFor({ state: 'visible' });
        await page.waitForFunction(
          (button) => !button.disabled,
          await toolbar.getByRole('button', { name: '圈这一帧', exact: true }).elementHandle(),
        );
        await page.screenshot({ path: path.join(evidence, 'draft-before-delete.png') });
        await group.getByRole('button', { name: `移除选区 ${ids[0]}`, exact: true }).click();
        await page.waitForFunction(
          (id) =>
            ![
              ...document.querySelectorAll(
                '[data-testid="artwork-lightbox-owner"] [data-testid="review-pending-chat-mark"]',
              ),
            ].some((n) => n.dataset.selectionId === id),
          ids[0],
        );
        await surface.locator(`[data-testid="review-pending-chat-mark"][data-selection-id="${ids[1]}"]`).waitFor();
        assert.deepEqual(await marks.evaluateAll((nodes) => nodes.map((n) => n.dataset.selectionId)), [ids[1]]);
        assert.equal(await video.evaluate((node, original) => node === original, draftVideo), true);
        assert.ok(Math.abs((await video.evaluate((node) => node.currentTime)) - Math.min(6, duration / 2)) < 1 / 30);
        await page.screenshot({ path: path.join(evidence, 'draft-after-delete.png') });
        result.draftDeletion = { removed: ids[0], preserved: ids[1], noRefresh: true };
        const composer = page.getByRole('textbox', { name: '消息输入框', exact: true });
        await composer.fill(`@${fixture.owner.catId} 隔离验证，仅保留后一处。`);
        await dialog.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[aria-label="消息输入框"]')?.value === '');
        const sent = fixture.sent.at(-1);
        assert.ok(sent);
        assert.equal(sent.input.contextAttachments[0].selections.length, 1);
        await dialog.getByRole('button', { name: '关闭作品', exact: true }).click();
        // Load the already-sent message once, before opening the counterexample. No refresh after deletion below.
        await page.reload({ waitUntil: 'domcontentloaded' });
        const sentRow = page.locator(`[data-message-id="${sent.message.id}"]`);
        await sentRow.getByRole('button', { name: `打开图 1 · 第 ${ids[1]} 处`, exact: true }).click();
        await marks.first().waitFor();
        await dialog.getByTestId('lightbox-open-workspace').click();
        await dialog.waitFor({ state: 'detached' });
        const work = page.locator('[data-testid="workspace-content-review-surface"]:visible');
        const sentMarks = work.getByTestId('review-pending-chat-mark');
        await sentMarks.first().waitFor();
        const heldVideo = await work.locator('video').elementHandle();
        await page.waitForFunction(
          ({ video, seconds }) => !video.seeking && Math.abs(video.currentTime - seconds) < 1 / 30,
          { video: heldVideo, seconds: secondSeconds },
        );
        await page.waitForFunction(
          (button) => !button.disabled,
          await work.getByRole('button', { name: '圈这一帧', exact: true }).elementHandle(),
        );
        await page.screenshot({ path: path.join(evidence, 'sent-before-delete.png') });
        const beforeDelete = await heldVideo.evaluate((node) => ({
          seconds: node.currentTime,
          src: node.currentSrc,
          paused: node.paused,
        }));
        await sentRow.hover();
        // The shipped v2 action plane is portalled, but binds its exact message owner.
        await page
          .locator(`[data-message-actions-owner="${sent.message.id}"]`)
          .locator('[data-testid="message-actions-toolbar"]')
          .getByRole('button', { name: '删除', exact: true })
          .click();
        result.videoAtConfirmation = await work.locator('video').evaluate(
          (node, original) => ({
            sameElement: node === original,
            originalConnected: original.isConnected,
            seconds: node.currentTime,
            src: node.currentSrc,
          }),
          heldVideo,
        );
        const deleteResponse = page.waitForResponse(
          (response) =>
            response.request().method() === 'DELETE' &&
            new URL(response.url()).pathname === `/api/messages/${sent.message.id}`,
        );
        await page
          .getByRole('dialog', { name: '删除消息', exact: true })
          .getByRole('button', { name: '删除', exact: true })
          .click();
        const response = await deleteResponse;
        assert.equal(response.status(), 200, await response.text());
        await sentRow.waitFor({ state: 'detached' });
        await page.waitForFunction(
          () =>
            ![...document.querySelectorAll('[data-testid="workspace-content-review-surface"]')]
              .filter((n) => n.getClientRects().length)
              .some((n) => n.querySelector('[data-testid="review-pending-chat-mark"]')),
        );
        const sameVideoElement = await work.locator('video').evaluate((node, original) => node === original, heldVideo);
        const afterDelete = await work.locator('video').evaluate((node) => ({
          seconds: node.currentTime,
          src: node.currentSrc,
          paused: node.paused,
        }));
        result.sentDeletion = {
          messageId: sent.message.id,
          status: response.status(),
          sameVideoElement,
          beforeDelete,
          afterDelete,
          noPageReload: true,
        };
        assert.equal(sameVideoElement, true);
        assert.equal(afterDelete.src, beforeDelete.src);
        assert.equal(afterDelete.paused, beforeDelete.paused);
        assert.ok(Math.abs(afterDelete.seconds - beforeDelete.seconds) < 1 / 30);
        await page.screenshot({ path: path.join(evidence, 'sent-after-delete.png') });
        const deletion = session.calls.find(
          (x) => x.method === 'DELETE' && x.path === `/api/messages/${sent.message.id}`,
        );
        assert.equal(deletion?.status, 200);
        assert.ok((await fixture.owner.messages.getById(sent.message.id)).deletedAt);
        result.deletionRoute = deletion;
        result.errors = session.errors;
        assert.deepEqual(session.errors, []);
        result.outcome = 'passed';
      } catch (error) {
        result.outcome = 'failed';
        result.failure = error.stack;
        result.errors = session?.errors;
        result.calls = session?.calls.map(({ method, path, status, upstream }) => ({ method, path, status, upstream }));
        result.failureText = await session?.page
          ?.locator('body')
          .innerText()
          .catch(() => null);
        throw error;
      } finally {
        await session?.page?.screenshot({ path: path.join(evidence, 'last.png') }).catch(() => {});
        result.cleanup = 'pending';
        await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
        // Stop new application traffic, then drain the private streaming proxies before disposal.
        await session?.page?.route('**/*', (route) => route.abort());
        await session?.context?.unrouteAll({ behavior: 'wait' });
        await session?.context?.close();
        await stopF309OrdinaryWorkspaceJourney(suite);
        await fixture.close();
        result.cleanup = 'passed';
        await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
      }
    },
  );
}
