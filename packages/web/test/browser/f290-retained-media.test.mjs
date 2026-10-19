import '../../../api/test/helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { retainedMediaBrowserFixture } from './f290-retained-media.harness.mjs';
import { startNext, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { checkRetainedMediaHistory, openRetainedMediaHistory } from './helpers/retained-media-history-journey.mjs';
import { checkRetainedMediaDiscussion } from './helpers/retained-media-review-journey.mjs';

test(
  'normal Host shares retained PNG/MP4, decodes them for independent Humans and returns to the exact discussion',
  { timeout: 150000 },
  async (t) => {
    const configured = process.env.DEFAULT_OWNER_USER_ID;
    delete process.env.DEFAULT_OWNER_USER_ID;
    t.after(() => {
      if (configured !== undefined) process.env.DEFAULT_OWNER_USER_ID = configured;
    });
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.CAT_CAFE_TEST_REAL_HOME && process.platform === 'darwin')
      process.env.PLAYWRIGHT_BROWSERS_PATH = join(
        process.env.CAT_CAFE_TEST_REAL_HOME,
        'Library',
        'Caches',
        'ms-playwright',
      );
    const { chromium } = await import('../../../ppt-forge/node_modules/playwright/index.mjs');
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const hostOrigin = 'http://127.0.0.1:4313';
    const next = startNext(4313);
    t.after(() => stopChild(next));
    await waitForHttp(`${hostOrigin}/collective`, next);
    for (const mime of ['image/png', 'video/mp4']) {
      const f = await retainedMediaBrowserFixture(mime, hostOrigin);
      const contexts = [];
      try {
        let artifact;
        for (const index of [0, 1]) {
          await f.openHost(index, 4314);
          const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
          contexts.push(context);
          await context.addCookies([
            {
              name: 'test-session',
              value: index === 0 ? 'publisher' : 'reader',
              url: hostOrigin,
              httpOnly: true,
              sameSite: 'Lax',
            },
          ]);
          await context.addInitScript(
            ({ origin, token }) => {
              if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
            },
            { origin: f.server.url, token: f.cafes[index].auth.sessionToken },
          );
          const page = await context.newPage();
          page.setDefaultTimeout(15000);
          const responses = [];
          const waitForMetadata = () =>
            page.waitForResponse(
              (response) =>
                response.url().endsWith('/api/artifacts/owner/request') &&
                response.request().postDataJSON()?.action === 'read' &&
                response.status() === 200,
            );
          let metadata;
          page.on('response', (response) => {
            if (response.url().includes('/media/1?')) responses.push(response);
          });
          await page.goto(`${hostOrigin}/collective`);
          const client = page.frameLocator('iframe[title="Collective"]');
          await client
            .getByRole('button', { name: /general/ })
            .first()
            .click();
          try {
            await client.getByText(f.source.body, { exact: true }).first().waitFor({ timeout: 5000 });
          } catch {
            console.log('Host surface:', (await page.locator('body').innerText()).slice(-1500));
            console.log(
              'Client surface:',
              await client
                .locator('body')
                .innerText()
                .catch(() => 'No Client frame'),
            );
            throw new Error('The normal Host did not reach the original discussion');
          }
          if (index === 0) {
            await client.locator('.message').first().hover();
            await client.locator('.message-action-more').first().click();
            await client.getByRole('menuitem', { name: '分享作品…' }).click();
            await client.getByRole('button', { name: '从此 Café 选择图片或视频' }).click();
            await page.getByRole('dialog', { name: '从此 Café 分享图片或视频' }).waitFor();
            await page.getByRole('radio').first().check();
            await page
              .getByLabel('作品名称', { exact: true })
              .fill(mime === 'image/png' ? '共同审阅的红色图片' : '共同审阅的红色视频');
            const published = page.waitForResponse(
              (response) => response.url().endsWith('/artifacts/share-media') && response.status() === 200,
            );
            metadata = waitForMetadata();
            await page.getByRole('button', { name: '分享所选作品' }).click();
            artifact = await (await published).json();
            assert.equal(artifact.contentRef, f.media.asset.contentRef);
            assert.equal(artifact.versions[0].blobDigest, f.media.asset.blobDigest);
          } else {
            await client.getByRole('button', { name: /全部作品/ }).click();
            await openRetainedMediaHistory(client, artifact.title);
            metadata = waitForMetadata();
            await client.getByRole('button', { name: '查看第 1 版', exact: true }).click();
          }
          const surface = page.getByTestId('collective-media-surface');
          await surface.waitFor();
          const projected = (await (await metadata).json()).value;
          assert.equal(projected.blobDigest, f.media.asset.blobDigest);
          assert.equal(projected.mediaType, f.media.asset.mediaType);
          assert.deepEqual(projected.media, f.media.asset.media);
          if (mime === 'image/png') {
            await page.waitForFunction(() => {
              const image = document.querySelector('[data-testid="workspace-content-review-media"]');
              return (
                image instanceof HTMLImageElement &&
                image.complete &&
                image.naturalWidth === 160 &&
                image.naturalHeight === 100
              );
            });
          } else {
            await page.waitForFunction(() => {
              const video = document.querySelector('video');
              return video && video.readyState >= 2 && video.videoWidth === 160;
            });
            await surface.locator('video').evaluate((video) => {
              video.currentTime = 0.6;
            });
            await page.waitForFunction(() => {
              const video = document.querySelector('video');
              return video && !video.seeking && video.currentTime >= 0.5 && video.readyState >= 2;
            });
            assert.ok(
              responses.some((response) => response.status() === 206),
              'native MP4 playback must consume an actual 206 byte range',
            );
          }
          if (process.env.F290_SCREENSHOTS) {
            await mkdir(process.env.F290_SCREENSHOTS, { recursive: true });
            await page.screenshot({
              path: join(process.env.F290_SCREENSHOTS, `${mime.replace('/', '-')}-${index}.png`),
            });
          }
          assert.ok(responses.some((response) => response.status() === (mime === 'image/png' ? 200 : 206)));
          await checkRetainedMediaDiscussion(page, surface, mime, index);
          assert.doesNotMatch(await surface.innerText(), /human_[a-f0-9]{20,}/);
          if (index === 1) {
            await f.reopenRetainedOwner();
            await page.reload();
            await client.getByRole('button', { name: /全部作品/ }).click();
            await openRetainedMediaHistory(client, artifact.title);
            await client.getByRole('button', { name: '查看第 1 版', exact: true }).click();
            await surface.getByRole('button', { name: '打开作品讨论', exact: true }).click();
            await surface.getByText('这处画面请保留，颜色不变。', { exact: true }).waitFor();
            await surface.getByText('已解决', { exact: true }).first().waitFor();
            await surface.getByRole('button', { name: '查看回复', exact: true }).click();
            await surface
              .getByText(/另一位成员已确认，保留红色。/)
              .first()
              .waitFor();
            await checkRetainedMediaHistory({ f, page, client, surface, publisher: contexts[0], artifact, mime });
          }
          if (process.env.F290_SCREENSHOTS)
            await page.screenshot({
              path: join(process.env.F290_SCREENSHOTS, `${mime.replace('/', '-')}-${index}-discussion.png`),
            });
          await surface.getByRole('button', { name: '返回原讨论', exact: true }).click();
          await client.getByText(f.source.body, { exact: true }).first().waitFor();
          await page.close();
        }
      } finally {
        for (const context of contexts) await context.close();
        await f.close();
      }
    }
  },
);
