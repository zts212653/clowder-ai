import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

const web = fileURLToPath(new URL('../..', import.meta.url));
const origin = 'https://chat-reference-demand.test';

test(
  'native viewport demand bounds history reads and preserves refresh after returning',
  { timeout: 120000 },
  async (t) => {
    const previousCwd = process.cwd();
    let compiled;
    try {
      process.chdir(web); // Tailwind's content globs resolve against the process cwd.
      compiled = await build({
        root: web,
        configFile: false,
        logLevel: 'silent',
        esbuild: { jsx: 'automatic' },
        resolve: { alias: { '@': path.join(web, 'src') } },
        define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
        build: {
          write: false,
          minify: false,
          rollupOptions: {
            input: path.join(web, 'test/browser/fixtures/chat-reference-demand.tsx'),
            output: { format: 'es', inlineDynamicImports: true },
          },
        },
      });
    } finally {
      process.chdir(previousCwd);
    }
    const outputs = Array.isArray(compiled) ? compiled.flatMap((item) => item.output) : compiled.output;
    const script = outputs.find((item) => item.type === 'chunk' && item.isEntry)?.code;
    assert.ok(script);
    const css = outputs
      .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
      .map((item) => item.source)
      .join('\n');
    assert.ok(css.includes('.text-sm'), 'the native proof includes the product Tailwind utilities');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const batches = [],
      errors = [],
      prefetch = [];
    let deleted = false;
    const evidence = process.env.F322_REFERENCE_DEMAND_EVIDENCE;
    t.after(async () => {
      try {
        if (evidence) {
          await mkdir(evidence, { recursive: true });
          await page.screenshot({ path: path.join(evidence, 'final.png') });
          await writeFile(path.join(evidence, 'proof.json'), JSON.stringify({ batches, errors, prefetch }, null, 2));
        }
      } finally {
        try {
          await context.close();
        } finally {
          await browser.close();
        }
      }
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.clock.install();
    await page.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      assert.equal(url.origin, origin, 'the demand test must not access a live service');
      if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/api/workspace/chat-references') {
        assert.equal(request.method(), 'POST');
        const body = request.postDataJSON();
        batches.push(body);
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            groups: body.groups.map((group) => ({
              ...group,
              results: group.references.map((reference) => ({
                reference,
                target:
                  reference === 'docs/visible.md' && deleted
                    ? { kind: 'missing' }
                    : reference.endsWith('.md')
                      ? {
                          kind: 'file',
                          entryType: 'file',
                          worktreeId: 'project',
                          path: reference,
                          absolutePath: `/registered/project/${reference}`,
                          line: null,
                          mime: 'text/markdown',
                          size: 42,
                          modifiedAt: '2026-10-23T08:00:00Z',
                        }
                      : null,
              })),
            })),
          }),
        });
      }
      assert.equal(request.method(), 'GET');
      return route.fulfill({
        contentType: 'text/html',
        body:
          `<!doctype html><meta charset="utf-8"><style>${css}\n[data-history] p { min-height: 96px; }</style>` +
          '<div id="root"></div><script type="module" src="/proof.js"></script>',
      });
    });
    const references = () => batches.flatMap((batch) => batch.groups.flatMap((group) => group.references));
    const count = (reference) => references().filter((value) => value === reference).length;
    await page.goto(origin);
    const visible = page.locator('[data-visible]');
    await visible.locator('[data-chat-reference-kind=file]').waitFor();
    assert.equal(count('docs/visible.md'), 1);
    assert.equal(count('owner/repo'), 1);
    assert.equal(references().filter((reference) => reference.startsWith('docs/history-')).length, 0);
    await page.clock.fastForward(5100);
    await page.getByRole('button', { name: 'Stream', exact: true }).click();
    await page.clock.fastForward(30);
    assert.equal(count('owner/repo'), 1, 'a streaming render must not restart the unchanged null lookup');
    const scrollport = page.locator('[data-chat-container]');
    const firstHistory = page.locator('[data-history] p').first();
    await firstHistory.waitFor({ state: 'attached' });
    await scrollport.evaluate((element) => {
      const target = element.querySelector('[data-history] p');
      element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().bottom - 128;
    });
    const geometry = () =>
      scrollport.evaluate((element) => ({
        rootBottom: element.getBoundingClientRect().bottom,
        targetTop: element.querySelector('[data-history] p').getBoundingClientRect().top,
        scrollTop: element.scrollTop,
      }));
    prefetch.push({ phase: 'before-read', ...(await geometry()) });
    await firstHistory.locator('[data-chat-reference-kind=file]').waitFor({ state: 'attached', timeout: 5000 });
    const readGeometry = await geometry();
    prefetch.push({ phase: 'prefetched-while-clipped', ...readGeometry });
    assert.ok(
      readGeometry.targetTop > readGeometry.rootBottom,
      'the prefetched paragraph is still outside the chat viewport',
    );
    assert.ok(readGeometry.targetTop < readGeometry.rootBottom + 256, 'the paragraph is within the chat preload band');
    const historyReads = references().filter((reference) => reference.startsWith('docs/history-'));
    assert.ok(historyReads.length > 0 && historyReads.length < 12, 'only paragraphs near the viewport are read');
    assert.ok(!historyReads.includes('docs/history-191.md'));
    deleted = true;
    await page.clock.fastForward(31000);
    assert.equal(count('docs/visible.md'), 1, 'offscreen cached files must not refresh');
    assert.equal(
      await visible.locator('[data-chat-reference-kind=file]').count(),
      1,
      'cached presentation survives leaving',
    );
    await visible.scrollIntoViewIfNeeded();
    await visible.locator('[data-chat-reference-kind=missing]').waitFor();
    assert.equal(count('docs/visible.md'), 2, 'returning to an expired file revalidates its deletion');
    assert.deepEqual(errors, []);
  },
);
