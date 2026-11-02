import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { buildChatProof, origin, webRoot } from './fixtures/f322-chat-real-page-build.mjs';

const evidence = process.env.THREAD_DELETE_EVIDENCE_DIR ?? path.join(tmpdir(), 'cat-cafe-evidence', 'issue-1778');
const root = mkdtempSync(path.join(tmpdir(), 'clowder-thread-delete-'));
const owner = 'thread-delete-browser-owner';
Object.assign(process.env, {
  CAT_CAFE_CONFIG_ROOT: root,
  CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
  CAT_CAFE_DATA_DIR: path.join(root, 'data'),
  AUDIT_LOG_DIR: path.join(root, 'audit'),
  CAT_CAFE_WORKSPACE_ROOT: path.resolve(webRoot, '../..'),
  CAT_CAFE_RUNTIME_ROOT: root,
  CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1',
  DEFAULT_OWNER_USER_ID: owner,
});
mkdirSync(evidence, { recursive: true });
let app, browser, built, threads, store, messages;
const requests = [],
  errors = [];

before(
  async () => {
    const [{ default: Fastify }, { ThreadStore }, { MessageStore }, { threadsRoutes }, { canonicalTestMessageInput }] =
      await Promise.all([
        import('../../../api/node_modules/fastify/fastify.js'),
        import('../../../api/src/domains/cats/services/stores/ports/ThreadStore.ts'),
        import('../../../api/src/domains/cats/services/stores/ports/MessageStore.ts'),
        import('../../../api/src/routes/threads.ts'),
        import('../../../api/test/helpers/message-from-fixtures.js'),
      ]);
    store = new ThreadStore();
    messages = new MessageStore();
    threads = ['问题反馈分析', '待清理测试对话', '正在执行的会话', '系统会话'].map((title) =>
      store.create(owner, title),
    );
    store.updateSystemKind(threads[3].id, 'eval_domain');
    messages.append(
      canonicalTestMessageInput({
        userId: owner,
        catId: null,
        content: '恢复后必须保留的历史内容',
        mentions: [],
        timestamp: Date.now(),
        threadId: threads[0].id,
      }),
    );
    app = Fastify();
    app.decorateRequest('sessionUserId', null);
    app.addHook('onRequest', async (request) => {
      request.sessionUserId = owner;
    });
    await app.register(threadsRoutes, {
      threadStore: store,
      messageStore: messages,
      invocationTracker: { guardDelete: (id) => ({ acquired: id !== threads[2].id, release() {} }) },
    });
    app.get('/api/session', async () => ({ userId: owner, csrfToken: 'fixture-only' }));
    app.get('/api/messages', async (request) => ({
      messages: messages.getByThread(request.query.threadId),
      hasMore: false,
    }));
    app.get('/api/cats', async () => ({ cats: [] }));
    app.get('/api/labels', async () => []);
    app.get('/api/config/co-creator', async () => ({
      name: '隔离验收用户',
      aliases: [],
      mentionPatterns: ['@fixture'],
    }));
    app.get('/*', async (request) => {
      if (request.url === '/api/governance/health') return { projects: [] };
      if (request.url === '/api/projects/cwd') return { path: root };
      return {};
    });
    await app.ready();
    built = await buildChatProof('thread-quick-delete.tsx');
    browser = await chromium.launch({ headless: true });
  },
  { timeout: 180_000 },
);

after(async () => {
  await browser?.close();
  await app?.close();
  writeFileSync(
    path.join(evidence, 'instance-ledger.json'),
    JSON.stringify(
      {
        issue: 1778,
        owner: 'Codex',
        sourceRoot: webRoot,
        fixtureDataRoot: root,
        nodePid: process.pid,
        listeners: [],
        productionRedis: false,
        modelsCalled: false,
        browserClosed: true,
        fixtureDataRetained: true,
        errors,
      },
      null,
      2,
    ),
  );
});

async function openPage(context, routePath = '/') {
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.origin, origin, `unexpected external request: ${url}`);
    if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: built.script });
    if (url.pathname === '/proof.css') return route.fulfill({ contentType: 'text/css', body: built.css });
    if (url.pathname.startsWith('/api/')) {
      requests.push({ method: request.method(), url: url.pathname + url.search });
      const response = await app.inject({
        method: request.method(),
        url: url.pathname + url.search,
        headers: request.headers(),
        ...(request.postData() ? { payload: request.postData() } : {}),
      });
      return route.fulfill({
        status: response.statusCode,
        headers: { 'content-type': 'application/json' },
        body: response.body,
      });
    }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
    });
  });
  await page.goto(origin + routePath);
  await page.getByTestId('thread-quick-delete').first().waitFor({ state: 'attached' });
  return page;
}

test(
  'production components remember deletion confirmation and restore preserved history through the production thread API',
  { timeout: 120_000 },
  async (t) => {
    const context = await browser.newContext({ viewport: { width: 1228, height: 900 } });
    await context.addInitScript(() => {
      localStorage.setItem('cat-cafe:shell-presentation', 'v2');
    });
    const page = await openPage(context, `/thread/${threads[0].id}`);
    t.after(async () => {
      if (page.isClosed()) return;
      await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
      writeFileSync(
        path.join(evidence, 'failure.json'),
        JSON.stringify({ url: page.url(), body: await page.locator('body').innerText(), requests, errors }, null, 2),
      );
    });
    const first = page.locator(`[data-thread-id="${threads[0].id}"]`);
    await first.hover();
    await page.waitForFunction((id) => {
      const row = document.querySelector(`[data-thread-id="${id}"]`);
      const more = row?.querySelector('[aria-label="更多操作"]');
      return more && getComputedStyle(more).opacity === '1';
    }, threads[0].id);
    await page.screenshot({ path: path.join(evidence, '00-quick-delete-row.png') });
    await first.getByTestId('thread-quick-delete').click();
    const dialog = page.getByRole('dialog', { name: '确认删除对话' });
    const remember = dialog.getByRole('checkbox', { name: '后续不再提醒（仅普通会话）' });
    assert.equal(await remember.isChecked(), false);
    await remember.check();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(requests.filter((request) => request.method === 'DELETE').length, 0);
    await first.getByTestId('thread-quick-delete').click();
    assert.equal(await remember.isChecked(), false);
    await remember.check();
    assert.notEqual(
      await dialog
        .getByRole('button', { name: '移入回收站', exact: true })
        .evaluate((button) => getComputedStyle(button).backgroundColor),
      'rgba(0, 0, 0, 0)',
    );
    await page.screenshot({ path: path.join(evidence, '01-confirm-and-remember.png') });
    await dialog.getByRole('button', { name: '移入回收站', exact: true }).click();
    await first.waitFor({ state: 'detached' });
    await page.waitForURL(origin + '/');
    assert.ok(store.get(threads[0].id).deletedAt);
    await page.reload();
    const second = page.locator(`[data-thread-id="${threads[1].id}"]`);
    await second.hover();
    await second.getByTestId('thread-quick-delete').click();
    await second.waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.ok(store.get(threads[1].id).deletedAt);
    const busy = page.locator(`[data-thread-id="${threads[2].id}"]`);
    await busy.hover();
    await busy.getByTestId('thread-quick-delete').click();
    await page.getByText('猫猫正在工作中，请等待当前任务完成后再删除对话。', { exact: true }).waitFor();
    assert.equal(Boolean(store.get(threads[2].id).deletedAt), false);
    await page.getByTestId('trash-bin-toggle').click();
    const trashItem = page
      .locator('[data-testid="trash-bin-toggle"]')
      .locator('..')
      .getByText(threads[0].title, { exact: true })
      .locator('..');
    await trashItem.getByRole('button', { name: '恢复', exact: true }).click();
    await first.waitFor();
    assert.equal(Boolean(store.get(threads[0].id).deletedAt), false);
    await first.getByRole('link', { name: threads[0].title, exact: true }).click();
    await page.getByTestId('restored-history').getByText('恢复后必须保留的历史内容', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, '02-restored-history.png') });
    await page.getByRole('button', { name: '个人设置', exact: true }).click();
    const preference = page.getByRole('switch', { name: '删除普通会话前确认', exact: true });
    await preference.waitFor();
    assert.equal(await preference.isChecked(), false);
    await preference.check();
    await page.screenshot({ path: path.join(evidence, '03-preference-restored.png') });
    await first.hover();
    await first.getByTestId('thread-quick-delete').click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    await page.evaluate(() => window.__threadDeleteTheme('dark'));
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await first.hover();
    await page.screenshot({ path: path.join(evidence, '04-dark-row.png') });
    await page.setViewportSize({ width: 390, height: 900 });
    await first.getByTestId('thread-quick-delete').click();
    await dialog.waitFor();
    await page.screenshot({ path: path.join(evidence, '05-narrow-confirm.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.keyboard.press('Escape');
    const storageState = await context.storageState();
    await context.close();
    const reopened = await browser.newContext({ storageState, viewport: { width: 1000, height: 800 } });
    const reloaded = await openPage(reopened);
    await reloaded.getByRole('button', { name: '个人设置', exact: true }).click();
    assert.equal(await reloaded.getByRole('switch', { name: '删除普通会话前确认', exact: true }).isChecked(), true);
    await reopened.close();
    assert.deepEqual(errors, []);
    writeFileSync(
      path.join(evidence, 'journey-result.json'),
      JSON.stringify(
        {
          result: 'PASS',
          productionThreadRoutes: true,
          productionSidebarAndSettings: true,
          windowsInstaller: 'NOT_RUN',
          requests,
          history: messages.getByThread(threads[0].id).map((message) => message.content),
        },
        null,
        2,
      ),
    );
  },
);
