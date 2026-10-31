import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'https://f322-session-import.test';
const originalCwd = process.cwd();
let browser, script, css;
before(async () => {
  process.chdir(webRoot);
  const result = await build({
    root: webRoot,
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    resolve: {
      alias: [
        {
          find: '@/hooks/useCatData',
          replacement: path.join(webRoot, 'test/browser/fixtures/f322-session-import-members.ts'),
        },
        { find: '@', replacement: path.join(webRoot, 'src') },
      ],
    },
    define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(webRoot, 'test/browser/fixtures/f322-session-import-layout.tsx'),
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  });
  const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
  script = outputs.find((item) => item.type === 'chunk' && item.isEntry).code;
  css = outputs
    .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) => item.source)
    .join('\n');
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  process.chdir(originalCwd);
});

for (const language of ['zh', 'en'])
  for (const width of [390, 1440]) {
    test(`recent-list selection keeps the complete import action and pin visible (${language}, ${width})`, async () => {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } });
      let listReads = 0,
        checks = 0;
      try {
        await page.addInitScript((lang) => localStorage.setItem('cat-cafe:shell-language', lang), language);
        await page.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: script });
          if (url.pathname === '/proof.css') return route.fulfill({ contentType: 'text/css', body: css });
          if (url.pathname === '/api/session') return route.fulfill({ json: { userId: 'layout-fixture' } });
          if (url.pathname === '/api/local-sessions/codex') {
            listReads++;
            return route.fulfill({
              json: {
                limited: true,
                sessions: Array.from({ length: 20 }, (_, index) => ({
                  sessionId: `019aaaaa-1111-7111-8111-${String(index + 1).padStart(12, '0')}`,
                  projectPath: '/home/user/projects/a-long-project-name/feature-worktree',
                  firstPrompt: index === 0 ? 'Resume the recent native task' : `Another indexed task ${index}`,
                  lastActivityAt: Date.now() - (url.pathname === '/api/local-sessions/codex' ? 7_200_000 : 3_600_000),
                  turnCount: null,
                  alreadyBound: false,
                })),
              },
            });
          }
          if (url.pathname.startsWith('/api/local-sessions/')) {
            checks++;
            return route.fulfill({
              json: {
                session: {
                  sessionId: '019aaaaa-1111-7111-8111-000000000001',
                  clientId: 'openai',
                  projectPath: '/home/user/projects/a-long-project-name/feature-worktree',
                  firstPrompt:
                    'Continue the original task, retaining the history, the project and the chosen member. '.repeat(4),
                  lastActivityAt: Date.now() - (url.pathname === '/api/local-sessions/codex' ? 7_200_000 : 3_600_000),
                },
              },
            });
          }
          if (url.pathname === '/')
            return route.fulfill({
              contentType: 'text/html',
              body: '<!doctype html><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
            });
          return route.fulfill({ status: 404, body: '' });
        });
        await page.goto(origin);
        assert.equal(listReads, 0, 'closed panel must not read native indexes');
        await page
          .getByRole('button', {
            name: language === 'zh' ? '接上本机已有的会话' : 'Connect an existing local session',
            exact: true,
          })
          .click();
        const dialog = page.getByRole('dialog');
        await page.getByText('Resume the recent native task', { exact: true }).waitFor();
        const initialPanel = await dialog.boundingBox();
        if (width === 390)
          assert.ok(initialPanel.y <= 1 && initialPanel.height >= 843, 'mobile uses the whole viewport');
        const visibleRows = await dialog.locator('li').evaluateAll(
          (rows) =>
            rows.filter((row) => {
              const box = row.getBoundingClientRect();
              let top = 0,
                bottom = window.innerHeight;
              for (let node = row.parentElement; node; node = node.parentElement) {
                if (['auto', 'scroll', 'hidden'].includes(getComputedStyle(node).overflowY)) {
                  const clip = node.getBoundingClientRect();
                  top = Math.max(top, clip.top);
                  bottom = Math.min(bottom, clip.bottom);
                }
              }
              return box.top >= top && box.bottom <= bottom;
            }).length,
        );
        assert.ok(visibleRows >= 3, `at least three complete session rows are visible: ${visibleRows}`);
        assert.equal(
          await dialog
            .getByRole('textbox', { name: language === 'zh' ? '会话 ID' : 'Session ID', exact: true })
            .count(),
          0,
        );
        const firstRow = dialog.locator('li').first();
        await firstRow.getByText('feature-worktree', { exact: false }).click();
        const action = dialog.getByRole('button', {
          name: language === 'zh' ? '接上并打开' : 'Connect and open',
          exact: true,
        });
        await page.waitForFunction(
          (label) =>
            [...document.querySelectorAll('button')].some(
              (button) => button.textContent.trim() === label && !button.disabled,
            ),
          language === 'zh' ? '接上并打开' : 'Connect and open',
        );
        assert.equal(listReads, 1);
        assert.equal(checks, 1, 'selection still runs exact admission preflight');
        const radio = dialog.getByRole('radio', { name: 'Resume the recent native task', exact: true });
        assert.equal(await radio.isChecked(), true);
        const summary = dialog.getByRole('status', {
          name: language === 'zh' ? '核对结果' : 'Check result',
          exact: true,
        });
        assert.ok((await summary.innerText()).includes('小太阳'), 'summary names the selected cat');
        assert.ok((await firstRow.innerText()).includes(language === 'zh' ? '1小时前' : '1 hour ago'));
        assert.ok((await summary.innerText()).includes(language === 'zh' ? '1小时前' : '1 hour ago'));
        const scrollers = await dialog.evaluate(
          (el) =>
            [...el.querySelectorAll('*')].filter(
              (node) =>
                ['auto', 'scroll'].includes(getComputedStyle(node).overflowY) &&
                node.scrollHeight > node.clientHeight + 4,
            ).length,
        );
        assert.equal(scrollers, 1, 'only the panel body scrolls');
        const panel = await dialog.boundingBox();
        const button = await action.boundingBox();
        const pin = await dialog
          .getByRole('checkbox', { name: language === 'zh' ? '建好后置顶' : 'Pin after creating', exact: true })
          .boundingBox();
        for (const [name, box] of [
          ['action', button],
          ['pin', pin],
          ['summary', await summary.boundingBox()],
        ]) {
          assert.ok(box && panel, `${name} must render`);
          assert.ok(
            box.y >= panel.y && box.y + box.height <= panel.y + panel.height,
            `${name} must be completely visible: ${JSON.stringify({ box, panel })}`,
          );
        }
        const summaryBefore = await summary.boundingBox();
        await dialog.evaluate((el) => {
          const scroller = [...el.querySelectorAll('*')].find(
            (node) =>
              ['auto', 'scroll'].includes(getComputedStyle(node).overflowY) &&
              node.scrollHeight > node.clientHeight + 4,
          );
          scroller.scrollTop = scroller.scrollHeight;
        });
        assert.equal(
          (await summary.boundingBox()).y,
          summaryBefore.y,
          'the result stays visible while the list scrolls',
        );
        if (width === 390) {
          const name = dialog.getByRole('textbox', {
            name: language === 'zh' ? '对话名（可不填）' : 'Conversation name (optional)',
            exact: true,
          });
          await name.fill('Keep this draft while the keyboard opens');
          await page.evaluate(() => {
            Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 400 });
            window.visualViewport.dispatchEvent(new Event('resize'));
          });
          await page.waitForFunction(
            () => document.querySelector('[role="dialog"]')?.getBoundingClientRect().height === 400,
          );
          assert.equal(await name.inputValue(), 'Keep this draft while the keyboard opens');
          const keyboardAction = await action.boundingBox();
          assert.ok(keyboardAction.y + keyboardAction.height <= 400, 'actions remain in the visible viewport');
          await page.evaluate(() => {
            delete window.visualViewport.height;
            window.visualViewport.dispatchEvent(new Event('resize'));
          });
          await page.waitForFunction(
            () => document.querySelector('[role="dialog"]')?.getBoundingClientRect().height === 844,
          );
        }
        await dialog.getByRole('checkbox').check();
        await action.click();
      } finally {
        await page.close();
      }
    });
  }
