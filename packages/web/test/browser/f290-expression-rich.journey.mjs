import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { expressionFixture } from './f290-expression.fixture.mjs';

test(
  'members author rich content normally; another member can reply, operate isolated HTML and read original media',
  { timeout: 180000 },
  async (t) => {
    const step = (label) => process.stdout.write(`F290 rich: ${label}\n`);
    const fixture = await expressionFixture();
    let browser;
    t.after(async () => {
      await browser?.close();
      await fixture.close();
    });
    browser = await chromium.launch({ headless: true });
    const errors = [],
      widgetRequests = [];
    const open = async (token) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addInitScript(
        ({ origin, token }) => {
          if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
        },
        { origin: fixture.url, token },
      );
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === 'widget-probe.invalid') {
          widgetRequests.push(url.pathname);
          return route.abort();
        }
        assert.ok(!['3001', '3002'].includes(url.port));
        return route.continue();
      });
      await page.goto(`${fixture.url}/?collectiveId=${fixture.coordinates.collectiveId}&presentation=v2`, {
        waitUntil: 'networkidle',
      });
      await page.getByRole('button', { name: /general/u }).click();
      await page.locator('.composer[data-draft-ready="true"]').waitFor();
      return { context, page };
    };
    const a = await open(fixture.creator.sessionToken),
      b = await open(fixture.member.sessionToken);
    const chooseEditor = async (label, title, source) => {
      const more = a.page.getByRole('button', { name: '更多输入选项', exact: true });
      if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
      await a.page.getByRole('button', { name: label, exact: true }).click();
      await a.page
        .locator('.composer-rich-editor input[type="text"],.composer-rich-editor input:not([type])')
        .fill(title);
      await a.page.locator('.composer-rich-editor textarea').fill(source);
    };
    const sendRich = async () => {
      await a.page.getByRole('button', { name: '放进草稿', exact: true }).click();
      await a.page.getByRole('button', { name: '发送', exact: true }).click();
      await a.page.locator('.composer-rich-preview').waitFor({ state: 'detached' });
    };
    await chooseEditor('清单', '一起检查', '先读原文\n再一起讨论');
    if (process.env.F290_EXPRESSION_EVIDENCE_DIR) {
      const directory = process.env.F290_EXPRESSION_EVIDENCE_DIR;
      await mkdir(directory, { recursive: true });
      await a.page.screenshot({ path: join(directory, 'rich-editor-1440.png') });
      await a.page.setViewportSize({ width: 390, height: 844 });
      await a.page.screenshot({ path: join(directory, 'rich-editor-390.png') });
      await a.page.setViewportSize({ width: 1440, height: 1000 });
    }
    await a.page.waitForTimeout(400); // let the existing private-draft debounce settle before deliberate restart
    await fixture.restart();
    await a.page.reload({ waitUntil: 'networkidle' });
    assert.equal(await a.page.locator('.composer-rich-editor textarea').inputValue(), '先读原文\n再一起讨论');
    assert.equal(await b.page.locator('.composer-rich-editor').count(), 0);
    await sendRich();
    await b.page.getByText('先读原文', { exact: true }).waitFor();
    step('unfinished rich authoring survives Service/browser restart and remains private until explicit Send');

    await chooseEditor('回复选项', '下一步一起做什么', '继续读原文\n写一点想法');
    await sendRich();
    await b.page.getByRole('button', { name: '继续读原文', exact: true }).click();
    await b.page.getByRole('button', { name: '放进回复草稿', exact: true }).click();
    await b.page.locator('.composer .cafe-quote-comment').filter({ hasText: '继续读原文' }).waitFor();
    await b.page.getByRole('button', { name: '发送', exact: true }).click();
    await a.page.locator('.message-quotes .cafe-quote-comment').filter({ hasText: '继续读原文' }).waitFor();
    step('public choice adds a sourced reply draft and publishes only through the member’s normal Send');

    const html = `<style>body{font-family:system-ui;margin:16px}button{padding:12px}</style>
      <button id="try">试一下</button><p id="boundary">checking</p><img src="https://widget-probe.invalid/static-image.png" alt="blocked probe">
      <script src="https://widget-probe.invalid/static.js"></script>
      <script>
        document.querySelector('#try').addEventListener('click',()=>document.querySelector('#try').textContent='已经点到');
        (async()=>{
          let parentBlocked=false, storageBlocked=false, fetchBlocked=false;
          try{parent.document.body.dataset.widgetTouched='wrong'}catch{parentBlocked=true}
          try{localStorage.setItem('widget-private','wrong')}catch{storageBlocked=true}
          try{await fetch('/api/health')}catch{fetchBlocked=true}
          document.querySelector('#boundary').textContent=[parentBlocked,storageBlocked,fetchBlocked].every(Boolean)?'边界保持':'边界错误';
          const remote=document.createElement('script');remote.nonce=document.currentScript?.nonce||document.querySelector('script[nonce]').nonce;
          remote.src='https://widget-probe.invalid/dynamic.js';document.head.append(remote);
          const image=new Image();image.src='https://widget-probe.invalid/dynamic-image.png';document.body.append(image);
        })();
      </script>`;
    await chooseEditor('HTML 交互', '一起看的交互图', html);
    await sendRich();
    const widget = b.page.frameLocator('iframe[title="一起看的交互图"]');
    await widget.getByText('边界保持', { exact: true }).waitFor();
    await widget.getByRole('button', { name: '试一下', exact: true }).click();
    await widget.getByRole('button', { name: '已经点到', exact: true }).waitFor();
    assert.equal(await b.page.locator('iframe[title="一起看的交互图"]').getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await b.page.locator('body').getAttribute('data-widget-touched'), null);
    assert.deepEqual(widgetRequests, []);
    step(
      'actual HTML executes its local interaction under both CSPs while parent/storage/network access remains blocked',
    );

    await chooseEditor('Diff', 'notes.txt', '@@ -1 +1 @@\n-before\n+after');
    await sendRich();
    await b.page.locator('[data-rich-kind="diff"]').getByRole('row').filter({ hasText: 'before' }).waitFor();
    step('a normal unified hunk is readable through the common diff viewer');

    const audio = join(fixture.directory, 'tone.wav'),
      video = join(fixture.directory, 'clip.webm');
    await promisify(execFile)('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', audio]);
    await promisify(execFile)('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x90:d=0.5',
      '-c:v',
      'libvpx',
      video,
    ]);
    step('generated bounded audio/video fixture bytes');
    await a.page.getByLabel('添加文件', { exact: true }).setInputFiles([
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('original file bytes · 原始正文') },
      { name: 'tone.wav', mimeType: 'audio/wav', buffer: await readFile(audio) },
      { name: 'clip.webm', mimeType: 'video/webm', buffer: await readFile(video) },
    ]);
    await a.page
      .locator('.cafe-attachment-preview[data-status="ready"]')
      .nth(2)
      .waitFor()
      .catch(async (error) => {
        throw new Error(`${error.message}\nUploads: ${await a.page.locator('.cafe-attachment-previews').innerText()}`);
      });
    step('three selected files finished the normal upload queue');
    await a.page.locator('.composer textarea').fill('原文件和音视频');
    await a.page.getByRole('button', { name: '发送', exact: true }).click();
    await b.page.getByText('原文件和音视频', { exact: true }).waitFor();
    step('original file/audio/video references were explicitly published and received');
    const mediaEvent = (
      await fixture.store.listEventsForHuman(fixture.creator.sessionToken, fixture.coordinates.collectiveId)
    ).find((event) => event.body === '原文件和音视频');
    assert.ok(mediaEvent);
    const article = b.page.locator(`[data-event-id="${mediaEvent.eventId}"]`);
    await article.scrollIntoViewIfNeeded();
    for (const name of ['notes.txt', 'tone.wav', 'clip.webm'])
      await article.getByRole('button', { name: new RegExp(name.replace('.', '\\.'), 'u') }).click();
    step('the receiving member opened all three originals');
    await b.page.waitForFunction((id) => {
      const root = document.querySelector(`[data-event-id="${id}"]`);
      return (
        [...root.querySelectorAll('audio,video')].length === 2 &&
        [...root.querySelectorAll('audio,video')].every((media) => media.readyState >= 1 && media.duration > 0)
      );
    }, mediaEvent.eventId);
    step('received audio/video metadata decoded');
    await article.locator('audio,video').evaluateAll((media) =>
      Promise.all(
        media.map((element) => {
          element.muted = true; // Decode/play synthetic fixture bytes; this is not physical audio quality acceptance.
          return element.play();
        }),
      ),
    );
    await b.page.waitForFunction(
      (id) =>
        [...document.querySelectorAll(`[data-event-id="${id}"] audio,[data-event-id="${id}"] video`)].every(
          (media) => media.currentTime > 0,
        ),
      mediaEvent.eventId,
    );
    const pixel = await article.locator('video').evaluate((video) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d');
      context.drawImage(video, 0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    });
    assert.ok(pixel[2] > 200 && pixel[0] < 40, 'The received video must decode the retained blue fixture frame');
    await article.getByRole('button', { name: '放大观看', exact: true }).click();
    await b.page
      .getByRole('dialog', { name: 'clip.webm', exact: true })
      .getByRole('button', { name: '回到原消息', exact: true })
      .click();
    assert.equal(await article.evaluate((node) => document.activeElement === node), true);
    const download = b.page.waitForEvent('download');
    await article.getByRole('link', { name: '下载 notes.txt', exact: true }).click();
    const file = await download;
    assert.equal(await readFile(await file.path(), 'utf8'), 'original file bytes · 原始正文');
    step('the other member downloads the exact file bytes and decodes the actual retained audio/video');

    const long = await fixture.store.postHumanMessage(fixture.creator.sessionToken, {
      ...fixture.coordinates,
      clientEventId: 'long-rich-reading',
      location: { channelId: 'general' },
      recipient: { kind: 'channel' },
      body: '',
      richBlocks: [
        {
          v: 1,
          id: 'long-article',
          kind: 'card',
          title: '长内容也能接着读',
          bodyMarkdown:
            Array.from({ length: 60 }, (_, index) => `这是第 ${index + 1} 段公开内容，要滚动读到最后。`).join('\n\n') +
            '\n\n读到这里了。',
        },
      ],
    });
    await b.page.setViewportSize({ width: 390, height: 844 });
    const longArticle = b.page.locator(`[data-event-id="${long.eventId}"]`);
    await longArticle.waitFor();
    assert.ok(
      (await longArticle.boundingBox()).height > 2 * 844,
      'The actual rendered message must exceed twice the viewport',
    );
    await longArticle.getByText('读到这里了。', { exact: true }).scrollIntoViewIfNeeded();
    let read;
    for (let attempt = 0; attempt < 60; attempt++) {
      read = fixture.store.readHumanChannelState(fixture.member.sessionToken, {
        ...fixture.coordinates,
        channelId: 'general',
      }).read;
      if (read.sequence >= long.sequence) break;
      await b.page.waitForTimeout(100);
    }
    assert.ok(
      read.sequence >= long.sequence,
      `Actually seeing the end of a tall message must advance reading: ${read.sequence} < ${long.sequence}`,
    );
    step('a tall rich message advances the person’s read cursor when its end becomes visible on the narrow screen');

    const reply = await fixture.store.postHumanMessage(fixture.creator.sessionToken, {
      ...fixture.coordinates,
      clientEventId: 'topic-tall-reading',
      location: { channelId: 'general', rootEventId: long.eventId },
      replyToEventId: long.eventId,
      recipient: { kind: 'channel' },
      body:
        Array.from({ length: 50 }, (_, index) => `话题回应第 ${index + 1} 段，仅预览不算完整读取。`).join('\n\n') +
        '\n\n话题回应读到这里。',
    });
    await longArticle.locator('.reply-vitals').waitFor();
    assert.ok(
      fixture.store.readHumanChannelState(fixture.member.sessionToken, { ...fixture.coordinates, channelId: 'general' })
        .read.sequence < reply.sequence,
    );
    await longArticle.locator('.reply-vitals').click();
    const topic = b.page.getByRole('complementary', { name: '话题', exact: true });
    await topic.getByText('话题回应读到这里。', { exact: true }).scrollIntoViewIfNeeded();
    for (let attempt = 0; attempt < 60; attempt++) {
      read = fixture.store.readHumanChannelState(fixture.member.sessionToken, {
        ...fixture.coordinates,
        channelId: 'general',
      }).read;
      if (read.sequence >= reply.sequence) break;
      await b.page.waitForTimeout(100);
    }
    assert.ok(read.sequence >= reply.sequence, 'Visible Topic content must advance the same Human/Channel read cursor');
    await topic.getByRole('button', { name: '关闭话题', exact: true }).click();
    assert.equal(
      await b.page.locator('.channel-unread-return').count(),
      0,
      'The Channel shares the Topic’s observed read state',
    );
    step(
      'reading the Topic advances the same cursor; its compact preview does not, and closing cannot roll it backward',
    );

    const publicEvents = await fixture.store.listEventsForHuman(
      fixture.creator.sessionToken,
      fixture.coordinates.collectiveId,
    );
    assert.ok(publicEvents.every((event) => !event.workRequest && !('richEditor' in event)));
    if (process.env.F290_EXPRESSION_EVIDENCE_DIR) {
      await mkdir(process.env.F290_EXPRESSION_EVIDENCE_DIR, { recursive: true });
      await b.page.setViewportSize({ width: 1440, height: 1000 });
      await article.scrollIntoViewIfNeeded();
      await b.page.screenshot({
        path: join(process.env.F290_EXPRESSION_EVIDENCE_DIR, 'rich-media-1440.png'),
        fullPage: true,
      });
      await b.page.setViewportSize({ width: 390, height: 844 });
      await article.scrollIntoViewIfNeeded();
      await b.page.screenshot({
        path: join(process.env.F290_EXPRESSION_EVIDENCE_DIR, 'rich-media-390.png'),
        fullPage: true,
      });
    }
    assert.deepEqual(errors, []);
    await a.context.close();
    await b.context.close();
  },
);
