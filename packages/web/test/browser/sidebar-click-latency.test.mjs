import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { build } from 'vite';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = process.env.SIDEBAR_CLICK_EVIDENCE;
const source = { status: 'available', exhaustiveness: 'complete' };
const decisions = {
  version: 1,
  status: 'available',
  scope: 'owner_all_projects',
  identity: { ownerUserId: 'fixture-owner' },
  observedAt: 3,
  sources: { approvals: source, needsMe: source },
  readWindow: { startedAt: 1, endedAt: 3, consistency: 'independent_source_reads' },
  consistency: { state: 'verified', reasons: [] },
  items: [],
  totalCount: 0,
  page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
};

test('2346-row sidebar clears clicked unread and paints selection within 200ms', { timeout: 240_000 }, async (t) => {
  await mkdir(evidence, { recursive: true });
  const now = Date.now();
  const rows = Array.from({ length: 2346 }, (_, i) => ({
    id: `row-${i}`,
    title: `Private thread ${String(i).padStart(4, '0')}`,
    participants: [],
    labels: [],
    preferredCats: [],
    projectPath: '/private/sidebar',
    lastActiveAt: now - i * 1000,
    pinned: true,
    favorited: false,
    systemKind: null,
    isHubThread: false,
    unreadCount: i === 0 ? 0 : 21,
    hasUserMention: false,
    presence: { status: 'idle' },
  }));
  const groups = Array.from({ length: 80 }, (_, i) => ({
    id: `fixture-group-${i}`,
    name: `Private group ${i}`,
    threadIds: Array.from({ length: 4 }, (_, j) => `row-${3 + i * 4 + j}`),
  }));
  let preferences = {
    aliases: {},
    open: Object.fromEntries(groups.map((g) => [`group:${g.id}`, false])),
    groups,
    memberSort: {},
    collapsedPeek: {},
  };
  let script = '',
    css = '';
  let tabMode = 'pinned';
  const calls = [],
    errors = [],
    measurements = [];
  const server = createServer((req, res) => {
    if (req.url === '/host.js' || req.url === '/host.css') {
      res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(req.url.endsWith('.js') ? script : css);
      return;
    }
    if (req.url.startsWith('/api/')) {
      calls.push({ at: Date.now(), method: req.method, url: req.url });
      if (req.method === 'PUT' && req.url === '/api/config/thread-attention') {
        let raw = '';
        req.on('data', (b) => (raw += b));
        req.on('end', () => {
          const body = JSON.parse(raw);
          preferences = { ...preferences, open: { ...preferences.open, [body.anchor]: body.open } };
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(preferences));
        });
        return;
      }
      let body = { items: [], threads: [], tasks: [], labels: [], cats: [], projects: [], total: 0 };
      if (req.url === '/api/threads?view=sidebar')
        body = { threads: rows.map((row) => ({ ...row, pinned: tabMode === 'pinned' })) };
      else if (req.url === '/api/config/thread-attention') body = preferences;
      else if (req.url === '/api/threads/relations') body = { v: 1, nodes: [] };
      else if (req.url === '/api/session') body = { userId: 'fixture-owner' };
      else if (req.url.startsWith('/api/concierge/work/decisions')) body = decisions;
      else if (req.url === '/api/projects/cwd') body = { path: '/private/sidebar' };
      else if (req.url.startsWith('/api/config/cat-order')) body = { catOrder: [] };
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
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sourceFiles = [
    'src/components/ThreadSidebar/ThreadSidebar.tsx',
    'test/browser/fixtures/sidebar-click-latency.tsx',
    'test/browser/sidebar-click-latency.test.mjs',
  ];
  await writeFile(
    path.join(evidence, 'source-proof.json'),
    JSON.stringify(
      {
        load: os.loadavg(),
        cpus: os.cpus().length,
        files: await Promise.all(
          sourceFiles.map(async (file) => ({
            file,
            sha256: createHash('sha256')
              .update(await readFile(path.join(web, file)))
              .digest('hex'),
          })),
        ),
      },
      null,
      2,
    ),
  );
  const previous = process.cwd(),
    previousNodeEnv = process.env.NODE_ENV;
  process.chdir(web);
  process.env.NODE_ENV = 'production';
  try {
    const built = await build({
      root: web,
      configFile: false,
      logLevel: 'error',
      esbuild: { jsx: 'automatic', jsxDev: false },
      resolve: {
        alias: [
          { find: 'next/navigation', replacement: path.join(web, 'test/browser/fixtures/f322-shell-navigation.ts') },
          { find: '@', replacement: path.join(web, 'src') },
        ],
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
        'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin),
      },
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: path.join(web, 'test/browser/fixtures/sidebar-click-latency.tsx'),
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    const output = Array.isArray(built) ? built.flatMap((x) => x.output) : built.output;
    script = output.find((x) => x.type === 'chunk' && x.isEntry).code;
    css = output
      .filter((x) => x.type === 'asset' && x.fileName.endsWith('.css'))
      .map((x) => x.source)
      .join('\n');
  } finally {
    process.chdir(previous);
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await page.context().newCDPSession(page);
  try {
    for (const tab of ['pinned', 'project']) {
      for (const kind of ['ordinary', 'peek']) {
        tabMode = tab;
        // Bootstrap outside the reading surface: a prior case's pointer must not
        // freeze the pre-Group list and append newly loaded Groups offscreen.
        await page.mouse.move(1100, 700);
        await page.goto(`${origin}/thread/row-0?tab=${tab}`);
        await page.waitForLoadState('networkidle');
        if (errors.length) throw new Error(errors.join('\n'));
        await page.waitForFunction(() => window.__sidebarClick.state().rows === 2346);
        const id = kind === 'ordinary' ? 'row-1' : 'row-3';
        await page.evaluate(() => {
          const c = document.querySelector('aside .overflow-y-auto');
          if (c) c.scrollTop = 0;
        });
        const selector =
          kind === 'ordinary'
            ? `[data-thread-id="${id}"]`
            : `[data-testid="collapsed-group-peek"] [data-thread-id="${id}"]`;
        const target = page.locator(selector);

        try {
          await target.first().waitFor({ state: 'attached', timeout: 3000 });
        } catch (error) {
          const dom = await page.evaluate(() => ({
            rows: [...document.querySelectorAll('[data-thread-id]')]
              .slice(0, 35)
              .map((el) => el.getAttribute('data-thread-id')),
            groups: [...document.querySelectorAll('[data-attention-cluster]')].slice(0, 6).map((el) => ({
              anchor: el.getAttribute('data-attention-cluster'),
              expanded: el.getAttribute('data-expanded'),
              text: el.textContent,
            })),
            scrolls: [...document.querySelectorAll('aside *')]
              .filter((el) => el.scrollHeight > el.clientHeight + 10 && getComputedStyle(el).overflowY === 'auto')
              .map((el) => ({ top: el.scrollTop, height: el.clientHeight, all: el.scrollHeight })),
            state: window.__sidebarClick.state(),
          }));
          await writeFile(path.join(evidence, `${tab}-${kind}.missing.json`), JSON.stringify(dom, null, 2));
          await page.screenshot({ path: path.join(evidence, `${tab}-${kind}.missing.png`) });
          measurements.push({ tab, kind, fixtureError: String(error), dom });
          continue;
        }
        await target.first().scrollIntoViewIfNeeded();
        await page.mouse.move(1100, 700);
        await target.first().hover();
        await page.waitForTimeout(100);
        const domRows = await page.locator('[data-thread-id]').count();
        const actualSelector = await target.first().evaluate((el) => {
          el.setAttribute('data-click-probe', 'target');
          return '[data-click-probe="target"]';
        });
        const trace = [];
        cdp.on('Tracing.dataCollected', ({ value }) => trace.push(...value));
        await cdp.send('Tracing.start', {
          categories:
            'devtools.timeline,blink.user_timing,v8,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler,disabled-by-default-v8.cpu_profiler.hires',
          options: 'sampling-frequency=1000',
        });
        await page.evaluate(
          ({ selector, id }) => {
            const el = document.querySelector(selector);
            window.__clickResult = null;
            el.addEventListener(
              'click',
              (event) => {
                const started = event.timeStamp,
                  inputDelayMs = performance.now() - event.timeStamp;
                performance.mark('sidebar-click');
                const check = () => {
                  const state = window.__sidebarClick.state();
                  const row = document.querySelector(
                    `[data-thread-id="${id}"][aria-current="page"], [data-peek-thread-id="${id}"][aria-current="page"]`,
                  );
                  const clicked = document.querySelector('[data-click-probe="target"]');
                  const unreadCleared =
                    !clicked ||
                    !clicked.querySelector('[data-testid="thread-row-unread"], [data-testid="group-peek-unread"]');
                  if (
                    state.current === id &&
                    unreadCleared &&
                    (row || (selector.includes('data-click-probe') && !clicked))
                  )
                    requestAnimationFrame(() => {
                      window.__clickResult = {
                        latencyMs: performance.now() - started,
                        inputDelayMs,
                        current: state.current,
                        selectedVisible: !!row,
                        unreadCleared,
                      };
                      performance.mark('sidebar-painted');
                    });
                  else if (performance.now() - started > 10000)
                    window.__clickResult = {
                      latencyMs: performance.now() - started,
                      inputDelayMs,
                      current: state.current,
                      unreadCleared,
                      selectedVisible: !!row,
                      timedOut: true,
                    };
                  else requestAnimationFrame(check);
                };
                requestAnimationFrame(check);
              },
              { once: true, capture: true },
            );
          },
          { selector: actualSelector, id },
        );
        await target.first().click();
        await page.waitForFunction(() => window.__clickResult !== null);
        const result = await page.evaluate(() => window.__clickResult);
        const ended = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
        await cdp.send('Tracing.end');
        await ended;
        cdp.removeAllListeners('Tracing.dataCollected');
        const name = `${tab}-${kind}`;
        await writeFile(path.join(evidence, `${name}.trace.json.gz`), gzipSync(JSON.stringify({ traceEvents: trace })));
        await page.screenshot({ path: path.join(evidence, `${name}.png`) });
        const tasks = trace
          .filter((e) => e.name === 'RunTask' && e.ph === 'X' && e.dur >= 50000)
          .map((e) => ({ durationMs: e.dur / 1000, ts: e.ts, tid: e.tid }));
        measurements.push({ tab, kind, domRows, ...result, longTasks: tasks });
        console.log(JSON.stringify(measurements.at(-1)));
      }
    }
  } finally {
    await writeFile(
      path.join(evidence, 'measurements.json'),
      JSON.stringify(
        {
          origin,
          cwd: web,
          rows: rows.length,
          groups: groups.length,
          browser: browser.version(),
          scope:
            'Actual production sidebar/stores/CSS; private transport and small route host; chat body excluded; no CPU throttling',
          measurements,
          errors,
          calls,
        },
        null,
        2,
      ),
    );
  }
  assert.deepEqual(errors, []);
  for (const m of measurements)
    assert.ok(
      !m.fixtureError && m.latencyMs <= 200 && !m.timedOut,
      `${m.tab}/${m.kind}: click-to-cleared-unread paint ${m.latencyMs?.toFixed(1)}ms exceeds 200ms`,
    );
});
