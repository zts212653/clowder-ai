import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { expressionFixture } from './f290-expression.fixture.mjs';
import { expressionHostFixture } from './f290-expression-voice.fixture.mjs';

test(
  'all eight public kinds and original inline/gallery images render through the real Host language/theme bridge',
  { timeout: 180000 },
  async (t) => {
    const host = await expressionHostFixture({ appearanceControls: true });
    const fixture = await expressionFixture({ allowedHostOrigins: [host.url] });
    let browser;
    t.after(async () => {
      await browser?.close();
      await fixture.close();
      await host.close();
    });
    host.setService(fixture.url);
    const exec = promisify(execFile);
    const files = [
      {
        name: 'view-a.png',
        type: 'image/png',
        command: ['-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=0.04', '-frames:v', '1'],
      },
      {
        name: 'view-b.png',
        type: 'image/png',
        command: ['-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=0.04', '-frames:v', '1'],
      },
      { name: 'tone.wav', type: 'audio/wav', command: ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5'] },
      {
        name: 'clip.webm',
        type: 'video/webm',
        command: ['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=0.5', '-an', '-c:v', 'libvpx'],
      },
      { name: 'notes.txt', type: 'text/plain' },
    ];
    const attachments = [];
    for (const [index, file] of files.entries()) {
      const path = join(fixture.directory, file.name);
      if (file.command) await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...file.command, path]);
      else await writeFile(path, 'original bilingual file · 原始文件');
      const bytes = await readFile(path);
      attachments.push(
        await fixture.store.uploadMessageAttachment(
          fixture.creator.sessionToken,
          {
            ...fixture.coordinates,
            channelId: 'general',
            clientUploadId: `gallery-original-${index}`,
            fileName: file.name,
            mediaType: file.type,
            blobDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          },
          Readable.from([bytes]),
          new AbortController().signal,
        ),
      );
    }
    const [inline, gallery, audio, , file] = attachments;
    const richBlocks = [
      {
        v: 1,
        id: 'card',
        kind: 'card',
        title: '公开内容 / Public content',
        bodyMarkdown: `![画面 A / View A](${inline.contentRef})`,
      },
      {
        v: 1,
        id: 'gallery',
        kind: 'media_gallery',
        title: '一起看 / Gallery',
        items: [{ url: gallery.contentRef, alt: '画面 B / View B' }],
      },
      {
        v: 1,
        id: 'audio',
        kind: 'audio',
        title: '音频 / Audio',
        url: audio.contentRef,
        text: '原音频 / Original recording',
      },
      {
        v: 1,
        id: 'file',
        kind: 'file',
        url: file.contentRef,
        fileName: file.fileName,
        fileSize: file.byteLength,
        mimeType: file.mediaType,
      },
      {
        v: 1,
        id: 'widget',
        kind: 'html_widget',
        title: '公共交互 / Public interaction',
        height: 180,
        html: '<button id="try">试一下 / Try</button><script>document.getElementById("try").addEventListener("click",e=>e.target.textContent="已响应 / Responded")</script>',
      },
      { v: 1, id: 'diff', kind: 'diff', filePath: 'notes.txt', diff: '@@ -1 +1 @@\n-before\n+after' },
      {
        v: 1,
        id: 'check',
        kind: 'checklist',
        title: '一起确认 / Check',
        items: [{ id: 'original', text: '同一份原件 / Same original', checked: true }],
      },
      {
        v: 1,
        id: 'choices',
        kind: 'interactive',
        interactiveType: 'select',
        title: '下一步 / Next',
        options: [{ id: 'read', label: '继续读 / Continue' }],
      },
    ];
    const event = await fixture.store.postHumanMessage(fixture.creator.sessionToken, {
      ...fixture.coordinates,
      clientEventId: 'all-eight-public',
      location: { channelId: 'general' },
      recipient: { kind: 'channel' },
      body: '同一份公开消息 / One public message',
      attachments,
      richBlocks,
    });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    await context.addInitScript(
      ({ serviceOrigin, hostOrigin, token }) => {
        if (location.origin === hostOrigin) localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        if (location.origin === serviceOrigin) sessionStorage.setItem(`collective-session:${serviceOrigin}`, token);
      },
      { serviceOrigin: fixture.url, hostOrigin: host.url, token: fixture.member.sessionToken },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      assert.ok(!['3001', '3002'].includes(new URL(route.request().url()).port));
      return route.continue();
    });
    await page.goto(`${host.url}/collective`, { waitUntil: 'networkidle' });
    const frame = page.frameLocator('iframe[title="Collective"]');
    await frame.getByRole('button', { name: '先逛逛', exact: true }).click();
    await frame.getByRole('button', { name: /general/u }).click();
    await frame.locator('.composer[data-draft-ready="true"]').waitFor();
    const article = frame.locator(`[data-event-id="${event.eventId}"]`);
    assert.equal(await article.locator('[data-rich-kind]').count(), 8);
    const privateDraft = 'My private draft · 我的私人草稿';
    await frame.locator('.composer textarea').fill(privateDraft);
    await article.locator('[data-rich-block="card"]').scrollIntoViewIfNeeded();
    await article.getByRole('img', { name: '画面 A / View A', exact: true }).waitFor();
    await article.locator('[data-rich-block="gallery"]').scrollIntoViewIfNeeded();
    await article.getByRole('img', { name: '画面 B / View B', exact: true }).waitFor();
    const originalImageUrls = new Map();
    for (const name of ['画面 A / View A', '画面 B / View B']) {
      originalImageUrls.set(
        name,
        await article.getByRole('img', { name, exact: true }).evaluate(async (node) => {
          await node.decode();
          return node.getAttribute('src');
        }),
      );
    }
    assert.equal(
      await article.locator('.message-image-attachment').count(),
      2,
      'An inline image must not repeat in the attachment list',
    );
    await article.getByRole('button', { name: /^tone.wav ·/u }).click();
    await article.locator('audio').waitFor();
    await article.getByRole('button', { name: /^clip.webm ·/u }).click();
    await article.locator('video').waitFor();
    const widget = frame.frameLocator('iframe[title="公共交互 / Public interaction"]');
    await widget.getByRole('button', { name: '试一下 / Try', exact: true }).click();
    await widget.getByRole('button', { name: '已响应 / Responded', exact: true }).waitFor();

    for (const language of ['zh', 'en']) {
      await page.getByRole('button', { name: language === 'en' ? 'English' : '中文', exact: true }).click();
      for (const scheme of ['light', 'dark']) {
        await page.getByRole('button', { name: scheme === 'dark' ? 'Dark' : 'Light', exact: true }).click();
        await frame.locator(`html[data-theme="${scheme}"][lang="${language === 'en' ? 'en' : 'zh-CN'}"]`).waitFor();
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
          await article.locator('[data-rich-block="gallery"]').scrollIntoViewIfNeeded();
          const galleryButton = article.getByRole('button', {
            name: `${language === 'en' ? 'Open original' : '打开原图'}：画面 B / View B`,
            exact: true,
          });
          await galleryButton.click();
          await frame
            .getByRole('dialog', { name: gallery.fileName, exact: true })
            .getByRole('button', { name: language === 'en' ? 'Back to message' : '回到原消息', exact: true })
            .click();
          assert.equal(await article.evaluate((node) => document.activeElement === node), true);
          assert.equal(
            await frame.locator('.composer textarea').inputValue(),
            privateDraft,
            'Host appearance changes must not replace the current Human draft',
          );
          await article
            .locator('[data-rich-block="choices"]')
            .getByRole('button', { name: language === 'en' ? 'Add to reply draft' : '放进回复草稿', exact: true })
            .waitFor({ state: 'attached' });
          assert.equal(
            await frame.locator('html').evaluate((node) => node.scrollWidth <= innerWidth + 1),
            true,
            'The narrow screen must not acquire page-wide overflow',
          );
          for (const [name, originalUrl] of originalImageUrls) {
            const decoded = await article.getByRole('img', { name, exact: true }).evaluate(async (node) => {
              await node.decode();
              return { url: node.getAttribute('src'), width: node.naturalWidth, height: node.naturalHeight };
            });
            assert.equal(
              decoded.url,
              originalUrl,
              'Unrelated appearance/read updates must not unmount and refetch an inline image',
            );
            assert.deepEqual([decoded.width, decoded.height], [320, 180]);
          }
          await article.locator('[data-rich-block="card"]').scrollIntoViewIfNeeded();
          if (process.env.F290_EXPRESSION_EVIDENCE_DIR) {
            await mkdir(process.env.F290_EXPRESSION_EVIDENCE_DIR, { recursive: true });
            await page.screenshot({
              path: join(process.env.F290_EXPRESSION_EVIDENCE_DIR, `gallery-${language}-${scheme}-${width}.png`),
              fullPage: true,
            });
          }
          process.stdout.write(
            `F290 gallery: real Host ${language}/${scheme}/${width}, original images, source focus and private draft retained\n`,
          );
        }
      }
    }
    assert.deepEqual(errors, []);
    const events = await fixture.store.listEventsForHuman(
      fixture.creator.sessionToken,
      fixture.coordinates.collectiveId,
    );
    assert.equal(events.filter((row) => row.clientEventId === 'all-eight-public').length, 1);
    assert.ok(events.every((row) => !row.workRequest));
  },
);
