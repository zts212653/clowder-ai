import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { captureChatPathDesign } from './chat-path-design.journey.mjs';
import { verifyPathLifecycle } from './chat-path-lifecycle.journey.mjs';
import { createChatPathFixture } from './chat-path-links.fixture.mjs';
import {
  verifyMultilineFileGroup,
  verifyReferenceBoundaries,
  verifySplitFileGroup,
} from './chat-reference-boundaries.journey.mjs';
import { registerDesign1526Journeys } from './chat-reference-design1526.journey.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url)),
  tree = path.resolve(web, '../..');
const root = process.env.F322_CHAT_PATH_EVIDENCE ?? (await mkdtemp(path.join(tmpdir(), 'f322-chat-links-')));
registerDesign1526Journeys(root);
async function readFixtureReferenceParagraphs(page, message, sha, reading) {
  // Metadata follows the real reading viewport; visit each controlled sample paragraph before counting cards.
  const paragraphs = message.locator('.markdown-content > p');
  await paragraphs.first().waitFor();
  assert.equal(await paragraphs.count(), 8);
  const container = page.locator('[data-chat-container]');
  const history = await container.boundingBox();
  assert.ok(history);
  const gesture = await container.evaluateHandle((element) => {
    const input = { startTop: element.scrollTop, trusted: false, deltaY: 0 };
    element.addEventListener(
      'wheel',
      (event) => Object.assign(input, { trusted: event.isTrusted, deltaY: event.deltaY }),
      { once: true, passive: true },
    );
    return input;
  });
  // One real reading gesture retires the cold restore. The remaining journey tests reference semantics.
  await page.mouse.move(history.x + 8, history.y + 24);
  await page.mouse.wheel(0, -10000);
  await page.waitForFunction(
    ([element, input]) => input.trusted && (element.scrollTop < input.startTop - 0.5 || element.scrollTop <= 0.5),
    [await container.elementHandle(), gesture],
  );
  const stable = await container.evaluate(async (element) => {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const top = element.scrollTop;
      const height = element.scrollHeight;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (Math.abs(element.scrollTop - top) < 1 && element.scrollHeight === height) return true;
    }
    return false;
  });
  assert.ok(stable, 'Native reading geometry settles before controlled paragraph positioning');
  reading.push({ phase: 'native-reading-settled', ...(await gesture.jsonValue()) });
  await gesture.dispose();
  for (const [index, paragraph] of (await paragraphs.all()).entries()) {
    const box = await paragraph.boundingBox();
    reading.push({ index, phase: 'before', paragraph: box });
    await paragraph.scrollIntoViewIfNeeded();
    await page.waitForFunction(
      (element) => {
        const port = element.closest('[data-chat-container]').getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        return rect.bottom > port.top + 16 && rect.top < port.bottom - 16;
      },
      await paragraph.elementHandle(),
    );
    reading.push({
      index,
      phase: 'entered',
      paragraph: await paragraph.boundingBox(),
      scrollTop: await container.evaluate((element) => element.scrollTop),
    });
    if (index === 0) {
      // The shared image may already be cached. Wait for this paragraph's own read before leaving it.
      await paragraph.locator('[data-chat-reference-kind=file]').filter({ hasText: 'delivery.md:5' }).waitFor();
      await paragraph.locator('[data-chat-reference-kind=missing]').waitFor();
      await paragraph.locator('[data-chat-reference-state=merged]').waitFor();
    }
    const kind = (await paragraph.innerText()).includes(sha.slice(0, 10)) ? 'commit' : 'file';
    await paragraph.locator(`[data-chat-reference-kind=${kind}]`).first().waitFor();
  }
}
async function verifyCommitFromHome(page, message, evidence) {
  const entry = message.locator('[data-chat-reference-kind=commit] button');
  await entry.click();
  const owner = page.locator('[data-testid="f307-owner-surface-host"]:visible');
  await owner.getByText('docs/delivery.md', { exact: true }).waitFor();
  await page.getByTestId('v2-workspace-home').click();
  await owner.waitFor({ state: 'hidden' });
  await entry.click();
  await owner.getByText('docs/delivery.md', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('f307-tab-strip').getByRole('tab').count(), 2, 'Home and one reused commit tab');
  await page.screenshot({ path: path.join(evidence, 'commit-from-home.png'), fullPage: true, animations: 'disabled' });
}
for (const language of ['zh', 'en'])
  test(`F322 actual chat paths and GitHub ${language} 390`, { timeout: 240000 }, async (t) => {
    const evidence = path.join(root, language + '-390');
    await mkdir(evidence, { recursive: true });
    const fixture = await createChatPathFixture(language),
      source = fixture.runtime;
    let environment, server, browser, page;
    const errors = [],
      batches = [],
      referenceResponses = [],
      reading = [],
      reads = [],
      desktop = [];
    t.after(async () => {
      try {
        if (page && !page.isClosed()) {
          await page.screenshot({ path: path.join(evidence, 'final.png'), fullPage: true, animations: 'disabled' });
          await writeFile(
            path.join(evidence, 'proof.json'),
            JSON.stringify(
              {
                head: process.env.F322_INBOX_PARITY_HEAD,
                source: { thread: source.thread.id, message: source.message.id, sha: source.sha },
                text: await page.locator('body').innerText(),
                errors,
                batches,
                referenceResponses,
                reading,
                reads,
                desktop,
                fileSourceRequests: source.fileSourceRequests,
                references: await page.locator('[data-message-id] [data-chat-reference-kind]').evaluateAll((elements) =>
                  elements.map((element) => ({
                    kind: element.getAttribute('data-chat-reference-kind'),
                    title: element.getAttribute('title'),
                    name:
                      element.getAttribute('aria-label') ??
                      element.querySelector('button,a')?.getAttribute('aria-label'),
                    text: element.textContent,
                  })),
                ),
              },
              null,
              2,
            ),
          );
        }
      } finally {
        const cleanup = [];
        for (const close of [
          () => browser?.close(),
          () => server && stopChild(server),
          () => fixture.close(),
          () => environment?.cleanup(),
        ]) {
          try {
            await close();
            cleanup.push({ status: 'fulfilled' });
          } catch (error) {
            cleanup.push({ status: 'rejected', reason: String(error) });
          }
        }
        await writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify(cleanup, null, 2));
        assert.ok(
          cleanup.every((result) => result.status === 'fulfilled'),
          'All owned browser resources were cleaned up',
        );
      }
    });
    const port = await availablePort();
    environment = await createNextDevTestEnvironment('chat-path-links-' + language, {
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${fixture.apiPort}`,
      API_SERVER_PORT: String(fixture.apiPort),
      FRONTEND_PORT: String(port),
    });
    server = spawn(
      process.execPath,
      [
        path.join(web, 'scripts/sync-vendor-assets.mjs'),
        '--watch',
        '--',
        path.join(tree, 'node_modules/next/dist/bin/next'),
        'dev',
        '-H',
        '127.0.0.1',
        '-p',
        String(port),
      ],
      { cwd: web, env: environment.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    for (const stream of [server.stdout, server.stderr])
      stream.on('data', (data) => void writeFile(path.join(evidence, 'web.log'), data, { flag: 'a' }));
    const base = `http://127.0.0.1:${port}`;
    await waitForHttp(`${base}/thread/${source.thread.id}`, server);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 1100 } });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/workspace/chat-references') batches.push(request.postDataJSON());
      if (url.pathname.startsWith('/api/workspace/')) reads.push(url.pathname + url.search);
    });
    page.on('response', (response) => {
      if (new URL(response.url()).pathname !== '/api/workspace/chat-references') return;
      void response.json().then(
        (body) => referenceResponses.push({ status: response.status(), body }),
        (error) => referenceResponses.push({ status: response.status(), readError: String(error) }),
      );
    });
    // A browser journey verifies the explicit action request; the OS boundary is tested separately without launching applications.
    await page.route('**/api/workspace/file/actions/**', async (route) => {
      desktop.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() });
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.addInitScript((language) => {
      localStorage.setItem('cat-cafe:shell-presentation', 'v2');
      localStorage.setItem('cat-cafe:shell-language', language);
      localStorage.setItem('theme', 'light');
    }, language);
    await page.goto(`${base}/thread/${source.thread.id}?shell=v2`);
    const message = page.locator(`[data-message-id="${source.message.id}"]`).first();
    await readFixtureReferenceParagraphs(page, message, source.sha, reading);
    await message.locator('[data-chat-reference-kind=file]').first().waitFor();
    const pr = message.locator('[data-chat-reference-kind=github]');
    await pr.filter({ hasText: '#5963' }).waitFor();
    await page.waitForFunction(
      (id) =>
        document.querySelector(`[data-message-id="${id}"]`)?.innerText.includes('Merged') ||
        document.querySelector(`[data-message-id="${id}"]`)?.innerText.includes('已合入'),
      source.message.id,
    );
    assert.equal(await message.locator('pre [data-chat-reference-kind]').count(), 0);
    assert.equal(await message.locator('[data-chat-reference-kind=missing]').innerText(), 'not-here.md');
    assert.equal(await message.locator('[data-chat-reference-kind=website]').innerText(), 'example.com');
    const initialReferences = batches.flatMap((batch) => batch.groups.flatMap((group) => group.references));
    for (const reference of ['docs/delivery.md:5', 'docs/slides.pptx', 'docs/report.docx', source.sha.slice(0, 10)])
      assert.equal(initialReferences.filter((value) => value === reference).length, 1, `Reading reuses ${reference}`);
    assert.ok(batches.every((batch) => batch.groups.reduce((size, group) => size + group.references.length, 0) <= 64));
    const inline = message.locator('[data-chat-reference-kind=file][data-chat-reference-layout=inline]').first();
    assert.equal(await inline.textContent(), 'delivery.md:5');
    assert.equal(await message.locator('[data-chat-reference-layout=card]').count(), 7);
    const contrast = await message
      .locator('[data-chat-reference-kind=file][data-chat-reference-layout=card]')
      .first()
      .evaluate((card) => {
        const pixel = document.createElement('canvas');
        pixel.width = pixel.height = 1;
        const context = pixel.getContext('2d');
        const luminance = (color) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data]
            .slice(0, 3)
            .map((value) => {
              const s = value / 255;
              return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            })
            .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
        };
        const background = luminance(getComputedStyle(card).backgroundColor),
          foreground = luminance(getComputedStyle(card.querySelector('button')).color);
        return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
      });
    assert.ok(
      contrast >= 4.5,
      `File text remains readable on the actual light/dark card background: ${contrast.toFixed(2)}`,
    );
    const directory = message.locator(`[data-chat-reference-kind=file][title="${source.root}/docs"]`);
    assert.equal(await directory.count(), 1, 'The registered directory is a verified card too');
    const plugin = page.locator(`[data-message-id="${source.plugin.id}"]`).first();
    await plugin.scrollIntoViewIfNeeded();
    await plugin.locator('[data-chat-reference-kind=file]').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await inline.scrollIntoViewIfNeeded();
    const history = await page.locator('[data-chat-container]').boundingBox();
    const inlineBox = await inline.boundingBox();
    assert.ok(history && inlineBox);
    // Frame the start of a long message through the history owner's actual reading input.
    await page.mouse.move(history.x + 8, history.y + 24);
    await page.mouse.wheel(0, Math.round(inlineBox.y - history.y - 64) || -1);
    await page.waitForFunction(
      (element) => {
        const port = element.closest('[data-chat-container]').getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return box.top >= port.top && box.top < port.top + 100;
      },
      await inline.elementHandle(),
    );
    await page.screenshot({ path: path.join(evidence, 'mixed-chat.png'), fullPage: true, animations: 'disabled' });
    await inline.hover();
    const menu = page.getByRole('group', { name: language === 'en' ? 'File actions' : '文件操作', exact: true });
    await menu.waitFor();
    assert.ok((await menu.locator('code').innerText()).endsWith('/docs/delivery.md'));
    const menuBox = await menu.boundingBox();
    await writeFile(
      path.join(evidence, 'path-menu-geometry.json'),
      JSON.stringify(
        {
          box: menuBox,
          viewport: 390,
          contrast,
          bodyPortal: await menu.evaluate((element) => !element.closest('[data-message-viewport-boundary]')),
        },
        null,
        2,
      ),
    );
    assert.ok(
      menuBox.x >= 0 && menuBox.x + menuBox.width <= 390,
      `File menu fits the viewport: ${JSON.stringify(menuBox)}`,
    );
    await page.screenshot({ path: path.join(evidence, 'path-menu.png'), fullPage: true, animations: 'disabled' });
    const revealResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/workspace/file/actions/reveal' &&
        response.request().method() === 'POST' &&
        response.status() === 200,
    );
    await menu
      .getByRole('button', { name: language === 'en' ? 'Show in Finder' : '在 Finder 中显示', exact: true })
      .click();
    await revealResponse;
    assert.equal(desktop.length, 1);
    assert.equal(desktop[0].method, 'POST');
    assert.deepEqual(JSON.parse(desktop[0].body ?? '{}'), {}, 'No path or authority is accepted from the action body');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await verifyCommitFromHome(page, message, evidence);
    await inline.locator('button').first().click();
    const viewer = page.locator('[data-testid="workspace-file-viewer"]:visible');
    await viewer.waitFor();
    await viewer.getByText('Verified local file.', { exact: false }).waitFor();
    await verifySplitFileGroup({ page, message, evidence });
    await page.screenshot({
      path: path.join(evidence, 'existing-workspace.png'),
      fullPage: true,
      animations: 'disabled',
    });
    const more = viewer.locator(`summary[title="${language === 'en' ? 'More file actions' : '更多文件操作'}"]`);
    await more.click();
    const fileMenu = page.locator(`[id="${await more.getAttribute('aria-controls')}"]`);
    const openNative = fileMenu.getByRole('button', {
      name: language === 'en' ? 'Open with default application' : '用默认应用打开',
      exact: true,
    });
    await openNative.waitFor();
    if (language === 'en') assert.doesNotMatch(await fileMenu.innerText(), /[\u3400-\u9fff]/);
    assert.equal(desktop.length, 1, 'Opening a file never opens a native application implicitly');
    await page.screenshot({
      path: path.join(evidence, 'workspace-file-menu.png'),
      fullPage: true,
      animations: 'disabled',
    });
    const openResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/workspace/file/actions/open' &&
        response.request().method() === 'POST' &&
        response.status() === 200,
    );
    await openNative.click();
    await openResponse;
    assert.equal(desktop.length, 2);
    assert.ok(desktop[1].url.includes('/file/actions/open?'));
    await page.keyboard.press('Escape');
    await inline.locator('button').first().click();
    await viewer.waitFor();
    assert.equal(await page.locator('[data-testid="workspace-file-viewer"]:visible').count(), 1);
    const fileTabs = page.getByTestId('f307-tab-strip').getByRole('tab').filter({ hasText: 'delivery.md' });
    await fileTabs.waitFor();
    assert.equal(await fileTabs.count(), 1, 'The canonical file has one persistent tab after reopening');
    await directory.locator('button').first().click();
    await page.locator('button[title="docs"][aria-current="true"]').first().waitFor();
    await page.locator('button[title="docs/slides.pptx"]').first().waitFor();
    await page.screenshot({ path: path.join(evidence, 'directory-tree.png'), fullPage: true, animations: 'disabled' });
    for (const [filename, count] of [
      ['slides.pptx', 6],
      ['report.docx', 12],
      ['data.xlsx', 2],
    ]) {
      await message
        .locator('[data-chat-reference-kind=file]')
        .filter({ hasText: filename })
        .locator('button')
        .first()
        .click();
      const office = page.locator('[data-testid="workspace-office-file"]:visible');
      await office.waitFor();
      await office.getByRole('heading', { name: filename, exact: true }).waitFor();
      assert.match(await office.innerText(), new RegExp(String(count)));
      assert.match(await office.innerText(), language === 'en' ? /Open with default application/ : /用默认应用打开/);
      await page.screenshot({
        path: path.join(evidence, filename + '-workspace.png'),
        fullPage: true,
        animations: 'disabled',
      });
    }
    assert.ok(
      !reads.some((url) => url.startsWith('/api/workspace/content-editor')),
      'A chat Office link is metadata-only and never imports an editor',
    );
    await message
      .locator('[data-chat-reference-kind=file][data-chat-reference-layout=inline]')
      .filter({ has: page.locator('img') })
      .locator('button')
      .first()
      .click();
    const imageDialog = page.getByRole('dialog');
    await imageDialog.waitFor();
    await imageDialog.locator('img').first().waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[role="dialog"] img')].some((image) => image.complete && image.naturalWidth > 0),
    );
    await page.screenshot({ path: path.join(evidence, 'image-float.png'), fullPage: true, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await imageDialog.waitFor({ state: 'hidden' });
    const commitReads = () => reads.filter((url) => url.startsWith('/api/workspace/chat-commit-changes?')).length;
    assert.equal(commitReads(), 1, 'First commit entry loaded its real diff');
    await message.locator('[data-chat-reference-kind=commit] button').click();
    await page
      .locator('[data-testid="f307-owner-surface-host"]:visible')
      .getByText('docs/delivery.md', { exact: true })
      .waitFor();
    assert.equal(commitReads(), 1, 'Reentry reuses the loaded canonical commit surface');
    await page.screenshot({ path: path.join(evidence, 'commit-changes.png'), fullPage: true, animations: 'disabled' });
    await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/workspace/chat-pull-request-changes' && response.status() === 200,
      ),
      pr.locator('button').click(),
    ]);
    await page
      .locator('[data-testid="f307-owner-surface-host"]:visible')
      .getByText('zts212653/clowder-ai#5963', { exact: true })
      .waitFor();
    await page.screenshot({ path: path.join(evidence, 'github-changes.png'), fullPage: true, animations: 'disabled' });
    await rm(path.join(source.root, 'docs/later-deleted.md'));
    // The shared visible-entry refresh must revalidate filesystem truth after a file is removed.
    await message.locator('p').filter({ hasText: 'later-deleted.md' }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(31000);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await message.locator('[data-chat-reference-kind=missing]').filter({ hasText: 'later-deleted.md' }).waitFor();
    await verifyReferenceBoundaries({ page, source, evidence, language, desktop });
    await verifyMultilineFileGroup({ page, source, evidence });
    await t.test('F322 actual chat paths: parent and alias lifecycle', async (stage) => {
      stage.after(async () => {
        await page.screenshot({
          path: path.join(evidence, 'parent-lifecycle-terminal.png'),
          fullPage: true,
          animations: 'disabled',
        });
        await writeFile(
          path.join(evidence, 'parent-lifecycle-terminal.json'),
          JSON.stringify(
            {
              text: await page.locator('body').innerText(),
              fileSourceRequests: source.fileSourceRequests,
              errors,
            },
            null,
            2,
          ),
        );
      });
      await verifyPathLifecycle({ page, base, source, evidence });
    });
    await t.test('F322 actual chat paths: accepted typography and standalone image', async () => {
      await captureChatPathDesign({ page, base, fixture, language, evidence });
    });
    assert.deepEqual(errors, []);
  });
