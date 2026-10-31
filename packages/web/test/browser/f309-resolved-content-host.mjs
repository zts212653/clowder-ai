import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { digest, seedResolvedContent } from './f309-resolved-content-seed.mjs';

const root = path.resolve(process.cwd());
const evidence = path.resolve(process.env.F309_RESOLVED_EVIDENCE ?? '.cat-cafe/evidence/resolved-content');
const web = process.env.F309_WEB_URL ?? 'http://localhost:5152';
const api = process.env.F309_API_URL ?? 'http://localhost:3152';
const redisPort = Number(process.env.F309_REDIS_PORT ?? 6348);
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
await mkdir(evidence, { recursive: true, mode: 0o700 });
const output = path.join(evidence, process.env.F309_RESOLVED_RUN ?? 'native-r1');
await mkdir(output, { recursive: false, mode: 0o700 });
const result = {
  kind: 'unmocked feature-worktree entry verification',
  revision,
  root,
  web,
  api,
  redisPort,
  rows: [],
  routeMocks: 0,
  originalEndpointRequests: [],
  modelInvocations: 0,
  startedAt: new Date().toISOString(),
};
const save = () => writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
const require = createRequire(path.join(root, 'packages/web/package.json'));
const { chromium } = require('playwright');
let browser;
try {
  const seed = await seedResolvedContent({
    root,
    evidence,
    web,
    api,
    redisPort,
    markdownOnly: process.argv.includes('--markdown-only'),
  });
  browser = await chromium.launch({ headless: true });
  const rows = seed.samples.flatMap((sample) => {
    const entries =
      sample.id === 'md'
        ? ['chat-file', 'chat-raw', 'human', 'works', 'home']
        : sample.id === 'docx'
          ? ['chat-file', 'chat-raw', 'human']
          : sample.id === 'binary'
            ? ['chat-file', 'chat-raw']
            : ['chat-file', 'human'];
    return entries.map((entry) => ({
      sample,
      entry,
      appearance: ['png', 'mp4'].includes(sample.id) ? 'classic' : 'v2',
    }));
  });
  for (const { sample, entry, appearance } of rows) {
    const id = `${sample.id}-${entry}-${appearance}`;
    const report = {
      id,
      status: 'running',
      errors: [],
      calls: [],
      source: { path: sample.path, sha256: sample.sha256, size: sample.size },
    };
    result.rows.push(report);
    await save();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      permissions: ['clipboard-read', 'clipboard-write'],
      acceptDownloads: true,
    });
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (['localhost', '127.0.0.1'].includes(url.hostname) && ['3001', '3002'].includes(url.port)) {
        result.originalEndpointRequests.push({ method: route.request().method(), path: url.pathname });
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.addInitScript((style) => {
      localStorage.setItem('cat-cafe:shell-presentation', style);
      localStorage.setItem('cat-cafe:shell-language', 'zh-CN');
    }, appearance);
    page.on('pageerror', (error) => report.errors.push(error.message));
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin === api && /\/api\/(workspace\/file|uploads\/.*\/file-info)/.test(url.pathname))
        report.calls.push({
          path: url.pathname,
          query: url.search,
          method: response.request().method(),
          status: response.status(),
        });
    });
    try {
      assert.equal((await context.request.get(`${api}/api/session`)).status(), 200);
      if (sample.id === 'md')
        assert.equal((await context.request.get(api + sample.rawUrl)).status(), 400, 'raw remains a media-only API');
      await page.goto(`${web}/thread/${sample.threadId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      report.servedRevision = await page.locator('html').getAttribute('data-cat-cafe-build-revision');
      assert.equal(report.servedRevision, revision);
      const composer = page.getByRole('textbox', { name: '消息输入框', exact: true });
      await composer.waitFor({ timeout: 60000 });
      const draft = `原输入框草稿 ${id}，不发送。`;
      await composer.fill(draft);
      const original = await composer.elementHandle();
      const message = (messageId) => page.locator(`[data-message-id="${messageId}"]`);
      const select = async (card) => {
        await card.waitFor();
        if (sample.id === 'md') {
          await card.scrollIntoViewIfNeeded();
          const lines = (await readFile(sample.absolute, 'utf8')).trim().split('\n');
          const heading = lines[0].replace(/^#+\s*/, '');
          await card.locator('.work-cover-paper-text strong').filter({ hasText: heading }).waitFor();
          report.previewHeading = await card.locator('.work-cover-paper-text strong').innerText();
          assert.equal(report.previewHeading, heading);
          assert.equal(await card.locator('.work-cover-bar').count(), 0);
        }
        await card.click();
      };
      if (entry === 'chat-file' || entry === 'chat-raw') {
        await select(
          message(entry === 'chat-file' ? sample.agentMessageId : sample.rawMessageId).getByTestId('file-block-cover'),
        );
      } else if (entry === 'human') {
        if (sample.humanBlockType === 'image') await message(sample.humanMessageId).locator('img').first().click();
        else
          await select(
            message(sample.humanMessageId)
              .getByTestId('workspace-home-artifact-card')
              .filter({ hasText: sample.name })
              .first(),
          );
      } else {
        if (entry === 'works') {
          await page.getByTestId('header-works').click();
          await page.getByTestId('v2-works-panel').waitFor();
        } else {
          await ensureWorkspaceOpen(page);
          await page.getByTestId('v2-workspace-home').click();
          await page.getByTestId('f307-workspace-home-page').waitFor();
        }
        const scope =
          entry === 'works' ? page.getByTestId('v2-works-panel') : page.getByTestId('f307-workspace-home-page');
        const card = scope.locator(`[data-home-artifact-id*="${sample.rawMessageId}"]`);
        await card.waitFor();
        assert.equal(await card.count(), 1, 'select the exact raw publication, never the same-name upload');
        report.selectedRawMessageId = sample.rawMessageId;
        await select(card);
      }
      const media = ['png', 'mp4'].includes(sample.id);
      const surface = media
        ? page.getByRole('dialog').last()
        : page.locator('[data-testid="workspace-file-viewer"]:visible');
      await surface.waitFor({ timeout: 30000 });
      if (!media) assert.equal(await surface.count(), 1);
      if (sample.id === 'md') {
        const paragraph = (await readFile(sample.absolute, 'utf8'))
          .trim()
          .split('\n')
          .find((line) => line && !line.startsWith('#'));
        assert.ok(paragraph);
        await surface.getByText(paragraph, { exact: true }).waitFor();
        assert.ok(
          !report.calls.some(
            (call) =>
              call.path === '/api/workspace/file/raw' && new URLSearchParams(call.query).get('path') === sample.path,
          ),
          'the preview and reader must use the authorized text endpoint',
        );
      }
      if (['docx', 'binary'].includes(sample.id)) {
        const size = `${(sample.size / 1024).toFixed(1)} KB`;
        await surface.getByText(new RegExp(` · ${size.replace('.', '\\.')}\\b`)).waitFor();
        report.bodySize = size;
        assert.ok(!(await surface.innerText()).includes('0.0 KB'));
      }
      const more = surface.getByRole('button', { name: '作品更多操作', exact: true });
      assert.equal(await more.count(), 1);
      const menu = page.getByRole('menu', { name: '作品更多操作', exact: true });
      await more.click();
      await menu.getByRole('menuitem', { name: '复制路径', exact: true }).waitFor();
      report.menuItems = await menu.getByRole('menuitem').allTextContents();
      assert.ok(report.menuItems.some((text) => text.includes('Finder')));
      await page.screenshot({ path: path.join(output, `${id}-menu.png`) });
      await menu.getByRole('menuitem', { name: '复制路径', exact: true }).click();
      report.clipboardPath = await page.evaluate(() => navigator.clipboard.readText());
      assert.equal(report.clipboardPath, sample.absolute);
      assert.equal(digest(await readFile(report.clipboardPath)), sample.sha256);
      await more.click();
      const downloading = page.waitForEvent('download');
      await menu.getByRole('menuitem', { name: '下载', exact: true }).click();
      const download = await downloading;
      report.download = { name: download.suggestedFilename(), sha256: digest(await readFile(await download.path())) };
      assert.equal(report.download.sha256, sample.sha256);
      if (media) {
        const element = surface.locator(sample.id === 'png' ? 'img' : 'video').first();
        await element.click({ button: 'right' });
        await menu.getByRole('menuitem', { name: '复制路径', exact: true }).waitFor();
        report.contextItems = await menu.getByRole('menuitem').allTextContents();
        assert.deepEqual(report.contextItems, report.menuItems);
        await page.keyboard.press('Escape');
        assert.equal(await menu.count(), 0);
        assert.equal(await surface.count(), 1, 'first Escape dismisses only the menu');
        await page.keyboard.press('Escape');
        await surface.waitFor({ state: 'detached' });
        report.closedToOriginalEntry = true;
      }
      assert.equal(await composer.inputValue(), draft);
      assert.equal(
        await original.evaluate(
          (node) => node.isConnected && node === document.querySelector('[aria-label="消息输入框"]'),
        ),
        true,
      );
      report.sameComposerAndDraft = true;
      assert.deepEqual(report.errors, []);
      report.status = 'passed';
    } catch (error) {
      report.status = 'failed';
      report.failure = String(error.stack ?? error);
      report.body = await page
        .locator('body')
        .innerText()
        .catch(() => 'unavailable');
      await page.screenshot({ path: path.join(output, `${id}-failed.png`) }).catch(() => {});
      throw error;
    } finally {
      await context.close();
      await save();
      console.log(JSON.stringify({ id, status: report.status }));
    }
  }
  assert.deepEqual(result.originalEndpointRequests, []);
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  result.finishedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({ status: result.status, rows: result.rows.length, evidence: path.join(output, 'result.json') }),
  );
}
