import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorksFixture, createWorksFixture } from './fixtures/issue1864-browser-fixture.mjs';

const out = process.env.ISSUE1864_EVIDENCE_DIR ?? (await mkdtemp(path.join(tmpdir(), 'issue1864-visible-')));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const web = path.join(repo, 'packages/web');
const api = path.join(repo, 'packages/api');
const reqWeb = createRequire(path.join(web, 'package.json'));
const { chromium } = reqWeb('playwright');
await mkdir(out, { recursive: true });
const { script, css } = await buildWorksFixture(web, out);
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--no-proxy-server'] });
const evidence = {
  base: '3569a9b6422723faf3a586b68232c140f84b44a1',
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  pid: process.pid,
  scenarios: {},
};
let app;
try {
  for (const scenario of ['works', 'sparse', 'home', 'home-empty', 'home-error', 'task-pr']) {
    const gets = [],
      steps = [],
      errors = [];
    const requests = new Map();
    const fixture = await createWorksFixture(api, scenario, script, css);
    app = fixture.app;
    const { append, origin, routes, control, mutateTask } = fixture;
    evidence.scenarios[scenario] = { origin, routes, gets, steps, errors };
    const context = await browser.newContext({ viewport: { width: 1250, height: 820 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/artifacts') {
        const item = { url: request.url(), cancelled: false };
        requests.set(request, item);
        gets.push(item);
      }
    });
    page.on('requestfailed', (request) => {
      const item = requests.get(request);
      if (item) {
        item.cancelled = true;
        item.error = request.failure()?.errorText;
      }
    });
    const count = () => gets.filter((item) => item.url.includes('read=pages')).length;
    const recentCount = () => gets.filter((item) => item.url.includes('recent-works')).length;
    const panel = page.getByTestId('v2-works-panel');
    const recent = page.getByTestId('recent-works');
    const record = async (label) => {
      steps.push({
        label,
        pages: count(),
        recent: recentCount(),
        cards: await panel.locator('[data-work-anchor]').count(),
        preview: await recent.getByTestId('recent-work-card').count(),
        counter: await panel.locator('.v2-works-count').textContent(),
        routeCounts: {
          started: routes.length,
          completed: routes.filter((item) => item.completed).length,
          cancelled: routes.filter((item) => item.cancelled).length,
        },
      });
      console.log(scenario, JSON.stringify(steps.at(-1)));
    };
    const wait = async (condition) => {
      for (let i = 0; i < 300 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(condition(), JSON.stringify({ routes: routes.slice(-2), errors }));
    };
    const expandLoaded = async () => {
      const before = count();
      await panel.locator('.v2-works-scroll').evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await page.waitForFunction(() => {
        const scroll = document.querySelector('.v2-works-scroll');
        if (!scroll) return false;
        scroll.scrollTop = scroll.scrollHeight;
        return ![...scroll.querySelectorAll('button')].some((button) => button.textContent === '展开更多已读作品');
      });
      assert.equal(count(), before, 'expanding loaded cards must not read another server page');
    };
    await page.goto(`${origin}/?mode=${scenario.startsWith('home') ? 'home' : 'works'}`);
    if (scenario.startsWith('home')) {
      await recent.waitFor();
      await wait(
        () => recentCount() === 1 && routes.some((item) => item.url.includes('recent-works') && item.completed),
      );
      assert.equal(recentCount(), 1);
      assert.equal(count(), 0);
      await recent.getByRole('button', { name: '打开作品目录', exact: true }).click();
      await panel.waitFor();
      await wait(() => routes.some((item) => item.url.includes('read=pages') && item.completed));
      await panel.getByRole('button', { name: '所有对话', exact: true }).filter({ has: undefined }).waitFor();
      assert.equal(
        await panel.getByRole('button', { name: '所有对话', exact: true }).getAttribute('aria-pressed'),
        'true',
      );
      assert.equal(count(), 1, JSON.stringify({ routes, gets }));
      await panel
        .locator('.v2-works-count')
        .filter({ hasText: scenario === 'home-empty' ? '共 0 件' : '已加载 128 件' })
        .waitFor();
      await record('bottom opens existing global catalogue');
      await recent.getByRole('button', { name: '全部作品', exact: true }).click();
      await page.waitForTimeout(150);
      assert.equal(count(), 1);
      await record('top reopens same catalogue without another reader');
      assert.equal(await recent.getByTestId('recent-work-card').count(), scenario === 'home' ? 12 : 0);
      if (scenario === 'home') {
        await page.evaluate(() => {
          window.probe.plain();
          window.probe.invalidate();
        });
        await page.waitForTimeout(100);
        assert.equal(recentCount(), 1);
        assert.equal(count(), 1);
        append(500);
        await page.evaluate(() => {
          window.probe.material();
          window.dispatchEvent(
            new CustomEvent('cat-cafe:entrusted-work-projection-invalidated', {
              detail: { reason: 'works_changed' },
            }),
          );
        });
        await wait(() => recentCount() === 2 && routes.at(-1).completed);
        await recent.getByText('Proof-500.pdf', { exact: true }).waitFor();
        assert.equal(count(), 1);
        await record('one publication coalesces recent refresh; global cursor is retained');
      }
    } else if (scenario === 'task-pr') {
      await panel.locator('.v2-works-count').filter({ hasText: '共 0 件' }).waitFor();
      await record('complete empty catalogue before real Task mutation');
      const relay = (events) =>
        page.evaluate((payloads) => {
          payloads.forEach((detail) =>
            window.dispatchEvent(new CustomEvent('cat-cafe:entrusted-work-projection-invalidated', { detail })),
          );
        }, events);
      const activity = await mutateTask({ status: 'doing' });
      await relay(activity);
      await page.waitForTimeout(100);
      assert.equal(count(), 1);
      assert.equal(await panel.getByText('目录可能有更新', { exact: true }).count(), 0);
      const publication = await mutateTask({ artifactRefs: ['https://github.com/example/project/pull/12'] });
      evidence.taskPublication = { activity, publication };
      await relay(publication);
      await panel.getByText('目录可能有更新', { exact: true }).waitFor();
      assert.equal(count(), 1, 'a real Task publication marks stale without an automatic read');
      await record('real Task artifact producer marks the complete catalogue stale');
      await panel.getByRole('button', { name: '刷新目录', exact: true }).click();
      await panel.locator('.v2-works-count').filter({ hasText: '共 1 件' }).waitFor();
      assert.equal(count(), 2);
      assert.equal(await panel.locator('[data-work-anchor]').count(), 1);
      await record('explicit refresh reads the real Task PR work');
    } else {
      await panel.waitFor();
      await wait(() => routes.length === 1 && routes[0].completed);
      await panel
        .locator('.v2-works-count')
        .filter({ hasText: scenario === 'sparse' ? '已加载 0 件' : '已加载 128 件' })
        .waitFor();
      await record('initial single page');
      assert.equal(count(), 1);
      if (scenario === 'works') {
        assert.ok((await panel.locator('[data-work-anchor]').count()) < 128);
        assert.equal(await panel.getByRole('button', { name: '继续读取', exact: true }).count(), 0);
        assert.equal(await panel.getByRole('button', { name: '展开更多已读作品', exact: true }).count(), 1);
      }
      await panel.locator('.v2-works-scroll').evaluate((node) => {
        node.scrollTop = 1800;
        node.dispatchEvent(new Event('scroll'));
      });
      await page.waitForTimeout(100);
      assert.equal(count(), 1);
      await record('scroll admits no GET');
      if (scenario === 'works') {
        await expandLoaded();
        assert.equal(await panel.locator('[data-work-anchor]').count(), 128);
        await record('scroll expands all loaded cards before server continuation');
        await panel.getByRole('textbox').fill('no-matching-work');
        await panel.getByText('已读结果中匹配 0 件', { exact: true }).waitFor();
        assert.equal(await panel.getByRole('button', { name: '继续读取', exact: true }).count(), 1);
      }
      await panel.getByRole('button', { name: '继续读取', exact: true }).click();
      await wait(() => routes.filter((item) => item.completed).length === (scenario === 'sparse' ? 5 : 3));
      await panel.getByRole('button', { name: '继续读取', exact: true }).waitFor();
      await record('first explicit batch');
      await page.screenshot({ path: path.join(out, `${scenario}-partial.png`) });
      assert.equal(count(), scenario === 'sparse' ? 5 : 3);
      if (scenario === 'works') {
        await panel.getByRole('textbox').fill('');
        await expandLoaded();
        await record('newly read cards expand locally before the next server batch');
      }
      assert.equal(await panel.getByRole('button', { name: '继续读取', exact: true }).count(), 1);
      await panel.getByRole('button', { name: '继续读取', exact: true }).click();
      await wait(() => routes.some((item) => item.complete));
      await panel
        .locator('.v2-works-count')
        .filter({ hasText: scenario === 'sparse' ? '共 16 件' : '共 272 件' })
        .waitFor();
      await record('second explicit batch reaches end');
      assert.equal(count(), scenario === 'sparse' ? 9 : 4);
      if (scenario === 'sparse') assert.equal(await panel.locator('[data-work-anchor]').count(), 16);
      else {
        await panel.getByRole('textbox').fill('');
        const before = count();
        await page.evaluate(() => {
          window.probe.plain();
          window.probe.invalidate();
        });
        await page.waitForTimeout(100);
        assert.equal(count(), before);
        append(500);
        await page.evaluate(() => window.probe.material());
        await panel.getByText('目录可能有更新', { exact: true }).waitFor();
        assert.equal(count(), before);
        await panel.getByRole('button', { name: '刷新目录', exact: true }).click();
        await wait(() => count() === before + 1 && routes.at(-1).completed);
        assert.equal(new URL(gets.at(-1).url).searchParams.has('cursor'), false);
        await panel.locator('.v2-works-count').filter({ hasText: '已加载 128 件' }).waitFor();
        await record('material marks stale; explicit refresh replaces first page');
        const oldCursor = routes.at(-1).cursor;
        control.failNext = 503;
        await panel.getByRole('button', { name: '继续读取', exact: true }).click();
        await panel.getByRole('button', { name: '重试', exact: true }).waitFor();
        await record('temporary continuation failure retains rows');
        assert.equal(new URL(gets.at(-1).url).searchParams.get('cursor'), oldCursor);
        control.holdNext = true;
        await panel.getByRole('button', { name: '重试', exact: true }).click();
        await wait(() => control.held);
        const retained = await panel.locator('.v2-works-count').textContent();
        const cursorBeforeHide = new URL(gets.at(-1).url).searchParams.get('cursor');
        await panel.getByRole('textbox').fill('Proof-39');
        await panel.locator('.v2-works-scroll').evaluate((node) => {
          node.scrollTop = 120;
        });
        const retainedView = await panel.evaluate((node) => ({
          query: node.querySelector('input').value,
          filter: node.querySelector('select').value,
          scrollTop: node.querySelector('.v2-works-scroll').scrollTop,
        }));
        await page.evaluate(() => window.probe.hide());
        await wait(() => gets.some((item) => item.cancelled));
        control.release();
        await page.waitForTimeout(100);
        const hiddenCount = count();
        await page.evaluate(() => window.probe.show());
        await panel.waitFor();
        await page.waitForTimeout(100);
        assert.equal(count(), hiddenCount);
        assert.equal(await panel.locator('.v2-works-count').textContent(), retained);
        assert.deepEqual(
          await panel.evaluate((node) => ({
            query: node.querySelector('input').value,
            filter: node.querySelector('select').value,
            scrollTop: node.querySelector('.v2-works-scroll').scrollTop,
          })),
          retainedView,
        );
        await record('hide cancels client; restore retains rows and cursor without GET');
        control.failNext = 403;
        await panel.getByRole('button', { name: '继续读取', exact: true }).click();
        await wait(() => routes.at(-1).status === 403);
        await panel.getByRole('button', { name: '重试', exact: true }).waitFor();
        assert.equal(new URL(gets.at(-1).url).searchParams.get('cursor'), cursorBeforeHide);
        assert.equal(await panel.locator('[data-work-anchor]').count(), 0);
        await record('403 clears untrusted snapshot');
        await panel.getByRole('button', { name: '重试', exact: true }).click();
        await wait(() => routes.at(-1).completed && routes.at(-1).status === 200);
        await page.evaluate(() => window.probe.revoke());
        assert.equal(await panel.locator('[data-work-anchor]').count(), 0);
        await record('unscoped explicit revocation clears snapshot');
      }
    }
    await page.screenshot({ path: path.join(out, `${scenario}.png`) });
    evidence.scenarios[scenario] = { origin, routes, gets, steps, errors };
    assert.deepEqual(errors, []);
    await context.close();
    await app.close();
    app = null;
    await writeFile(path.join(out, 'browser-green.json'), JSON.stringify(evidence, null, 2));
  }
} catch (error) {
  evidence.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([browser.close(), app?.close()]);
  await writeFile(path.join(out, 'browser-green.json'), JSON.stringify(evidence, null, 2));
}
