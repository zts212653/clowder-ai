import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { chromium } from 'playwright';
import { build } from 'vite';
import { persistStreamedInteractiveBlock } from '../../../api/dist/domains/cats/services/agents/invocation/persist-streamed-interactive-block.js';
import {
  commitLifecycleResponseFromAppendInput,
  MessageStore,
} from '../../../api/dist/domains/cats/services/stores/ports/MessageStore.js';
import { messageActionsRoutes } from '../../../api/dist/routes/message-actions.js';

test('#1951 custom answer survives a thread switch, refresh, original replay and terminal commit in Chromium', async () => {
  const web = path.resolve(import.meta.dirname, '../..');
  const origin = 'https://interactive-state.test';
  const built = await build({
    root: web,
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    plugins: [
      {
        name: 'fixture-router',
        enforce: 'pre',
        resolveId(id) {
          if (id === 'next/navigation') return '\0fixture-router';
        },
        load(id) {
          if (id === '\0fixture-router')
            return 'export const useRouter=()=>({push(){},replace(){}});export const usePathname=()=>"/";export const useSearchParams=()=>new URLSearchParams();';
        },
      },
    ],
    resolve: { alias: { '@': path.join(web, 'src') } },
    define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(web, 'test/browser/fixtures/issue1951-interactive-state.tsx'),
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  });
  const outputs = Array.isArray(built) ? built.flatMap((item) => item.output) : built.output;
  const script = outputs.find((item) => item.type === 'chunk' && item.isEntry)?.code;
  assert.ok(script);
  const store = new MessageStore();
  const question = {
    id: 'question',
    kind: 'interactive',
    v: 1,
    interactiveType: 'select',
    title: '本次同步优先覆盖哪些数据？',
    options: [
      { id: 'all', label: '全部数据' },
      { id: 'custom', label: '其他回答', customInput: true, customInputPlaceholder: '输入你的回答' },
    ],
  };
  const input = {
    from: { kind: 'agent', catId: 'codex' },
    userId: 'default-user',
    threadId: 'question-thread',
    content: '任务仍在执行，请选择同步范围。',
    mentions: [],
    timestamp: 100,
  };
  const response = store.append({
    ...input,
    origin: 'stream',
    extra: { stream: { invocationId: 'parent', turnInvocationId: 'turn' } },
    lifecycle: {
      kind: 'response',
      orderKey: '100:turn',
      invocationId: 'turn',
      targetId: 'codex',
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt: 100,
    },
  });
  const event = {
    type: 'system_info',
    catId: 'codex',
    messageId: response.id,
    invocationId: 'parent',
    turnInvocationId: 'turn',
    timestamp: 100,
    content: JSON.stringify({ type: 'rich_block', block: question }),
  };
  await persistStreamedInteractiveBlock(store, event, response.id);
  const app = Fastify();
  await app.register(messageActionsRoutes, { messageStore: store, socketManager: {} });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const accepted = [];
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  try {
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: '<main id="root"></main><script type="module" src="/fixture.js"></script>',
        });
      if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname.endsWith('/block-state')) {
        const result = await app.inject({ method: 'PATCH', url: url.pathname, payload: request.postDataJSON() });
        return route.fulfill({ status: result.statusCode, contentType: 'application/json', body: result.body });
      }
      let body = {};
      let status = 200;
      if (url.pathname === '/api/session') body = { userId: 'default-user' };
      else if (url.pathname === '/api/cats') body = { cats: [] };
      else if (url.pathname === '/api/messages' && request.method() === 'POST') {
        accepted.push(request.postDataJSON());
        status = 202;
        body = { status: 'queued' };
      } else if (url.pathname === '/api/messages')
        body = {
          messages:
            url.searchParams.get('threadId') === 'question-thread'
              ? [{ ...structuredClone(store.getById(response.id)), type: 'assistant' }]
              : [],
          hasMore: false,
        };
      else if (url.pathname === '/api/fixture-replay')
        body = {
          threadId: url.searchParams.get('threadId'),
          joinId: 'fixture-join',
          responses:
            url.searchParams.get('threadId') === 'question-thread'
              ? [
                  {
                    messageId: response.id,
                    catId: 'codex',
                    timestamp: 100,
                    complete: true,
                    nextIndex: 1,
                    events: [event],
                  },
                ]
              : [],
        };
      else if (url.pathname.endsWith('/queue')) body = { queue: [], activeInvocations: [] };
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(origin);
    await page.getByRole('button', { name: '其他回答', exact: true }).click();
    await page.getByPlaceholder('输入你的回答').fill('运动、体重和睡眠');
    const saved = page.waitForResponse((result) => result.url().endsWith('/block-state') && result.status() === 200);
    await page.getByRole('button', { name: '确认选择', exact: true }).click();
    await saved;
    assert.equal(accepted.length, 1);
    assert.match(accepted[0].content, /运动、体重和睡眠/);
    assert.equal(store.getById(response.id).lifecycle.status, 'processing');
    await page.getByRole('button', { name: '会话 B', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="active-thread"]')?.textContent === 'other-thread',
    );
    await page.getByRole('button', { name: '会话 A', exact: true }).click();
    await page.getByRole('button', { name: '其他回答', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '其他回答', exact: true }).isDisabled(), true);
    await page.reload();
    await page.getByRole('button', { name: '其他回答', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '其他回答', exact: true }).isDisabled(), true);
    await commitLifecycleResponseFromAppendInput(
      store,
      response.id,
      'turn',
      { status: 'completed', completedAt: 200 },
      {
        ...input,
        extra: { rich: { v: 1, blocks: [structuredClone(question)] } },
      },
    );
    await page.reload();
    await page.getByRole('button', { name: '其他回答', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '其他回答', exact: true }).isDisabled(), true);
    assert.equal(accepted.length, 1);
    assert.deepEqual(errors, []);
    const dir = path.resolve(web, '../../artifacts/issue1951/browser');
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'answered-after-refresh.png') });
    fs.writeFileSync(
      path.join(dir, 'receipt.json'),
      JSON.stringify(
        {
          scope:
            'Real components, send hook, store, replay/History merge, block-state route; synthetic admission and provider events, no model call',
          acceptedAnswers: accepted.length,
          errors,
          passed: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await context.close();
    await browser.close();
    await app.close();
  }
});
