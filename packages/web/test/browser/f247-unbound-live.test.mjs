import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { realSurfaceApiResponse } from './f307-real-surface-fixtures.mjs';
import { startNativeHost } from './f322-native-reply-next.mjs';

const require = createRequire(import.meta.url);
const { cloudThreadId } = require('./fixtures/f247-cloud-receipt-messages.ts');
const { authorizedRows, unboundTurn } = require('./fixtures/f247-unbound-turn.ts');

// Real Next/ChatContainer/Socket.IO consumers; only API responses and the wire are fixtures.
const out = process.env.UNBOUND_LIVE_EVIDENCE_DIR;
const alphaOrigin = process.env.UNBOUND_LIVE_TEST_ORIGIN;
const measurements = [];
let host, browser;
before(async () => {
  if (out) await mkdir(out, { recursive: true });
  if (alphaOrigin) {
    const url = new URL(alphaOrigin);
    assert(['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'http:');
    assert(url.port && !['3001', '3002'].includes(url.port), 'fixtures never target the formal runtime');
    host = { url: url.origin, ready: async () => assert((await fetch(url.origin)).ok), close: async () => {} };
  } else host = await startNativeHost();
  await host.ready();
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await host?.close();
  if (out)
    await writeFile(
      path.join(out, 'journey.json'),
      JSON.stringify(
        {
          source:
            'isolated actual Next/Socket.IO → useAgentMessages → ChatContainer, synthetic API, no real binding or cloud sends',
          host: alphaOrigin ? 'named-alpha' : 'feature-next',
          measurements,
        },
        null,
        2,
      ),
    );
});

async function visit(width, author) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const requests = [],
    errors = [],
    sockets = [],
    timers = [];
  const [source, response, warning] = unboundTurn(author, true);
  const original = JSON.stringify([source, response]);
  let persisted = false,
    joined = false,
    historyReads = 0;
  let bindings = {};
  const at = Date.now(),
    name = `${author}-${width}`;
  const page = await context.newPage();
  try {
    await context.addInitScript(() => {
      localStorage.setItem('cat-cafe:shell-presentation', 'v2');
      localStorage.setItem('cat-cafe:shell-language', 'zh');
      localStorage.setItem('theme', 'light');
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.routeWebSocket('**/socket.io/**', (socket) => {
      sockets.push(socket);
      const sid = `unbound-${sockets.length}`;
      socket.send(`0${JSON.stringify({ sid, upgrades: [], pingInterval: 25000, pingTimeout: 20000 })}`);
      timers.push(setInterval(() => socket.send('2'), 20000));
      socket.onMessage((packet) => {
        const text = String(packet);
        if (text.startsWith('40')) socket.send(`40${JSON.stringify({ sid })}`);
        if (!text.startsWith('42')) return;
        const bracket = text.indexOf('['),
          ack = text.slice(2, bracket);
        const [event, room] = JSON.parse(text.slice(bracket));
        if (event === 'join_room') {
          if (ack) socket.send(`43${ack}${JSON.stringify([{ ok: true, room }])}`);
          if (room === `thread:${cloudThreadId}`) joined = true;
        }
      });
    });
    await page.route('**/api/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      requests.push({ path: url.pathname, method: request.method(), body: request.postData() });
      let result;
      if (url.pathname === '/api/session') result = { body: { userId: 'owner' } };
      else if (url.pathname === '/api/messages') {
        historyReads++;
        result = { body: { messages: persisted ? unboundTurn(author) : [source, response], hasMore: false } };
      } else if (url.pathname === '/api/cats')
        result = {
          body: {
            cats: ['codex-sol', 'gpt-pro'].map((id) => ({
              id,
              displayName: id === 'gpt-pro' ? '缅因猫Pro' : '缅因猫 Sol',
              breedId: 'maine-coon',
              color: { primary: '#5B8C5A', secondary: '#eeeeee' },
              avatar: '/avatars/gpt52.png',
              mentionPatterns: [`@${id}`],
              carrier: 'cli',
              clientId: 'openai',
              provider: id === 'gpt-pro' ? 'openai-chatgpt-pro' : 'openai',
              defaultModel: id,
              roster: { available: true },
            })),
          },
        };
      else if (url.pathname === '/api/threads' || url.pathname === `/api/threads/${cloudThreadId}`) {
        const thread = {
          id: cloudThreadId,
          title: '未绑定 Pro 的会话连接',
          createdBy: 'owner',
          participants: ['gpt-pro', 'codex-sol'],
          createdAt: 100,
          updatedAt: 120,
        };
        result = { body: url.pathname === '/api/threads' ? { threads: [thread] } : thread };
      } else if (url.pathname.endsWith('/cloud-bindings')) {
        if (request.method() === 'PATCH') {
          const body = request.postDataJSON();
          bindings = { ...bindings, [body.catId]: body.chatUrl };
        }
        result = { body: { bindings } };
      } else if (url.pathname.endsWith('/personalChromeAuthorizations/list'))
        result = {
          body: {
            ok: true,
            render: 'rows',
            data: {
              rows: authorizedRows().map((c) => ({ key: c.conversationId, label: c.displayTitle ?? c.conversationId })),
            },
          },
        };
      else if (url.pathname.endsWith('/cloud-return')) result = { body: { status: 'unverified' } };
      else if (url.pathname.endsWith('/retry')) result = { status: 202, body: { accepted: true } };
      else result = realSurfaceApiResponse(request, false);
      await route.fulfill({
        status: result?.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(result?.body ?? {}),
      });
    });
    await page.goto(`${host.url}/thread/${cloudThreadId}?shell=v2`, { waitUntil: 'networkidle', timeout: 180000 });
    if (await page.getByTestId('sidebar-collapse').isVisible()) await page.getByTestId('sidebar-collapse').click();
    const row = page.locator(`[data-message-id="${source.id}"]`).first();
    await row.waitFor();
    assert.equal(await page.getByTestId('cloud-binding-recovery-card').count(), 0);
    await assertEventually(() => joined);
    const live = {
      type: 'system_info',
      catId: 'gpt-pro',
      threadId: cloudThreadId,
      invocationId: 'dispatch77',
      messageId: response.id,
      content: JSON.stringify(warning.extra.systemInfo.payload),
    };
    for (const socket of sockets) socket.send(`42${JSON.stringify(['agent_message', live])}`);
    const card = row.getByTestId('cloud-binding-recovery-card');
    await card.getByRole('radio').first().waitFor();
    assert.equal(await card.getByRole('radio').count(), 21, 'live event exposes choices without history reload');
    assert.equal(historyReads, 1, 'the recovery was driven by the socket event, not a history refresh');
    await card.scrollIntoViewIfNeeded();
    const list = card.locator('fieldset');
    assert(await list.evaluate((node) => node.scrollHeight > node.clientHeight && node.clientHeight <= 290));
    assert(
      (await card.boundingBox()).width >= (await row.boundingBox()).width - 1,
      'picker must use the available reading column, independent of short message width',
    );
    const primary = card.locator('[data-recovery-primary]');
    assert(await primary.isDisabled());
    await card.getByRole('radio').nth(20).check();
    assert(await primary.isEnabled());
    assert.equal(requests.filter((r) => r.method === 'PATCH' || r.path.endsWith('/retry')).length, 0);
    await list.evaluate((node) => {
      node.scrollTop = 0;
    });
    if (out) await card.screenshot({ path: path.join(out, `${name}-card.png`) });
    // The same source survives the server's persisted history shape, without a second recovery surface.
    persisted = true;
    await page.reload({ waitUntil: 'networkidle' });
    const restored = page.getByTestId('cloud-binding-recovery-card');
    await restored.getByRole('radio').nth(1).check();
    assert.equal(await restored.count(), 1);
    await restored.scrollIntoViewIfNeeded();
    if (out) await page.screenshot({ path: path.join(out, `${name}-history.png`), fullPage: true });
    await restored.locator('[data-recovery-primary]').click();
    if (author === 'cat') await restored.getByText(/没有重发/).waitFor();
    else await restored.getByText('消息已进入发送流程', { exact: true }).waitFor();
    assert.equal(requests.filter((r) => r.method === 'PATCH').length, 1);
    const retries = requests.filter((r) => r.path.endsWith('/retry'));
    assert.equal(retries.length, author === 'user' ? 1 : 0);
    if (retries.length) assert.deepEqual(JSON.parse(retries[0].body), { attemptId: 'dispatch77' });
    assert(!requests.some((r) => r.path === '/api/messages' && r.method !== 'GET'));
    assert.equal(JSON.stringify([source, response]), original);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    measurements.push({
      name,
      historyReads,
      elapsedMs: Date.now() - at,
      errors,
      writes: requests.filter((r) => r.method === 'PATCH' || r.path.endsWith('/retry')),
    });
  } catch (error) {
    if (out) {
      await page.screenshot({ path: path.join(out, `${name}-failure.png`), fullPage: true });
      await writeFile(path.join(out, `${name}-failure.txt`), await page.locator('body').innerText());
    }
    throw error;
  } finally {
    for (const timer of timers) clearInterval(timer);
    await context.close();
  }
}
async function assertEventually(predicate) {
  const until = Date.now() + 15000;
  while (!predicate() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  assert(predicate(), 'the real Socket.IO client must join the thread');
}
test(
  'human and cat live recovery, history, 21 choices and explicit actions on desktop/mobile',
  { timeout: 300000 },
  async () => {
    for (const width of [1440, 390]) for (const author of ['user', 'cat']) await visit(width, author);
  },
);
