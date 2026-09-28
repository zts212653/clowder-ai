import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { MessageStore } from '../../../api/src/domains/cats/services/stores/ports/MessageStore.ts';
import { createCollaborativeContentComposition } from '../../../api/src/domains/collaborative-content/runtime-composition.ts';
import { OFFICIAL_PLUGIN_CATALOG } from '../../../api/src/domains/plugin/official-catalog.ts';
import { OfficialPluginPackageInstaller } from '../../../api/src/domains/plugin/official-package-installer.ts';
import { createDormantPluginRuntimeComposition } from '../../../api/src/domains/plugin/runtime-composition.ts';
import { MemoryMeetingIntakeStore } from '../../../api/src/domains/signal-intake/MeetingIntakeStore.ts';
import { MemorySignalRouteStore } from '../../../api/src/domains/signal-intake/SignalRouteStore.ts';
import { registerCollaborativeContentRoutes } from '../../../api/src/routes/collaborative-content-routes.ts';
import { registerOfficialPluginRoutes } from '../../../api/src/routes/plugin-official-routes.ts';
import { registerWorkspaceContentEditorRoutes } from '../../../api/src/routes/workspace-content-editor-routes.ts';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { observeOfficePage } from './fixtures/f309-browser-observers.mjs';
import { verifyDocxRoundTrip } from './fixtures/f309-docx-roundtrip.mjs';
import { editorLayout } from './fixtures/f309-editor-layout.mjs';
import { appendParagraph, setGenOfficeEnabled, verifyEditorRecovery } from './fixtures/f309-editor-recovery.mjs';
import { registerNamedCatJourney } from './fixtures/f309-named-cat-journey.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const apiRequire = createRequire(path.resolve(WEB_ROOT, '../api/package.json'));
const Fastify = apiRequire('fastify');
const cors = apiRequire('@fastify/cors');
const webRequire = createRequire(path.join(WEB_ROOT, 'package.json'));
const tailwind = webRequire('tailwindcss');
const tailwindConfig = webRequire(path.join(WEB_ROOT, 'tailwind.config.js'));

// Canonical browser acceptance uses the committed complex DOCX and published catalog SRI.
// An explicit fixture path also supports acceptance against other genuine documents.
test(
  'exact GenOffice artifact: actual Settings install/enable and F307 Workspace editor journey',
  { timeout: 150_000 },
  async (t) => {
    const fixturePath =
      process.env.GENOFFICE_DOCX_FIXTURE ??
      fileURLToPath(new URL('./fixtures/f309-complex-chinese-chart.docx', import.meta.url));
    const sourceBytes = await readFile(fixturePath);
    const ownerUserId = process.env.DEFAULT_OWNER_USER_ID?.trim() || 'operator';
    const publishedEntry = OFFICIAL_PLUGIN_CATALOG.find((row) => row.catalogId === 'genoffice-docx');
    assert.ok(publishedEntry);
    const candidate = process.env.F309_CANDIDATE_VERSION;
    if (candidate)
      assert.ok(
        process.env.GENOFFICE_ARCHIVE_PATH && process.env.F309_CANDIDATE_SRI,
        'candidate acceptance requires an exact local archive/SRI',
      );
    const entry = candidate
      ? { ...publishedEntry, version: candidate, packageDigest: process.env.F309_CANDIDATE_SRI }
      : publishedEntry;
    const scratch = await mkdtemp(path.join(tmpdir(), 'f309-published-journey-'));
    const evidence = process.env.F309_BROWSER_EVIDENCE_DIR ?? scratch;
    await mkdir(evidence, { recursive: true });
    let bundle = '';
    let css = '';
    const frontend = createServer((req, res) => {
      if (req.url === '/host.js') {
        res.setHeader('content-type', 'text/javascript');
        res.end(bundle);
        return;
      }
      if (req.url === '/host.css') {
        res.setHeader('content-type', 'text/css');
        res.end(css);
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(
        '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/host.css"><style>body{margin:0}iframe{height:850px;width:100%}section{padding:12px}</style><div id="root"></div><script type="module" src="/host.js"></script>',
      );
    });
    await new Promise((resolve) => frontend.listen(0, '127.0.0.1', resolve));
    const parentOrigin = `http://127.0.0.1:${frontend.address().port}`;
    const plugins = createDormantPluginRuntimeComposition({
      projectRoot: scratch,
      editorParentOrigin: parentOrigin,
      routes: new MemorySignalRouteStore(),
      intakes: new MemoryMeetingIntakeStore(),
      messageStore: new MessageStore(),
    });
    let imported = 0;
    const content = createCollaborativeContentComposition({
      dataDir: scratch,
      ownerUserId,
      plugins,
      readSource: async (worktreeId, filePath) => {
        assert.equal(worktreeId, 'genoffice-acceptance');
        assert.equal(filePath, 'sample.docx');
        imported++;
        return sourceBytes;
      },
    });
    let archiveBytes;
    if (process.env.GENOFFICE_ARCHIVE_PATH) {
      archiveBytes = await readFile(process.env.GENOFFICE_ARCHIVE_PATH);
      assert.equal(`sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`, entry.packageDigest);
    }
    const installer = new OfficialPluginPackageInstaller({
      inventory: plugins.inventory,
      packagesRoot: plugins.paths.packagesRoot,
      catalog: [entry],
      ...(archiveBytes ? { fetchArchive: async () => archiveBytes } : {}),
    });
    const app = Fastify();
    // Test-only session issuer. Production handlers retain their actual local-owner
    // authorization; the separate owner-scope regression exercises denied callers.
    app.decorateRequest('sessionUserId', null);
    app.addHook('onRequest', async (request) => {
      request.sessionUserId = ownerUserId;
    });
    await app.register(cors, { origin: parentOrigin, credentials: true });
    app.get('/api/session', async () => ({ userId: ownerUserId }));
    registerOfficialPluginRoutes(app, {
      inventory: plugins.inventoryStore,
      installer,
      lifecycle: plugins.lifecycle,
      catalog: [entry],
    });
    registerCollaborativeContentRoutes(app, { ...content, ownerUserId });
    registerWorkspaceContentEditorRoutes(app, { workspace: content.workspace, ownerUserId });
    const namedCatJourney =
      process.env.F309_INDEPENDENT_CAT === '1'
        ? await registerNamedCatJourney(app, content, ownerUserId, scratch)
        : undefined;
    const apiOrigin = await app.listen({ port: 0, host: '127.0.0.1' });
    let browser;
    t.after(async () => {
      await browser?.close();
      await app.close();
      await plugins.shutdown();
      frontend.closeAllConnections();
      await new Promise((resolve) => frontend.close(resolve));
      if (evidence !== scratch) await rm(scratch, { recursive: true, force: true });
    });
    const result = await build({
      root: WEB_ROOT,
      configFile: false,
      logLevel: 'silent',
      esbuild: { jsx: 'automatic' },
      css: {
        postcss: { plugins: [tailwind({ ...tailwindConfig, content: [path.join(WEB_ROOT, 'src/**/*.{ts,tsx}')] })] },
      },
      resolve: { alias: { '@': path.join(WEB_ROOT, 'src') } },
      define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(apiOrigin) },
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: path.join(WEB_ROOT, 'test/browser/fixtures/f309-genoffice-workspace.tsx'),
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
    bundle = outputs.find((item) => item.type === 'chunk' && item.isEntry).code;
    css = outputs
      .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
      .map((item) => item.source)
      .join('\n');
    browser = await chromium.launch({ headless: true });
    const viewportWidth = Number(process.env.F309_VIEWPORT_WIDTH ?? 1440);
    assert.ok(Number.isInteger(viewportWidth) && viewportWidth >= 320 && viewportWidth <= 1920);
    const context = await browser.newContext({ viewport: { width: viewportWidth, height: 1100 } });
    const page = await context.newPage();
    const errors = [];
    const externalRequests = [];
    const bridgeResponses = [];
    const mutations = [];
    const opened = [];
    const observe = (target) => observeOfficePage(target, apiOrigin, { errors, mutations, bridgeResponses, opened });
    observe(page);
    await page.context().route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (
        url.origin === parentOrigin ||
        url.origin === apiOrigin ||
        (url.protocol === 'http:' && /^editor-[a-f0-9]+\.localhost$/.test(url.hostname))
      ) {
        await route.continue();
        return;
      }
      externalRequests.push(url.href);
      await route.abort();
    });
    page.on('dialog', async (dialog) => {
      if (dialog.type() === 'confirm') await dialog.accept();
      else await dialog.dismiss();
    });
    try {
      await page.goto(parentOrigin);
      const installation = page.waitForResponse((response) => response.url().endsWith('/genoffice-docx/install'));
      await page.getByRole('button', { name: '安装', exact: true }).click();
      const installedResponse = await installation;
      assert.equal(installedResponse.status(), 200, await installedResponse.text());
      await page.getByRole('button', { name: '启用 GenOffice', exact: true }).waitFor();
      assert.equal((await plugins.inventoryStore.snapshot()).instances[0].activationState, 'disabled');
      await setGenOfficeEnabled(page, true);
      const initialOpen = page.waitForResponse(
        (response) => response.url().endsWith('/api/workspace/content-editor') && response.status() === 200,
      );
      await page.getByRole('button', { name: '重新打开', exact: true }).click();
      const initialTarget = await (await initialOpen).json();
      await page.getByTestId('content-editor-connected').waitFor({ timeout: 30_000 });
      const renderer = page.frames().find((frame) => new URL(frame.url()).hostname.endsWith('.localhost'));
      assert.ok(renderer);
      await renderer.locator('[contenteditable="true"]').first().waitFor({ timeout: 20_000 });
      await editorLayout(renderer);
      await page.screenshot({ path: path.join(evidence, 'opened.png'), fullPage: true });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        'Workspace must fit the viewport',
      );
      await writeFile(path.join(evidence, 'renderer-dom.html'), await renderer.content());
      const otherPage = await page.context().newPage();
      otherPage.on('pageerror', (error) => errors.push(error.message));
      await otherPage.goto(parentOrigin);
      await otherPage.getByTestId('content-editor-connected').waitFor();
      const staleRenderer = otherPage.frames().find((frame) => new URL(frame.url()).hostname.endsWith('.localhost'));
      assert.ok(staleRenderer);
      await staleRenderer.locator('.ProseMirror[contenteditable="true"]').first().waitFor();
      const marker = 'F309 saved through the published GenOffice editor';
      await appendParagraph(renderer, page, marker);
      const saveResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith('/editor-bridge') &&
          response.request().postDataJSON()?.operation === 'content.settle',
      );
      await renderer.getByRole('button', { name: '保存 (⌘S)', exact: true }).click();
      const saved = await saveResponse;
      assert.equal(saved.status(), 200, await saved.text());
      const receipt = (await saved.json()).value;
      assert.ok(receipt.receiptId);
      const persisted = await content.owner.load(initialTarget.contentRef);
      assert.equal(persisted.ownerRevision, receipt.ownerRevision);
      const savedPath = path.join(evidence, 'saved.docx');
      await writeFile(savedPath, persisted.bytes);
      const roundTrip = await verifyDocxRoundTrip(fixturePath, savedPath, marker);
      await appendParagraph(staleRenderer, otherPage, 'This stale edit must not replace the saved document');
      const staleSave = otherPage.waitForResponse(
        (response) =>
          response.url().endsWith('/editor-bridge') &&
          response.request().postDataJSON()?.operation === 'content.settle',
      );
      await staleRenderer.getByRole('button', { name: '保存 (⌘S)', exact: true }).click();
      const conflictResponse = await staleSave;
      assert.equal(conflictResponse.status(), 409, await conflictResponse.text());
      assert.equal((await conflictResponse.json()).error.code, 'owner_revision_conflict');
      assert.equal((await content.owner.load(initialTarget.contentRef)).ownerRevision, receipt.ownerRevision);
      await otherPage.close();
      const oldRendererUrl = await page.locator('iframe').getAttribute('src');
      const nextOpen = page.waitForResponse(
        (response) => response.url().endsWith('/api/workspace/content-editor') && response.status() === 200,
      );
      await page.getByRole('button', { name: '重新打开', exact: true }).click();
      await page.getByRole('button', { name: '丢弃修改并重新打开', exact: true }).click();
      const nextTarget = await (await nextOpen).json();
      await page.waitForFunction((oldUrl) => {
        const src = document.querySelector('iframe')?.getAttribute('src');
        return Boolean(src && src !== oldUrl);
      }, oldRendererUrl);
      await page.getByTestId('content-editor-connected').waitFor();
      const reopened = page.frames().find((frame) => new URL(frame.url()).hostname.endsWith('.localhost'));
      assert.ok(reopened);
      await reopened.getByText(marker, { exact: true }).waitFor();
      const layout = await editorLayout(reopened);
      await writeFile(path.join(evidence, 'editor-layout.json'), JSON.stringify(layout, null, 2));
      assert.ok(layout.visible, 'the document text must be visible in the editor viewport');
      assert.equal(nextTarget.contentRef, initialTarget.contentRef);
      assert.equal(nextTarget.ownerRevision, receipt.ownerRevision);
      await page.screenshot({ path: path.join(evidence, 'saved-and-reopened.png'), fullPage: true });
      await verifyEditorRecovery({ page, frame: reopened, evidence, marker });
      assert.equal((await content.owner.load(initialTarget.contentRef)).ownerRevision, receipt.ownerRevision);
      let namedCat;
      if (namedCatJourney) {
        await page.close();
        namedCat = await namedCatJourney({
          apiOrigin,
          parentOrigin,
          context,
          contentRef: initialTarget.contentRef,
          evidence,
          observe,
        });
        assert.equal(namedCat.markup.tables, roundTrip.tables);
        assert.equal(namedCat.markup.drawings, roundTrip.drawings);
      }
      assert.equal(imported, 1);
      assert.equal(externalRequests.length, 0, 'renderer attempted external requests');
      assert.deepEqual(errors, []);
      await writeFile(
        path.join(evidence, 'result.json'),
        JSON.stringify(
          {
            artifactSource: candidate ? 'unpublished-packed-candidate' : 'published-registry',
            package: entry,
            viewportWidth,
            imported,
            receipt,
            roundTrip,
            namedCat,
            sourceImportedOnce: imported === 1,
            savedTextPresent: true,
            reopenedSameContentRef: true,
            staleSaveRejected: true,
            disabledSaveRejected: true,
            unsavedFramePreserved: true,
            explicitDiscardAndReenableRecovery: true,
            externalRequests,
            errors,
            bridgeResponses: bridgeResponses.map((r) => ({ status: r.status, ok: r.body?.ok })),
          },
          null,
          2,
        ),
      );
    } catch (error) {
      if (!page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
      await writeFile(
        path.join(evidence, 'failure.json'),
        JSON.stringify({ error: String(error), errors, externalRequests, mutations, bridgeResponses }, null, 2),
      );
      throw new Error(`${error.stack ?? error}\nBrowser errors: ${errors.join('; ')}\nEvidence: ${evidence}`);
    }
  },
);
