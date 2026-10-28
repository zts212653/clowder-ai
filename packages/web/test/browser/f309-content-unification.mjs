import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, resolve } from 'node:path';
import { assertWorkCardChrome } from './fixtures/work-card-chrome.mjs';

const wt = resolve(process.env.F309_WORKTREE_ROOT ?? process.cwd());
const require = createRequire(wt + '/package.json');
const { chromium } = require('playwright');
const ev = process.env.F309_EVIDENCE_DIR ?? resolve(wt, '.cat-cafe/evidence/content-unification');
const run = process.env.F309_AUTHOR_RUN || 'author-native-r1';
const out = ev + '/' + run;
await mkdir(out, { recursive: true, mode: 0o700 });
const web = process.env.F309_WEB_URL ?? 'http://localhost:35131',
  api = process.env.F309_API_URL ?? 'http://localhost:35132';
for (const input of [web, api]) {
  const url = new URL(input);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.ok(!['3001', '3002'].includes(url.port), 'author runs require their own isolated application');
}
const inputPath = process.env.F309_INPUT_PATH;
if (!inputPath)
  throw new Error(
    'Set F309_INPUT_PATH to a read-only Chinese Markdown input. It will be uploaded as an explicit isolated test copy.',
  );
const filename = basename(inputPath);
const bytes = await readFile(inputPath);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const result = {
  run,
  startedAt: new Date().toISOString(),
  source: { filename, bytes: bytes.length, sha256: sha(bytes), kind: 'explicit isolated upload copy' },
  stages: [],
  requests: [],
  errors: [],
  noMocks: true,
};
let browser, page;
const save = async () => writeFile(out + '/result.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
const stage = async (name, fn) => {
  result.currentStage = name;
  await save();
  const start = Date.now();
  const value = await fn();
  result.stages.push({ name, elapsedMs: Date.now() - start, value });
  await save();
  console.log(JSON.stringify({ stage: name, ok: true }));
  return value;
};
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1500, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.addInitScript(() => {
    localStorage.setItem('cat-cafe:shell-presentation', 'v2');
    localStorage.setItem('cat-cafe:shell-language', 'zh-CN');
  });
  const session = await (await context.request.get(api + '/api/session')).json();
  assert.ok(session.csrfToken);
  result.userId = session.userId;
  const headers = { 'x-csrf-token': session.csrfToken, Origin: web };
  const reuse = process.env.F309_REUSE_UPLOAD;
  const previous = reuse ? JSON.parse(await readFile(ev + '/' + reuse + '/result.json', 'utf8')) : null;
  const thread = previous
    ? { id: previous.threadId }
    : await stage('create-isolated-thread', async () => {
        const r = await context.request.post(api + '/api/threads', {
          headers,
          data: {
            title: 'F309 作者真实上传与统一查看验收',
            projectPath: wt,
            preferredCats: [],
            idempotencyKey: randomUUID(),
          },
        });
        assert.equal(r.status(), 201);
        const body = await r.json();
        return body.thread ?? body;
      });
  const t = thread.id;
  assert.ok(t);
  result.threadId = t;
  const published = previous
    ? JSON.parse(await readFile(ev + '/' + reuse + '/upload-response.json', 'utf8')).body.userMessage
    : await stage('real-multipart-upload', async () => {
        const r = await context.request.post(api + '/api/messages', {
          headers,
          multipart: {
            threadId: t,
            content: '本隔离工位的只读上传副本，用于作者真实界面核验。',
            idempotencyKey: randomUUID(),
            file: { name: filename, mimeType: 'text/markdown', buffer: bytes },
          },
        });
        const b = await r.json();
        await writeFile(out + '/upload-response.json', JSON.stringify({ status: r.status(), body: b }, null, 2), {
          mode: 0o600,
        });
        assert.equal(r.status(), 202);
        assert.equal(b.entries?.length, 0);
        return b.userMessage ?? b.message;
      });
  assert.ok(published?.id);
  result.messageId = published.id;
  const file = published.contentBlocks?.find((x) => x.type === 'file');
  assert.ok(file);
  assert.equal(file.fileName, filename);
  result.upload = file;
  const info = await stage('real-file-info-and-bytes', async () => {
    const r = await context.request.get(api + '/api' + file.url + '/file-info');
    assert.equal(r.status(), 200);
    const i = await r.json();
    assert.equal(i.local, true);
    assert.equal(i.canOpen, true);
    assert.ok(i.path.startsWith(wt + '/'));
    const download = await context.request.get(api + file.url);
    assert.equal(download.status(), 200);
    assert.equal(sha(await download.body()), sha(bytes));
    return i;
  });
  result.fileInfo = info;
  await stage('same-actual-file-upload-raw-and-path', async () => {
    const treeResponse = await context.request.get(api + '/api/workspace/worktrees');
    assert.equal(treeResponse.status(), 200);
    const roots = (await treeResponse.json()).worktrees;
    const root = roots.find((x) => x.root === wt || x.resolvedRoot === wt);
    assert.ok(root);
    const path = info.path.slice(wt.length + 1);
    const query = new URLSearchParams({ worktreeId: root.id, path });
    const values = [];
    for (const endpoint of ['/api/workspace/file/raw/file-info', '/api/workspace/file/actions/file-info']) {
      const r = await context.request.get(api + endpoint + '?' + query);
      assert.equal(r.status(), 200);
      const j = await r.json();
      assert.equal(j.path, info.path);
      assert.equal(j.canOpen, info.canOpen);
      assert.equal(j.canReveal, info.canReveal);
      assert.equal(j.mime, info.mime);
      values.push({ endpoint, local: j.local, samePath: true });
    }
    const raw = await context.request.get(api + '/api/workspace/file/download?' + query);
    assert.equal(raw.status(), 200);
    assert.equal(sha(await raw.body()), sha(bytes));
    return { rootId: root.id, path, values, sha256: sha(bytes) };
  });

  page = await context.newPage();
  page.on('pageerror', (e) => result.errors.push(String(e).slice(0, 500)));
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.origin === api && /(file-info|reveal|\/open$|\/artifacts$|\/workspace\/file)/.test(u.pathname))
      result.requests.push({ method: r.request().method(), path: u.pathname, status: r.status() });
  });
  await stage('actual-chat-entry', async () => {
    await page.goto(web + '/thread/' + t + '?shell=v2', { waitUntil: 'domcontentloaded', timeout: 90000 });
    const card = page.getByTestId('workspace-home-artifact-card').filter({ hasText: filename });
    await card.waitFor({ state: 'visible', timeout: 60000 });
    result.browserUrl = page.url();
    await page.screenshot({ path: out + '/chat-before.png', fullPage: true });
    return { cards: await card.count() };
  });
  const composer = page.getByRole('textbox', { name: '消息输入框' });
  let originalComposer;
  await stage('retain-original-unsent-draft', async () => {
    await composer.fill('原输入框保留：不发送、不改生产草稿。');
    originalComposer = await composer.elementHandle();
    return { value: await composer.inputValue() };
  });
  const card = page.getByTestId('workspace-home-artifact-card').filter({ hasText: filename });
  await stage('shared-card-title-and-input-affordances', () =>
    assertWorkCardChrome(page, card.locator('xpath=ancestor::article[1]')),
  );
  await stage('card-common-menu', async () => {
    const article = card.locator('xpath=ancestor::article[1]');
    await article.hover();
    await article.getByRole('button', { name: '作品更多操作', exact: true }).click();
    const menu = page.getByRole('menu', { name: '作品更多操作' });
    await menu.getByRole('menuitem', { name: '复制路径', exact: true }).waitFor();
    const labels = await menu.getByRole('menuitem').allTextContents();
    await page.screenshot({ path: out + '/card-menu.png', fullPage: true });
    await menu.getByRole('menuitem', { name: '复制路径', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), info.path);
    return labels;
  });
  await stage('card-download-original-bytes', async () => {
    const article = card.locator('xpath=ancestor::article[1]');
    await article.hover();
    await article.getByRole('button', { name: '作品更多操作', exact: true }).click();
    const dl = page.waitForEvent('download');
    await page.getByRole('menu').getByRole('menuitem', { name: '下载', exact: true }).click();
    const d = await dl;
    const path = await d.path();
    assert.equal(sha(await readFile(path)), sha(bytes));
    assert.equal(d.suggestedFilename(), filename);
    return { sha256: sha(bytes), suggestedFilename: d.suggestedFilename() };
  });
  await stage('open-shared-persistent-reader', async () => {
    await card.click();
    const viewer = page.getByTestId('workspace-file-viewer');
    await viewer.waitFor({ state: 'visible', timeout: 60000 });
    await page.getByTestId('content-file-toolbar').waitFor();
    assert.equal(await page.getByTestId('content-file-toolbar').count(), 1);
    assert.equal(await page.locator('[data-testid="f307-surface-chrome"]:visible').count(), 0);
    await page.screenshot({ path: out + '/reader.png', fullPage: true });
    return { readerCount: await viewer.count(), toolbarCount: 1 };
  });
  await stage('reader-menu-locate-and-native-actions', async () => {
    const toolbar = page.getByTestId('content-file-toolbar');
    const more = toolbar.getByRole('button', { name: '作品更多操作', exact: true });
    await more.click();
    const menu = page.getByRole('menu', { name: '作品更多操作' });
    await menu.getByRole('menuitem', { name: '复制路径', exact: true }).waitFor();
    const labels = await menu.getByRole('menuitem').allTextContents();
    await menu.getByRole('menuitem', { name: '复制路径', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), info.path);
    const answers = [];
    for (const [name, endpoint] of [
      ['在 Finder 中显示', 'reveal'],
      ['用默认应用打开', 'open'],
    ]) {
      await more.click();
      const response = page.waitForResponse((r) => r.url().includes('/' + endpoint) && r.request().method() === 'POST');
      await page
        .getByRole('menu')
        .getByRole('menuitem', { name: new RegExp(name) })
        .click();
      const r = await response;
      assert.equal(r.status(), 200);
      answers.push({ action: endpoint, status: r.status() });
    }
    await more.click();
    await page.getByRole('menu').getByRole('menuitem', { name: '复制路径', exact: true }).waitFor();
    await page.screenshot({ path: out + '/reader-menu.png', fullPage: true });
    await page.keyboard.press('Escape');
    return { labels, answers, finderWindowSelection: 'not independently observed' };
  });
  await stage('filename-context-menu-and-native-text-selection', async () => {
    const toolbar = page.getByTestId('content-file-toolbar');
    const name = toolbar.locator('span[title]').filter({ hasText: filename }).first();
    await name.click({ button: 'right' });
    assert.equal(await page.getByRole('menu').count(), 1);
    await page.keyboard.press('Escape');
    const text = page.getByTestId('workspace-file-viewer').locator('p').filter({ hasText: '讨论稿' }).first();
    assert.equal(await text.count(), 1);
    const selected = await text.evaluate((p) => {
      const range = document.createRange();
      range.selectNodeContents(p);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
      return s.toString();
    });
    await page.keyboard.press('Meta+C');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), selected);
    await text.click({ button: 'right' });
    assert.equal(await page.getByRole('menu').count(), 0);
    return { filenameMenu: true, bodyFileMenu: false, nativeSelectionCopy: true };
  });
  await stage('return-to-original-chat', async () => {
    await page.getByTestId('content-file-toolbar').getByRole('button', { name: '返回来源', exact: true }).click();
    await page.getByTestId('workspace-file-viewer').waitFor({ state: 'hidden' });
    return { readerHidden: true, retainedTab: true };
  });
  await stage('draft-and-source-preserved', async () => {
    assert.equal(await composer.inputValue(), '原输入框保留：不发送、不改生产草稿。');
    assert.equal(await originalComposer.evaluate((x) => x.isConnected), true);
    const r = await context.request.get(api + file.url);
    assert.equal(sha(await r.body()), sha(bytes));
    return { sameComposerNode: true, unchangedBytes: true };
  });
  await stage('actual-works-entry-same-source', async () => {
    await page.getByTestId('header-works').click();
    const cards = page.getByTestId('workspace-home-artifact-card').filter({ hasText: filename });
    const workCard = cards.last();
    await workCard.waitFor({ state: 'visible' });
    await workCard
      .locator('xpath=ancestor::article[1]')
      .getByRole('button', { name: '作品更多操作', exact: true })
      .click();
    const menu = page.getByRole('menu', { name: '作品更多操作' });
    await menu.getByRole('menuitem', { name: '复制路径', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), info.path);
    await workCard.click();
    await page.getByTestId('content-file-toolbar').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-testid="f307-surface-chrome"]:visible').count(), 0);
    await page.screenshot({ path: out + '/works-reader.png', fullPage: true });
    await page.getByTestId('content-file-toolbar').getByRole('button', { name: '返回来源', exact: true }).click();
    return { samePath: true, oneReader: true };
  });
  await stage('actual-home-card-same-source-and-return', async () => {
    await page.getByTestId('v2-workspace-home').click();
    const home = page.getByTestId('f307-workspace-home-page');
    await home.waitFor({ state: 'visible' });
    const homeCard = home.getByTestId('workspace-home-artifact-card').filter({ hasText: filename });
    await homeCard.waitFor({ state: 'visible' });
    await homeCard
      .locator('xpath=ancestor::article[1]')
      .getByRole('button', { name: '作品更多操作', exact: true })
      .click();
    const menu = page.getByRole('menu', { name: '作品更多操作' });
    await menu.getByRole('menuitem', { name: '复制路径', exact: true }).waitFor();
    const labels = await menu.getByRole('menuitem').allTextContents();
    await page.screenshot({ path: out + '/home-menu.png', fullPage: true });
    await menu.getByRole('menuitem', { name: '复制路径', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), info.path);
    await homeCard.click();
    await page.getByTestId('content-file-toolbar').waitFor({ state: 'visible' });
    await page.getByTestId('content-file-toolbar').getByRole('button', { name: '返回来源', exact: true }).click();
    await home.waitFor({ state: 'visible' });
    assert.equal(await composer.inputValue(), '原输入框保留：不发送、不改生产草稿。');
    return { labels, samePath: true, returnedToHome: true, draftRetained: true };
  });
  for (const sample of [
    { name: '同源图片.png', mime: 'image/png', path: wt + '/packages/web/public/avatars/codex.png', kind: 'image' },
    { name: '同源视频.mp4', mime: 'video/mp4', path: wt + '/site/assets/demos/same-bug.zh.mp4', kind: 'video' },
  ])
    await stage('actual-' + sample.kind + '-float-work-fullwindow', async () => {
      const data = await readFile(sample.path);
      const r = await context.request.post(api + '/api/messages', {
        headers,
        multipart: {
          threadId: t,
          content: '隔离作者核验：' + sample.name,
          idempotencyKey: randomUUID(),
          file: { name: sample.name, mimeType: sample.mime, buffer: data },
        },
      });
      assert.equal(r.status(), 202);
      const message = (await r.json()).userMessage;
      const block = message.contentBlocks.find((b) => b.type === 'image' || b.type === 'file');
      assert.ok(block);
      // Refresh through the real route to consume this newly persisted message.
      await page.reload({ waitUntil: 'domcontentloaded' });
      const src = block.url;
      const currentComposer = await composer.elementHandle();
      if (sample.kind === 'image')
        await page
          .locator('img[src*="' + src.split('/').pop() + '"]')
          .first()
          .click();
      else await page.getByTestId('workspace-home-artifact-card').filter({ hasText: sample.name }).first().click();
      const dialog = page.getByRole('dialog').last();
      await dialog.waitFor({ state: 'visible' });
      await page.getByTestId('lightbox-open-workspace').waitFor({ state: 'visible' });
      // Preview controls are replaced by the decoded owner. Test the settled
      // menu here; the delayed-handoff component tests cover its earlier phase.
      await dialog.getByTestId('artwork-chat-preview').waitFor({ state: 'detached' });
      assert.equal(await dialog.locator('[data-content-opening-state="blocked"]').count(), 0);
      const more = dialog.getByRole('button', { name: '作品更多操作', exact: true });
      await more.waitFor({ state: 'visible' });
      await more.click();
      const menu = page.getByRole('menu', { name: '作品更多操作' });
      await menu.getByRole('menuitem', { name: '复制路径', exact: true }).waitFor();
      const labels = await menu.getByRole('menuitem').allTextContents();
      await page.screenshot({ path: out + '/' + sample.kind + '-float.png', fullPage: true });
      await menu.getByRole('menuitem', { name: '复制路径', exact: true }).click();
      const copiedLocation = await page.evaluate(() => navigator.clipboard.readText());
      assert.ok(copiedLocation.startsWith('/'));
      const media = dialog.locator('[data-testid="workspace-content-review-media"]');
      await media.waitFor({ state: 'visible' });
      if (sample.kind === 'video') {
        await media.evaluate((v) => {
          v.pause();
          v.currentTime = Math.min(2, v.duration / 2);
        });
        await page.waitForFunction(() =>
          [...document.querySelectorAll('video')].some(
            (v) => v.closest('[role="dialog"]') && !v.seeking && v.readyState >= 2 && v.currentTime > 1,
          ),
        );
      }
      await page.keyboard.press('Meta+C');
      // Pixel copying encodes and writes asynchronously. A previous image must
      // not satisfy this check: the real Copy path action above replaced it.
      await dialog
        .getByText(sample.kind === 'video' ? '已复制当前帧' : '已复制图片', { exact: true })
        .waitFor({ state: 'visible' });
      const copied = await page.evaluate(async () => {
        const entries = await navigator.clipboard.read();
        const item = entries.find((x) => x.types.includes('image/png'));
        if (!item) return false;
        const blob = await item.getType('image/png');
        const bitmap = await createImageBitmap(blob);
        const result = { bytes: blob.size, width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return result;
      });
      result.pixelObservation = copied;
      await save();
      assert.ok(copied && copied.bytes > 0 && copied.width > 0 && copied.height > 0);
      await page.getByTestId('lightbox-open-workspace').click();
      await dialog.waitFor({ state: 'hidden' });
      const header = page.locator('[data-testid="artwork-header"]:visible');
      await header.waitFor({ state: 'visible' });
      await page.locator('[data-testid="f307-artifact-enter-full-window"]:visible').click();
      await page.locator('[data-testid="f307-artifact-exit-full-window"]:visible').waitFor({ state: 'visible' });
      if (sample.kind === 'video')
        await page.waitForFunction(() =>
          [...document.querySelectorAll('video')].some((v) => !v.seeking && v.readyState >= 2 && v.currentTime > 1),
        );
      await page.screenshot({ path: out + '/' + sample.kind + '-work.png', fullPage: true });
      await page.locator('[data-testid="f307-artifact-exit-full-window"]:visible').click();
      await page.locator('[data-testid="artwork-work-mode-return"]:visible').click();
      assert.equal(await composer.inputValue(), '原输入框保留：不发送、不改生产草稿。');
      assert.equal(await currentComposer.evaluate((x) => x.isConnected), true);
      return {
        sameComposerNode: true,
        copiedPixels: copied,
        copiedLocation,
        name: sample.name,
        storedUrl: src,
        labels,
        floatWorkFullWindow: true,
        draftRetained: true,
      };
    });
  // Keep the document in Home's three recent cards until its entry is exercised.
  await stage('real-stored-pages-are-inert-and-scripts-stay-locatable', async () => {
    const observations = [];
    const rootId = result.stages.find((x) => x.name === 'same-actual-file-upload-raw-and-path').value.rootId;
    for (const sample of [
      { name: 'isolated-page.html', mime: 'text/html', body: '<script>window.__f309UntrustedScript=true</script>' },
      {
        name: 'isolated-shape.svg',
        mime: 'text/plain',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="green"/><script>window.__f309UntrustedScript=true</script></svg>',
      },
      { name: 'isolated-script.py', mime: 'text/plain', body: '# test bytes only; never launch\n' },
    ]) {
      const upload = await context.request.post(api + '/api/messages', {
        headers,
        multipart: {
          threadId: t,
          content: '本隔离工位的响应/启动围栏样本。',
          idempotencyKey: randomUUID(),
          file: { name: sample.name, mimeType: sample.mime, buffer: Buffer.from(sample.body) },
        },
      });
      assert.equal(upload.status(), 202);
      const body = await upload.json();
      const source = body.userMessage.contentBlocks.find((x) => x.type === 'file');
      assert.ok(source?.url);
      const response = await context.request.get(api + source.url);
      assert.equal(response.status(), 200);
      assert.equal(await response.text(), sample.body);
      assert.equal(response.headers()['x-content-type-options'], 'nosniff');
      assert.match(response.headers()['content-security-policy'], /sandbox/);
      const facts = await (await context.request.get(api + '/api' + source.url + '/file-info')).json();
      assert.equal(facts.local, true);
      assert.equal(facts.canReveal, true);
      if (sample.name.endsWith('.py')) {
        assert.equal(facts.canOpen, false);
        const denied = await context.request.post(api + '/api' + source.url + '/open', { headers, data: {} });
        assert.equal(denied.status(), 403);
        observations.push({ name: sample.name, local: true, canReveal: true, canOpen: false, openStatus: 403 });
        continue;
      }
      const probe = await context.newPage();
      try {
        if (sample.name.endsWith('.html')) {
          assert.match(response.headers()['content-disposition'], /^attachment;/);
          const download = probe.waitForEvent('download');
          const navigation = probe.goto(api + source.url).catch((error) => {
            assert.match(String(error), /download|ERR_ABORTED/i);
          });
          const file = await download;
          await navigation;
          assert.ok(file.suggestedFilename().endsWith('.html'));
        } else {
          for (const url of [
            api + source.url,
            api +
              '/api/workspace/file/raw?' +
              new URLSearchParams({
                worktreeId: rootId,
                path: facts.path.slice(wt.length + 1),
              }),
          ]) {
            const opened = await probe.goto(url);
            assert.match(opened.headers()['content-security-policy'], /sandbox/);
            assert.equal(await probe.locator('svg').count(), 1);
            assert.equal(await probe.evaluate(() => window.__f309UntrustedScript === true), false);
          }
          await probe.screenshot({ path: out + '/inert-svg.png' });
        }
        observations.push({
          name: sample.name,
          status: 200,
          sandboxed: true,
          scriptRan: false,
          attachment: !!response.headers()['content-disposition'],
        });
      } finally {
        await probe.close();
      }
    }
    return observations;
  });

  await stage('workspace-byte-text-and-ordinary-file-defaults', async () => {
    const observations = [];
    const rootId = result.stages.find((x) => x.name === 'same-actual-file-upload-raw-and-path').value.rootId;
    for (const sample of [
      { name: 'example.conf', mime: 'text/plain', body: 'a=1', expectedMime: 'application/octet-stream' },
      { name: 'table.csv', mime: 'text/csv', body: 'field,value\nalpha,1', expectedMime: 'text/csv' },
    ]) {
      const upload = await context.request.post(api + '/api/messages', {
        headers,
        multipart: {
          threadId: t,
          content: '本隔离工位的普通文本阅读/展示回归样本。',
          idempotencyKey: randomUUID(),
          file: { name: sample.name, mimeType: sample.mime, buffer: Buffer.from(sample.body) },
        },
      });
      assert.equal(upload.status(), 202);
      const source = (await upload.json()).userMessage.contentBlocks.find((x) => x.type === 'file');
      const facts = await (await context.request.get(api + '/api' + source.url + '/file-info')).json();
      const path = facts.path.slice(wt.length + 1);
      const query = new URLSearchParams({ worktreeId: rootId, path });
      const read = await context.request.get(api + '/api/workspace/file?' + query);
      assert.equal(read.status(), 200);
      const metadata = await read.json();
      assert.equal(metadata.binary, false);
      assert.equal(metadata.mime, sample.expectedMime);
      assert.equal(metadata.content, sample.body);
      const navigation = await context.request.post(api + '/api/workspace/navigate', {
        headers,
        data: { worktreeId: rootId, path, action: 'open', threadId: t },
      });
      assert.equal(navigation.status(), 200);
      const receipt = await navigation.json();
      assert.equal(receipt.deliveryStatus, 'applied');
      const owner = page.locator('[data-owner-path="' + path + '"]:visible');
      const reader = owner.getByTestId('workspace-file-viewer');
      await reader.waitFor({ state: 'visible' });
      await reader
        .locator('.cm-content')
        .filter({ hasText: sample.body.split('\n')[0] })
        .waitFor();
      assert.equal(await reader.getByText('二进制文件', { exact: true }).count(), 0);
      assert.equal(await page.locator('[data-testid="f307-artifact-enter-full-window"]:visible').count(), 0);
      assert.equal(await composer.inputValue(), '原输入框保留：不发送、不改生产草稿。');
      await page.screenshot({ path: out + '/' + sample.name + '.png', fullPage: true });
      observations.push({ name: sample.name, path, binary: metadata.binary, mime: metadata.mime, ordinaryFile: true });
    }
    return observations;
  });
  result.status = 'passed';
} catch (e) {
  result.status = 'failed';
  result.failure = String(e?.stack ?? e);
  if (page) {
    await page.screenshot({ path: out + '/failure.png', fullPage: true }).catch(() => {});
    await writeFile(
      out + '/failure-dom.txt',
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
      { mode: 0o600 },
    );
  }
  process.exitCode = 1;
  console.log(JSON.stringify({ status: 'failed', stage: result.currentStage, error: String(e).slice(0, 300) }));
} finally {
  result.completedAt = new Date().toISOString();
  await save();
  await browser?.close();
}
