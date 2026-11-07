import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Real composer and IndexedDB with isolated HTTP responses; never uses a user profile or provider.
// Requires workspace dependencies, a built @cat-cafe/shared package, and Playwright Chromium.
// Run: node --test packages/web/test/browser/new-conversation-draft-recovery.test.mjs
test('unsent image drafts remain recoverable when file reading never finishes', { timeout: 120_000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const web = path.join(root, 'packages/web');
  const artifacts = path.join(root, 'artifacts/issue1893');
  await fs.mkdir(artifacts, { recursive: true });
  const requireWeb = createRequire(path.join(web, 'package.json'));
  const requireVitest = createRequire(requireWeb.resolve('vitest/package.json'));
  const { build } = await import(pathToFileURL(requireVitest.resolve('vite')).href);
  const { chromium } = requireWeb('playwright');
  const boundary = path.join(root, 'packages/web/test/browser/fixtures/new-conversation-draft-recovery.boundaries.tsx');
  process.chdir(web);
  const built = await build({
    configFile: false,
    root: web,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    plugins: [
      {
        name: 'isolated-new-conversation-storage-boundary',
        resolveId(source, importer) {
          if (source === 'idb' && importer?.replaceAll('\\', '/').endsWith('/new-conversation-intent-store.ts'))
            return boundary;
        },
      },
    ],
    resolve: {
      alias: [
        { find: 'next/image', replacement: boundary },
        { find: 'next/navigation', replacement: boundary },
        { find: '@/hooks/useSendMessage', replacement: boundary },
        { find: /^\.\/(RecentWorks|SessionImportPanel)$/, replacement: boundary },
        { find: '../onboarding-demo/DemoEntryActions', replacement: boundary },
        { find: '@', replacement: path.join(web, 'src') },
      ],
    },
    define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify('https://draft-navigation.test') },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(root, 'packages/web/test/browser/fixtures/new-conversation-draft-recovery.entry.tsx'),
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  });
  process.chdir(root);
  const outputs = Array.isArray(built) ? built.flatMap((x) => x.output) : built.output;
  const script = outputs.find((x) => x.type === 'chunk' && x.isEntry).code;
  const css = outputs
    .filter((x) => x.type === 'asset' && x.fileName.endsWith('.css'))
    .map((x) => x.source)
    .join('\n');
  const browser = await chromium.launch({ headless: true });
  const report = {
    scope:
      'Real NewConversationPage, ChatInput, admission hook and Chromium IndexedDB; synthetic HTTP, no model calls or user profile',
    errors: [],
    requests: [],
    result: null,
  };
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', (error) => report.errors.push(error.message));
    let draft = null;
    let revision = 0;
    let sessionOwner = 'draft-browser-owner';
    const assets = new Map([
      [
        '/',
        {
          contentType: 'text/html',
          body: '<!doctype html><html data-shell="v2" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root" style="display:flex;flex-direction:column;height:100vh"></div><script type="module" src="/entry.js"></script></body></html>',
        },
      ],
      ['/entry.js', { contentType: 'text/javascript', body: script }],
      ['/style.css', { contentType: 'text/css', body: css }],
    ]);
    const readResponses = new Map([
      ['/api/session', () => ({ userId: sessionOwner, csrfToken: 'fixture' })],
      ['/api/projects/cwd', () => ({ path: '/isolated-draft-probe' })],
      [
        '/api/config',
        () => ({ config: { coCreator: { name: 'Fixture', aliases: [], mentionPatterns: ['@co-creator'] } } }),
      ],
      ['/api/cats', () => ({ cats: [] })],
    ]);
    function composerDraftResponse(request) {
      const method = request.method();
      if (method === 'GET') return { body: { draft, revision }, status: 200 };
      const body = request.postDataJSON();
      if (body.expectedRevision !== revision) {
        return { body: { code: 'DRAFT_REVISION_MISMATCH', actualRevision: revision }, status: 409 };
      }
      revision++;
      const cleared = method === 'DELETE';
      draft = cleared
        ? null
        : { ...body, version: 1, ownerUserId: sessionOwner, threadId: 'default', revision, updatedAt: Date.now() };
      return { body: cleared ? { cleared: true, revision } : { draft }, status: 200 };
    }
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const asset = assets.get(url.pathname);
      if (asset) return route.fulfill(asset);
      report.requests.push({ method, path: url.pathname });
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname.endsWith('/composer-draft')) {
        const response = composerDraftResponse(request);
        return json(response.body, response.status);
      }
      if (url.pathname === '/api/routing/preview') return json({ targetCats: [], reason: { kind: 'recent_replier' } });
      if (method !== 'GET' && method !== 'OPTIONS') {
        report.errors.push(`Unexpected mutation ${method} ${url.pathname}`);
        return json({ error: 'Unexpected mutation' }, 500);
      }
      const readResponse = readResponses.get(url.pathname);
      if (readResponse) return json(readResponse());
      if (url.pathname.startsWith('/api/')) return json({});
      if (/^\/shell\/cafe-landing-(dusk|night)\.png$/.test(url.pathname))
        return route.fulfill({ path: path.join(web, 'public', url.pathname) });
      return route.fulfill({ status: 204, body: '' });
    });
    await page.goto('https://draft-navigation.test/');
    await page.locator('textarea').waitFor();
    await page.waitForFunction(async () => {
      const db = await new Promise((resolve) => {
        const request = indexedDB.open('cat-cafe-new-conversation');
        request.onsuccess = () => resolve(request.result);
      });
      const record = await new Promise((resolve) => {
        const request = db.transaction('owner-intents').objectStore('owner-intents').get('draft-browser-owner');
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      return record?.files.length === 0;
    });
    await page.locator('textarea').fill('keep the caption');
    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      window.resumeImageSave = () => {};
      window.imageSaveStarted = false;
      window.pendingImageReads = [];
      File.prototype.arrayBuffer = function () {
        if (this.name !== 'pending.png') return original.call(this);
        window.imageSaveStarted = true;
        return new Promise((resolve, reject) => {
          const read = {
            resolve: () => original.call(this).then(resolve),
            reject: () => reject(new Error('fixture image read failed')),
          };
          window.pendingImageReads.push(read);
          window.resumeImageSave = read.resolve;
        });
      };
    });
    const fixtureImage = await fs.readFile(path.join(web, 'public/icons/icon-192x192.png'));
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'pending.png', mimeType: 'image/png', buffer: fixtureImage });
    await page.waitForFunction(() => window.imageSaveStarted);
    await page.locator('img[alt="pending.png"]').waitFor();
    await page.getByTestId('visit-other').click();
    await page.getByTestId('visit-new').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="new-conversation-page"]'));
    const notice = page.getByTestId('new-conversation-save-state');
    const waitState = (state) =>
      page.waitForFunction(
        (value) =>
          document.querySelector('[data-testid="new-conversation-save-state"]')?.getAttribute('data-save-state') ===
          value,
        state,
      );
    const storedFiles = (owner) =>
      page.evaluate(async (key) => {
        const db = await new Promise((resolve) => {
          const request = indexedDB.open('cat-cafe-new-conversation');
          request.onsuccess = () => resolve(request.result);
        });
        const row = await new Promise((resolve) => {
          const request = db.transaction('owner-intents').objectStore('owner-intents').get(key);
          request.onsuccess = () => resolve(request.result);
        });
        db.close();
        return row?.files.map((file) => file.name) ?? null;
      }, owner);
    // Do not release the old read: a working implementation must render its latest snapshot.
    await page.locator('textarea').waitFor();
    await waitState('saving');
    assert.equal(await page.locator('img[alt="pending.png"]').count(), 1);
    assert.equal(await page.locator('textarea').inputValue(), 'keep the caption');
    assert.equal(await page.evaluate(() => window.pendingImageReads.length), 1, 'Remount must not automatically retry');
    await notice.scrollIntoViewIfNeeded();
    const lightPaint = await notice.evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.screenshot({ path: path.join(artifacts, 'recovery-saving-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      document.documentElement.dataset.theme = 'dark';
    });
    await notice.scrollIntoViewIfNeeded();
    const darkPaint = await notice.evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.notEqual(darkPaint, lightPaint, 'The mobile dark sample must use the real dark theme');
    const bounds = await notice.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390, 'The notice must fit the mobile pane');
    report.presentation = { lightPaint, darkPaint, mobileNoticeFits: true };
    await page.screenshot({ path: path.join(artifacts, 'recovery-saving-mobile-dark.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.dataset.theme = 'light';
    });
    await page.getByTestId('new-conversation-cancel-save').click();
    await waitState('cancelled');
    assert.equal(await page.locator('img[alt="pending.png"]').count(), 1, 'Cancel must preserve the draft');
    await page.getByTestId('new-conversation-retry-save').click();
    await page.waitForFunction(() => window.pendingImageReads.length === 2);
    await page.evaluate(() => window.pendingImageReads[1].reject());
    await waitState('failed');
    await page.screenshot({ path: path.join(artifacts, 'recovery-failed.png'), fullPage: true });
    await page.getByTestId('visit-other').click();
    await page.getByTestId('visit-new').click();
    await page.locator('textarea').waitFor();
    await waitState('failed');
    assert.equal(await page.locator('img[alt="pending.png"]').count(), 1, 'A failed image must remain recoverable');
    assert.equal(
      await page.evaluate(() => window.pendingImageReads.length),
      2,
      'Failure must not trigger automatic retry',
    );
    await page.getByTestId('new-conversation-retry-save').click();
    await page.waitForFunction(() => window.pendingImageReads.length === 3);
    await page.evaluate(() => window.pendingImageReads[2].resolve());
    await notice.waitFor({ state: 'detached' });
    assert.deepEqual(await storedFiles('draft-browser-owner'), ['pending.png']);
    await page.locator('button[aria-label^="Remove "]').click();
    await page.waitForFunction(() => !document.querySelector('img[alt="pending.png"]'));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.deepEqual(await storedFiles('draft-browser-owner'), []);
    await page.evaluate(() => window.pendingImageReads[0].resolve());
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.deepEqual(await storedFiles('draft-browser-owner'), [], 'An old late read must not revive a removed image');
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'pending.png', mimeType: 'image/png', buffer: fixtureImage });
    await page.waitForFunction(() => window.pendingImageReads.length === 4);
    await page.getByTestId('visit-other').click();
    sessionOwner = 'draft-browser-owner-b';
    draft = null;
    revision = 0;
    await page.getByTestId('visit-new').click();
    await page.locator('textarea').waitFor();
    assert.equal(await page.locator('img[alt="pending.png"]').count(), 0, 'Owner B must not inherit A pending image');
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'owner-b.png', mimeType: 'image/png', buffer: fixtureImage });
    await page.locator('img[alt="owner-b.png"]').waitFor();
    await notice.waitFor({ state: 'detached' });
    assert.deepEqual(await storedFiles('draft-browser-owner-b'), ['owner-b.png']);
    report.recovery = {
      restoresWithoutReleasingRead: true,
      cancelPreservesDraft: true,
      failureSurvivesRemount: true,
      explicitRetrySucceeds: true,
      lateReadCannotReviveRemoval: true,
      otherOwnerCanSaveDuringStuckRead: true,
    };
    report.result = { imageRetained: true, caption: 'keep the caption' };

    report.sendCancellation = [];
    for (const phase of ['reading', 'queued', 'writing']) {
      sessionOwner = `draft-cancel-${phase}`;
      draft = null;
      revision = 0;
      await page.evaluate(() => sessionStorage.clear());
      await page.reload();
      await page.locator('textarea').waitFor();
      await page.locator('textarea').fill(`retain cancelled ${phase}`);
      await page.waitForFunction(() => !document.querySelector('[data-testid="new-conversation-save-state"]'));
      await page.evaluate((stage) => {
        if (stage === 'reading') {
          const original = File.prototype.arrayBuffer;
          File.prototype.arrayBuffer = function () {
            if (this.name !== 'cancel-send.png') return original.call(this);
            return new Promise((resolve) => {
              window.draftReadRelease = () => original.call(this).then(resolve);
            });
          };
        } else {
          let release;
          const promise = new Promise((resolve) => {
            release = resolve;
          });
          window.draftWriteGate = { promise, release, started: 0 };
        }
      }, phase);
      if (phase === 'queued') {
        await page.evaluate((owner) => window.draftStorageProbe.startOlderSave(owner), sessionOwner);
        await page.waitForFunction(() => window.draftWriteGate.started === 1);
      }
      await page
        .locator('input[type="file"]')
        .setInputFiles({ name: 'cancel-send.png', mimeType: 'image/png', buffer: fixtureImage });
      await page.locator('img[alt="cancel-send.png"]').waitFor();
      if (phase === 'writing') {
        await page.waitForFunction(() => window.draftWriteGate.started === 1);
        assert.equal(await page.getByTestId('new-conversation-cancel-save').isDisabled(), true);
      }
      if (phase === 'reading') await page.waitForFunction(() => Boolean(window.draftReadRelease));
      await page.locator('textarea').press('Enter');
      const cancel = page.getByTestId('new-conversation-cancel-save');
      await page.waitForFunction(() =>
        /取消发送|Cancel sending/.test(
          document.querySelector('[data-testid="new-conversation-cancel-save"]')?.textContent,
        ),
      );
      assert.equal(await cancel.isEnabled(), true);
      await cancel.click();
      // Do not release either boundary until the actual composer is unlocked.
      await page.waitForFunction(
        () => !document.querySelector('textarea').disabled && !document.querySelector('textarea').readOnly,
      );
      assert.equal(await page.locator('img[alt="cancel-send.png"]').count(), 1);
      assert.equal(await page.locator('textarea').inputValue(), `retain cancelled ${phase}`);
      assert.equal(await page.evaluate(() => window.draftSendCalls), 0);
      await page.screenshot({ path: path.join(artifacts, `cancel-send-${phase}.png`), fullPage: true });
      await page.evaluate(async (owner) => {
        window.draftReadRelease?.();
        window.draftWriteGate?.release();
        await window.draftStorageProbe.olderSave;
        await window.draftStorageProbe.clear(owner);
      }, sessionOwner);
      assert.equal(await page.evaluate(() => window.draftSendCalls), 0, 'Late storage completion must not send');
      assert.equal(
        report.requests.some((request) => request.method === 'POST' && request.path === '/api/threads'),
        false,
      );
      report.sendCancellation.push({ phase, settledBeforeRelease: true, noLateSend: true });
    }

    assert.equal(report.errors.length, 0, report.errors.join('\n'));
  } finally {
    await browser.close();
    report.browserClosed = !browser.isConnected();
    await fs.writeFile(path.join(artifacts, 'browser-recovery-results.json'), JSON.stringify(report, null, 2));
  }
});
