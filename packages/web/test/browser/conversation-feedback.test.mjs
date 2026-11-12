import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { buildChatProof, origin } from './fixtures/f322-chat-real-page-build.mjs';

const evidence = path.resolve(process.env.FEEDBACK_EVIDENCE_DIR ?? '../../artifacts/conversation-feedback/browser');
let browser;
let built;
before(
  async () => {
    mkdirSync(evidence, { recursive: true });
    built = await buildChatProof('conversation-feedback.tsx');
    browser = await chromium.launch({ headless: true });
  },
  { timeout: 120000 },
);
after(async () => browser?.close());
for (const entry of ['local', 'agent']) {
  for (const scenario of ['ready', 'offline', 'empty', 'uncertain']) {
    test(
      `${entry}/${scenario}: real chat draft, confirmation, receipt and safe fallback`,
      { timeout: 30000 },
      async (t) => {
        const context = await browser.newContext({
          viewport: { width: scenario === 'offline' ? 375 : 1280, height: 900 },
        });
        t.after(() => context.close());
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const calls = [];
        let draft;
        let creates = 0;
        let issuePosts = 0;
        let published = false;
        await page.route('**/*', (route) =>
          route.request().url().startsWith(origin) ? route.fallback() : route.abort(),
        );
        await page.route(`${origin}/**`, async (route) => {
          const request = route.request();
          const pathname = new URL(request.url()).pathname;
          const json = (value, status = 200) =>
            route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
          if (pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: built.script });
          if (pathname === '/proof.css') return route.fulfill({ contentType: 'text/css', body: built.css });
          if (!pathname.startsWith('/api/'))
            return route.fulfill({
              contentType: 'text/html',
              body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
            });
          calls.push({ pathname, method: request.method() });
          if (pathname === '/api/session') return json({ userId: 'fixture', csrfToken: 'fixture' });
          if (pathname.endsWith('/status')) return json({ issue: { status: 'confirmed', signalType: 'cli_error' } });
          if (pathname.endsWith('/report-preview'))
            return json({ title: '工具执行失败', bodyMarkdown: '有可复现的失败步骤。' });
          if (pathname.endsWith('/config'))
            return scenario === 'offline'
              ? json({ error: 'unavailable' }, 503)
              : json({
                  defaultRepo: scenario === 'empty' ? '' : 'fixture/repo',
                  repos: scenario === 'empty' ? [] : ['fixture/repo'],
                });
          if (pathname.endsWith('/publish')) {
            if (!issuePosts) issuePosts++;
            if (scenario === 'uncertain' && !published) {
              published = true;
              return json({ error: '结果未知，请使用同一草稿核验' }, 409);
            }
            draft = {
              ...draft,
              status: 'published',
              githubIssueNumber: 7,
              githubIssueUrl: 'https://github.com/fixture/repo/issues/7',
            };
            return json({ draft });
          }
          if (pathname.endsWith('/cancel')) {
            draft = { ...draft, status: 'cancelled' };
            return json({ draft });
          }
          if (pathname.includes('/by-id/')) return json({ draft });
          if (pathname.endsWith('/community-issue-drafts') && request.method() === 'POST') {
            const body = request.postDataJSON();
            if (entry === 'agent') {
              assert.equal(body.sourceType, 'cat_initiated');
              assert.equal(body.sourceId, 'issue-proposal');
              assert.equal(body.messageId, 'original-message');
              assert.equal(body.threadId, 'original-message');
              assert.deepEqual(body.labels, ['bug']);
            } else assert.equal(body.requestId, 'feedback:fi-proof');
            if (!draft) {
              creates++;
              draft = {
                draftId: 'retained-draft',
                title: body.title,
                bodyMarkdown: body.bodyMarkdown,
                targetRepo: body.repo ?? body.targetRepo,
                labels: body.labels ?? [],
                status: 'draft',
              };
            }
            return json({ draft, data: { id: draft.draftId } });
          }
          return json({});
        });
        const url = `${origin}/?entry=${entry}&theme=${scenario === 'offline' ? 'dark' : 'light'}`;
        const open = async () => {
          await page.goto(url);
          if (entry === 'local') await page.getByRole('button', { name: /已记录/ }).click();
          await page.getByLabel('公开报告', { exact: true }).waitFor();
        };
        await open();
        await page.waitForFunction(() => document.querySelector('textarea')?.value.length > 0);
        assert.equal(creates, 0);
        assert.equal(issuePosts, 0);
        if (scenario === 'offline' || scenario === 'empty') {
          assert.equal(await page.getByRole('button', { name: '预览并提交', exact: true }).count(), 0);
          assert.match(await page.locator('main').innerText(), /尚未提交/);
          assert.equal(await page.getByRole('button', { name: '复制报告' }).isEnabled(), true);
          if (entry === 'local' && scenario === 'empty')
            assert.equal(await page.getByRole('link', { name: '打开 GitHub 手动提交' }).count(), 0);
          if (entry === 'agent')
            assert.equal(
              await page.getByRole('link', { name: '打开 GitHub 手动提交' }).getAttribute('href'),
              'https://github.com/fixture/repo/issues/new',
            );
        } else {
          await page.getByRole('button', { name: '预览并提交', exact: true }).click();
          await page.getByRole('button', { name: 'Submit to GitHub', exact: true }).waitFor();
          assert.equal(creates, 1);
          assert.equal(issuePosts, 0);
          await page.getByRole('button', { name: 'Submit to GitHub', exact: true }).click();
          if (scenario === 'uncertain') {
            await page.getByText('结果未知，请使用同一草稿核验', { exact: true }).waitFor();
            await page.getByRole('button', { name: 'Submit to GitHub', exact: true }).click();
          }
          await page.getByRole('link', { name: /#7/ }).waitFor();
          assert.equal(issuePosts, 1);
          await open();
          await page.getByRole('button', { name: '预览并提交', exact: true }).click();
          await page.getByRole('link', { name: /#7/ }).waitFor();
          assert.equal(creates, 1);
          assert.equal(issuePosts, 1);
        }
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await page.screenshot({ path: path.join(evidence, `${entry}-${scenario}.png`), fullPage: true });
        writeFileSync(
          path.join(evidence, `${entry}-${scenario}.json`),
          JSON.stringify({ entry, scenario, creates, issuePosts, calls, errors }, null, 2),
        );
      },
    );
  }
}
