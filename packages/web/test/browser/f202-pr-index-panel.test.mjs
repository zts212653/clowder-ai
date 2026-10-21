import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { build } from 'vite';

const { chromium } = await import(
  process.env.F202_PLAYWRIGHT_MODULE ?? '../../../ppt-forge/node_modules/playwright/index.mjs'
);

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(webRoot, 'package.json'));
const tailwind = require('tailwindcss');
const tailwindConfig = require(path.join(webRoot, 'tailwind.config.js'));

test(
  'actual CommunityPanel renders stale PR status and explicit bounded retry on desktop and mobile',
  { timeout: 90000 },
  async () => {
    const evidence = process.env.F202_PR_BROWSER_EVIDENCE ?? (await mkdtemp(path.join(tmpdir(), 'f202-pr-panel-')));
    await mkdir(evidence, { recursive: true });
    const app = Fastify();
    let refreshStatus = 'incomplete',
      refreshes = 0,
      unavailable = false,
      discoveryUnavailable = false,
      boardReads = 0,
      script = '',
      css = '';
    const row = {
      taskId: 'pr:owner/repo#42',
      prNumber: 42,
      title: '保留上次完整的 PR 观察结果',
      author: 'external',
      group: 'unreplied',
      status: 'open',
      updatedAt: 1791504000000,
    };
    app.get('/', async (_request, reply) =>
      reply
        .type('text/html')
        .send(
          '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/proof.css"></head><body><div id="root"></div><script type="module" src="/proof.js"></script></body></html>',
        ),
    );
    app.get('/proof.js', async (_request, reply) => reply.type('text/javascript').send(script));
    app.get('/proof.css', async (_request, reply) => reply.type('text/css').send(css));
    app.get('/api/community-repos', async () => ({
      repos: discoveryUnavailable ? [] : ['owner/repo'],
      prSourceStatus: discoveryUnavailable ? 'unavailable' : 'available',
    }));
    app.get('/api/community-board', async (_request, reply) => {
      boardReads++;
      return unavailable
        ? reply.status(503).send({ error: 'unavailable' })
        : {
            repo: 'owner/repo',
            issues: [],
            prItems: [row],
            prIndex: {
              publishedGeneration: 'fixture-generation',
              observedAt: 1791504000000,
              refreshStatus,
              failedSubjects: [],
            },
          };
    });
    app.get('/api/community-decision-queue', async () => ({ items: [], warnings: [] }));
    app.get('/api/community-findings', async () => ({ findings: [] }));
    app.get('/api/cats', async () => ({ cats: [] }));
    app.post('/api/community-issues/sync-prs', async (request, reply) => {
      refreshes++;
      if (refreshStatus === 'limit_exceeded') assert.equal(request.body.restart, true);
      refreshStatus = refreshes === 1 ? 'failed' : 'complete';
      return reply.status(refreshStatus === 'failed' ? 502 : 200).send({ status: refreshStatus });
    });
    let browser;
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const built = await build({
        root: webRoot,
        configFile: false,
        logLevel: 'silent',
        esbuild: { jsx: 'automatic' },
        css: {
          postcss: { plugins: [tailwind({ ...tailwindConfig, content: [path.join(webRoot, 'src/**/*.{ts,tsx}')] })] },
        },
        resolve: { alias: { '@': path.join(webRoot, 'src') } },
        define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(app.listeningOrigin) },
        build: {
          write: false,
          minify: false,
          rollupOptions: {
            input: path.join(webRoot, 'test/browser/fixtures/f202-pr-index-panel.tsx'),
            output: { format: 'es', inlineDynamicImports: true },
          },
        },
      });
      const outputs = Array.isArray(built) ? built.flatMap((item) => item.output) : built.output;
      script = outputs.find((item) => item.type === 'chunk' && item.isEntry).code;
      css = outputs
        .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
        .map((item) => item.source)
        .join('\n');
      browser = await chromium.launch({
        headless: true,
        ...(process.env.F202_BROWSER_EXECUTABLE ? { executablePath: process.env.F202_BROWSER_EXECUTABLE } : {}),
      });
      const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(app.listeningOrigin, { waitUntil: 'networkidle' });
      await page.getByText('PR 同步尚未完成。').waitFor();
      assert.equal(refreshes, 0, 'read-only auto refresh never advances provider work');
      await page.screenshot({ path: path.join(evidence, 'desktop-incomplete.png') });
      await page.getByRole('button', { name: '继续同步 PR', exact: true }).click();
      await page.getByRole('button', { name: '重试 PR', exact: true }).waitFor();
      assert.equal(refreshes, 1);
      await page.getByText(row.title).waitFor();
      await page.getByRole('button', { name: '重试 PR', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('output'));
      assert.equal(refreshes, 2);
      refreshStatus = 'limit_exceeded';
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload({ waitUntil: 'networkidle' });
      const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
      assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), lightBackground);
      await page.getByRole('button', { name: '重新同步 PR', exact: true }).waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(evidence, 'mobile-limit.png') });
      await page.getByRole('button', { name: '重新同步 PR', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('output'));
      unavailable = true;
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByText('无法读取社区看板，请检查 GitHub 插件是否已启用。', { exact: false }).waitFor();
      await page.screenshot({ path: path.join(evidence, 'mobile-unavailable.png') });
      discoveryUnavailable = true;
      const readsBeforeEmptyDiscovery = boardReads;
      const refreshesBeforeRecovery = refreshes;
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByText('无法读取 PR 仓库，请检查 GitHub 插件是否已启用。', { exact: false }).waitFor();
      assert.equal(
        boardReads,
        readsBeforeEmptyDiscovery,
        'empty discovery must report failure without a board request',
      );
      await page.screenshot({ path: path.join(evidence, 'mobile-discovery-unavailable.png') });
      discoveryUnavailable = false;
      unavailable = false;
      await page.getByRole('button', { name: '重新读取仓库', exact: true }).click();
      await page.getByText(row.title).waitFor();
      await page.waitForFunction(() => !document.querySelector('output'));
      assert.equal(refreshes, refreshesBeforeRecovery, 'discovery recovery is read-only');
      assert.deepEqual(errors, []);
      await writeFile(
        path.join(evidence, 'result.json'),
        JSON.stringify(
          {
            actualComponent: true,
            actualDesignTokens: true,
            mockedHttpData: true,
            desktopAndMobile: true,
            darkThemeVerified: true,
            incompleteFailedCompleteLimitUnavailable: true,
            explicitRetryOnly: true,
            initialEmptyDiscoveryErrorAndReadOnlyRecovery: true,
            refreshes,
            horizontalOverflow: false,
            errors,
            operatorAcceptance: false,
          },
          null,
          2,
        ),
      );
    } finally {
      await browser?.close();
      await app.close();
    }
  },
);
