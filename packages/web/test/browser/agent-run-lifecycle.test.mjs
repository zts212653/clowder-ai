import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test(
  'real browser closes, reloads and restores Agent Run without background transcript reads',
  { timeout: 240_000 },
  async (t) => {
    let bundle = '';
    let css = '';
    let deny = false;
    const calls = [];
    const errors = [];
    const summary = {
      invocationId: 'lifecycle-invocation',
      threadId: 'lifecycle-thread',
      sessionId: 'lifecycle-session',
      sessionSeq: 0,
      sessionStatus: 'active',
      catId: 'codex61-sol',
      status: 'running',
      startedAt: 1000,
      eventCount: 0,
      statusEventCount: 0,
      toolUseCount: 0,
      toolResultCount: 0,
      messageCount: 0,
      errorCount: 0,
      toolNames: [],
      keyMessages: [],
    };
    const server = createServer((req, res) => {
      const url = req.url;
      if (url === '/host.js') {
        res.setHeader('content-type', 'text/javascript');
        res.end(bundle);
        return;
      }
      if (url === '/host.css') {
        res.setHeader('content-type', 'text/css');
        res.end(css);
        return;
      }
      if (url.startsWith('/api/')) {
        calls.push(url);
        let body = {};
        if (url.startsWith('/api/cats')) body = { cats: [] };
        else if (url.startsWith('/api/config/cat-order')) body = { catOrder: [] };
        else if (url.startsWith('/api/config')) body = { config: {} };
        else if (url.includes('/trajectory?')) {
          body = deny ? { code: 'INVOCATION_FORBIDDEN' } : summary;
          if (deny) res.statusCode = 403;
        } else if (url.includes('/request-generations?')) body = { ...summary, generations: [], gaps: [] };
        else if (url.startsWith('/api/sessions/')) body = { ...summary, summary, events: [], total: 0 };
        else if (url.includes('/invocations?')) body = { invocations: [summary], total: 1 };
        else if (url.includes('/workspace/diff'))
          body = { worktreeId: 'lifecycle-worktree', changedFiles: [], diff: '' };
        else body = { items: [], threads: [], tasks: [], events: [], artifacts: [], runs: [], total: 0 };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(
        '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="/host.css"><div id="root"></div><script type="module" src="/host.js"></script></html>',
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const result = await build({
      root: web,
      configFile: false,
      logLevel: 'error',
      esbuild: { jsx: 'automatic' },
      resolve: { alias: { '@': path.join(web, 'src') } },
      define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: path.join(web, 'test/browser/fixtures/agent-run-lifecycle.tsx'),
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    const output = Array.isArray(result) ? result.flatMap((r) => r.output) : result.output;
    bundle = output.find((item) => item.type === 'chunk' && item.isEntry).code;
    css = output
      .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
      .map((item) => item.source)
      .join('\n');
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (error) => errors.push(error.message));
    const count = () =>
      calls.filter((url) =>
        /\/trajectory\?|\/request-generations\?|\/api\/sessions\/|\/api\/debug\/prompt-captures\?|\/api\/telemetry\/traces\?|\/api\/recall\/trajectories\?/.test(
          url,
        ),
      ).length;
    const canonical = () => calls.filter((url) => url.includes('/trajectory?')).length;
    await page.goto(origin);
    await page.getByTestId('f307-close-agent-run').waitFor();
    await page.waitForLoadState('networkidle');
    assert.equal(canonical(), 1);
    const visible = count();
    await page.waitForTimeout(1200);
    assert.equal(count(), visible, 'same visible target must not reread on live host pulses');
    await page.getByTestId('f307-close-agent-run').click();
    await page.getByTestId('f307-recently-closed').waitFor();
    const closed = count();
    await page.waitForTimeout(1200);
    assert.equal(count(), closed);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    assert.equal(count(), closed, 'restored closed descriptor must remain network-idle on Home');
    await page.getByTestId('f307-recently-closed-toggle').click();
    await page.getByTestId('f307-restore-agent-run').click();
    await page.waitForLoadState('networkidle');
    assert.equal(canonical(), 2);
    await page.getByTestId('fixture-visibility').click();
    const hidden = count();
    await page.waitForTimeout(1200);
    assert.equal(count(), hidden);
    deny = true;
    await page.getByTestId('fixture-visibility').click();
    await page.getByText('没有权限查看这轮 invocation。', { exact: true }).waitFor();
    assert.equal(canonical(), 3);
    assert.equal(count(), hidden + 1, 'denied revalidation must not read detail or source evidence');
    assert.deepEqual(errors, []);
    if (process.env.TASK229_BROWSER_EVIDENCE) {
      await mkdir(process.env.TASK229_BROWSER_EVIDENCE, { recursive: true });
      await writeFile(
        path.join(process.env.TASK229_BROWSER_EVIDENCE, 'browser-network.json'),
        JSON.stringify(
          {
            cwd: web,
            origin,
            head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: web, encoding: 'utf8' }).trim(),
            calls,
            errors,
            canonical: canonical(),
            visible,
            closed,
            hidden,
          },
          null,
          2,
        ),
      );
      await page.screenshot({
        path: path.join(process.env.TASK229_BROWSER_EVIDENCE, 'denied-reopen.png'),
        fullPage: true,
      });
    }
  },
);
