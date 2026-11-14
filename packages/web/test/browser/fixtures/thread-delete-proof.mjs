import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { buildChatProof, origin, webRoot } from './f322-chat-real-page-build.mjs';

export async function createThreadDeleteProof(evidence) {
  const root = mkdtempSync(path.join(tmpdir(), 'clowder-thread-delete-'));
  const owner = 'thread-delete-browser-owner';
  let sessionOwner = owner;
  let deleteFailure;
  const delays = new Map();
  const requests = [],
    errors = [];
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
  const [{ default: Fastify }, { ThreadStore }, { MessageStore }, { threadsRoutes }, { canonicalTestMessageInput }] =
    await Promise.all([
      import('../../../../api/node_modules/fastify/fastify.js'),
      import('../../../../api/src/domains/cats/services/stores/ports/ThreadStore.ts'),
      import('../../../../api/src/domains/cats/services/stores/ports/MessageStore.ts'),
      import('../../../../api/src/routes/threads.ts'),
      import('../../../../api/test/helpers/message-from-fixtures.js'),
    ]);
  const store = new ThreadStore(),
    messages = new MessageStore();
  const threads = [
    '问题反馈分析',
    '待清理测试对话',
    '正在执行的会话',
    '系统会话',
    '连续清理测试',
    '回收站刷新测试',
  ].map((title) => store.create(owner, title));
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
  const app = Fastify();
  app.decorateRequest('sessionUserId', null);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = sessionOwner;
  });
  await app.register(threadsRoutes, {
    threadStore: store,
    messageStore: messages,
    invocationTracker: { guardDelete: (id) => ({ acquired: id !== threads[2].id, release() {} }) },
  });
  app.get('/api/session', async () => ({ userId: sessionOwner, csrfToken: 'fixture-only' }));
  app.get('/api/messages', async (request) => ({
    messages: messages.getByThread(request.query.threadId),
    hasMore: false,
  }));
  app.get('/api/cats', async () => ({ cats: [] }));
  app.get('/api/labels', async () => []);
  app.get('/api/config/co-creator', async () => ({ name: '隔离验收用户', aliases: [], mentionPatterns: ['@fixture'] }));
  app.get('/*', async (request) => {
    if (request.url === '/api/governance/health') return { projects: [] };
    if (request.url === '/api/projects/cwd') return { path: root };
    return {};
  });
  await app.ready();
  const built = await buildChatProof('thread-quick-delete.tsx');
  const browser = await chromium.launch({ headless: true });
  return {
    root,
    owner,
    threads,
    store,
    messages,
    browser,
    requests,
    errors,
    setSessionOwner(value) {
      sessionOwner = value;
    },
    delayResponse(url, delay) {
      delays.set(url, delay);
    },
    failNextDelete(status, nextOwner) {
      deleteFailure = { status, nextOwner };
    },
    async openPage(context, routePath = '/') {
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
          const resource = url.pathname + url.search;
          requests.push({ method: request.method(), url: resource, actor: sessionOwner });
          if (request.method() === 'DELETE' && deleteFailure) {
            const { status, nextOwner } = deleteFailure;
            deleteFailure = undefined;
            if (nextOwner) sessionOwner = nextOwner;
            return route.fulfill({ status, contentType: 'application/json', body: '{}' });
          }
          const response = await app.inject({
            method: request.method(),
            url: resource,
            headers: request.headers(),
            ...(request.postData() ? { payload: request.postData() } : {}),
          });
          const delay = delays.get(resource);
          if (delay) {
            delays.delete(resource);
            delay.captured();
            await delay.released;
          }
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
      await page.getByRole('button', { name: '更多操作', exact: true }).first().waitFor({ state: 'attached' });
      return page;
    },
    async close() {
      await browser.close();
      await app.close();
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
    },
  };
}
