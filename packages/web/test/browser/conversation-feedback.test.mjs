import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { buildChatProof, origin } from './fixtures/f322-chat-real-page-build.mjs';

const evidence = path.resolve(process.env.FEEDBACK_EVIDENCE_DIR ?? '../../artifacts/conversation-feedback/browser');
const uncertainError = 'Publication outcome uncertain. Retry to look for the original issue without creating another.';
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
for (const entry of ['local', 'agent', 'connector']) {
  for (const scenario of entry === 'connector'
    ? ['ready']
    : ['ready', 'ready-mobile', 'offline', 'empty', 'uncertain', 'conflict']) {
    test(
      `${entry}/${scenario}: real chat draft, confirmation, receipt and safe fallback`,
      { timeout: 30000 },
      async (t) => {
        const context = await browser.newContext({
          deviceScaleFactor: 2,
          viewport: { width: scenario === 'offline' || scenario === 'ready-mobile' ? 375 : 1280, height: 900 },
        });
        t.after(() => context.close());
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const calls = [];
        let draft =
          entry === 'connector'
            ? {
                draftId: 'retained-draft',
                title: '工具执行失败',
                bodyMarkdown: '有可复现的失败步骤。',
                targetRepo: 'fixture/repo',
                labels: ['bug'],
                status: 'draft',
              }
            : undefined;
        const widths = [];
        const capture = async (stage) => {
          await page.evaluate(() => document.fonts.ready);
          const box = await page.getByTestId('community-issue-card').boundingBox();
          assert(box);
          widths.push({ stage, width: box.width });
          await page.screenshot({ path: path.join(evidence, `${entry}-${scenario}-${stage}.png`), fullPage: true });
        };
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
            const submitted = request.postDataJSON();
            draft = { ...draft, title: submitted.title, bodyMarkdown: submitted.bodyMarkdown };
            if (!issuePosts) issuePosts++;
            if (scenario === 'uncertain' && !published) {
              published = true;
              draft = { ...draft, status: 'publishing' };
              return json({ draft, error: uncertainError }, 409);
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
            if (scenario === 'conflict') return json({ error: 'draft requestId already has different content' }, 409);
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
        const url = `${origin}/?entry=${entry}&theme=${scenario === 'offline' || scenario === 'ready-mobile' ? 'dark' : 'light'}`;
        const open = async () => {
          await page.goto(url);
          if (entry === 'local') {
            await page.getByRole('button', { name: /已记录/ }).waitFor();
            await page.screenshot({ path: path.join(evidence, `${entry}-${scenario}-entry.png`), fullPage: true });
            await page.getByRole('button', { name: /已记录/ }).click();
          }
          if (entry === 'connector')
            await page
              .getByRole('button', { name: '发布到 GitHub', exact: true })
              .or(page.getByRole('link', { name: /#7/ }))
              .waitFor();
          else await page.getByRole('region', { name: '公开报告', exact: true }).waitFor();
        };
        await open();
        if (entry !== 'connector')
          await page
            .getByRole('region', { name: '公开报告', exact: true })
            .getByText('有可复现的失败步骤。', { exact: true })
            .waitFor();
        await capture('review');
        assert.equal(creates, 0);
        assert.equal(issuePosts, 0);
        if (scenario === 'offline' || scenario === 'empty') {
          assert.equal(await page.getByRole('button', { name: '核对并继续', exact: true }).count(), 0);
          assert.match(await page.locator('main').innerText(), /公开反馈报告/);
          assert.equal(await page.getByRole('button', { name: '复制报告' }).isEnabled(), true);
          assert.equal(await page.getByRole('link', { name: '打开 GitHub 手动提交' }).count(), 0);
        } else if (scenario === 'conflict') {
          await page.getByRole('button', { name: '核对并继续', exact: true }).click();
          await page.getByRole('alert').filter({ hasText: '请恢复创建时的仓库与报告内容' }).waitFor();
          assert.equal(creates, 0);
          assert.equal(issuePosts, 0);
          assert.equal(await page.getByRole('button', { name: '发布到 GitHub', exact: true }).count(), 0);
        } else {
          if (entry !== 'connector') {
            assert.equal(
              await page.getByRole('link', { name: '打开 GitHub 手动提交' }).getAttribute('href'),
              'https://github.com/fixture/repo/issues/new',
            );
            await page.getByRole('button', { name: '核对并继续', exact: true }).click();
          }
          await page.getByRole('button', { name: '发布到 GitHub', exact: true }).waitFor();
          assert.equal(creates, entry === 'connector' ? 0 : 1);
          assert.equal(issuePosts, 0);
          await capture('editing');
          await page.getByLabel('报告标题', { exact: true }).fill('工具执行失败（合成复现）');
          await page
            .getByLabel('公开报告', { exact: true })
            .fill(
              '合成复现：运行示例工具后出现失败反馈卡。\n预期：审阅和修改后，由人明确发布。\n此为隔离截图，不含真实日志或用户信息。',
            );
          await capture('edited-confirmation');
          await page.getByRole('button', { name: '发布到 GitHub', exact: true }).click();
          if (scenario === 'uncertain') {
            await page
              .getByText('暂未确认 GitHub 是否已创建，请用同一份草稿核对结果；不会重复提单。', { exact: true })
              .waitFor();
            assert.equal(await page.getByLabel('公开报告', { exact: true }).isDisabled(), true);
            await capture('uncertain');
            await page.getByRole('button', { name: '重新核对结果', exact: true }).click();
          }
          await page.getByRole('link', { name: /#7/ }).waitFor();
          assert.equal(issuePosts, 1);
          await capture('published-simulated');
          assert(
            widths.every(({ width }) => Math.abs(width - widths[0].width) < 1),
            JSON.stringify(widths),
          );
          await page.getByText('查看报告', { exact: true }).click();
          await page.getByRole('region', { name: '公开报告', exact: true }).waitFor();
          assert.match(await page.getByRole('region', { name: '公开报告', exact: true }).innerText(), /由人明确发布/);
          await capture('published-report');
          await open();
          assert.doesNotMatch(await page.locator('main').innerText(), /尚未提交/);
          if (entry !== 'connector') await page.getByRole('button', { name: '核对并继续', exact: true }).click();
          await page.getByRole('link', { name: /#7/ }).waitFor();
          assert.equal(creates, entry === 'connector' ? 0 : 1);
          assert.equal(issuePosts, 1);
        }
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await page.screenshot({ path: path.join(evidence, `${entry}-${scenario}.png`), fullPage: true });
        writeFileSync(
          path.join(evidence, `${entry}-${scenario}.json`),
          JSON.stringify({ entry, scenario, creates, issuePosts, calls, errors, widths }, null, 2),
        );
      },
    );
  }
}
