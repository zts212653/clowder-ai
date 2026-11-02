import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { realSurfaceApiResponse } from './f307-real-surface-fixtures.mjs';
import { startNativeHost } from './f322-native-reply-next.mjs';
import { cloudReceiptTurn, cloudThreadId, cloudUnboundTurn } from './fixtures/f247-cloud-receipt-messages.ts';

// One actual Next/ChatContainer journey protects duplicate surfaces, canonical navigation
// and narrow-screen layout that SSR cannot prove. All API responses are synthetic.
const out = process.env.CLOUD_RECEIPT_EVIDENCE_DIR;
const alphaOrigin = process.env.CLOUD_RECEIPT_TEST_ORIGIN;
const measurements = [];
let browser, host;
const started = Date.now();

before(async () => {
  if (out) await mkdir(out, { recursive: true });
  if (alphaOrigin) {
    const url = new URL(alphaOrigin);
    assert(['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol === 'http:');
    assert(url.port && !['3001', '3002'].includes(url.port), 'browser fixtures never target the formal runtime');
    host = {
      url: url.origin,
      ready: async () => assert((await fetch(url.origin, { signal: AbortSignal.timeout(5000) })).ok),
      close: async () => {}, // The named Alpha launcher owns its lifecycle, not this browser test.
    };
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
          source: 'actual Next/ChatContainer with synthetic API only; no cloud sends or production services',
          hostKind: alphaOrigin ? 'named-alpha-owned-by-launcher' : 'isolated-next-owned-by-test',
          totalMs: Date.now() - started,
          measurements,
        },
        null,
        2,
      ),
    );
});

async function visit(width, target, unbound = false) {
  const at = Date.now();
  const context = await browser.newContext({ viewport: { width, height: 1050 } });
  const requests = [],
    errors = [];
  const name = `${target}-${width}${unbound ? '-unbound' : ''}`;
  let historyReads = 0;
  const messages = unbound ? cloudUnboundTurn() : cloudReceiptTurn(target);
  const answer = messages.find((m) => m.id === 'reply81');
  try {
    await context.addInitScript(() => {
      localStorage.setItem('cat-cafe:shell-presentation', 'v2');
      localStorage.setItem('cat-cafe:shell-language', 'zh');
      localStorage.setItem('theme', 'light');
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      requests.push({ path: url.pathname, method: request.method() });
      let response;
      if (url.pathname === '/api/messages') {
        historyReads++;
        // Pro starts from a cached page missing the real reply. The native link
        // must use the existing canonical reader to refresh before navigating.
        response = {
          body: {
            messages:
              !unbound && target === 'gpt-pro' && historyReads === 1
                ? messages.filter((m) => m.id !== 'reply81')
                : messages,
            hasMore: false,
          },
        };
      } else if (url.pathname.endsWith('/cloud-return')) {
        response = {
          body: answer
            ? { status: 'matched', replyMessageId: answer.id, proof: answer.extra.cloudBridgeReturn }
            : { status: 'unverified' },
        };
      } else if (url.pathname.includes('/chatgpt-dot/delivery/')) {
        response = {
          body: { threadId: cloudThreadId, receivedAt: 110, readAt: 120, replyMessageId: 'reply81', stale: false },
        };
      } else if (url.pathname === '/api/cats') {
        response = {
          body: {
            cats: ['gpt-pro', 'gpt-dot'].map((id) => ({
              id,
              displayName: id === 'gpt-pro' ? '缅因猫Pro' : '砚砚·dot',
              breedId: 'maine-coon',
              color: { primary: '#5B8C5A', secondary: '#eeeeee' },
              avatar: id === 'gpt-pro' ? '/avatars/gpt52.png' : '/avatars/gpt-dot.png',
              mentionPatterns: [`@${id}`],
              carrier: 'cli',
              clientId: 'openai',
              provider: 'openai-chatgpt-pro',
              defaultModel: id,
              roster: { available: true },
            })),
          },
        };
      } else if (url.pathname === '/api/threads' || url.pathname === `/api/threads/${cloudThreadId}`) {
        const thread = {
          id: cloudThreadId,
          title: 'Pro / dot 原生回执',
          createdBy: 'f307-real-adapter-user',
          participants: ['gpt-pro', 'gpt-dot'],
          createdAt: 100,
          updatedAt: 130,
        };
        response = { body: url.pathname === '/api/threads' ? { threads: [thread] } : thread };
      } else if (url.pathname.endsWith('/cloud-bindings')) {
        response = { body: { bindings: {} } };
      } else if (url.pathname.endsWith('/personalChromeAuthorizations/list')) {
        response = {
          body: {
            ok: true,
            render: 'rows',
            data: {
              rows: [
                { key: 'conversation-one', label: '科研一起看' },
                { key: 'conversation-two', label: '周末聊设计' },
              ],
            },
          },
        };
      } else response = realSurfaceApiResponse(request, false);
      await route.fulfill({
        status: response?.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(response?.body ?? {}),
      });
    });
    await page.goto(`${host.url}/thread/${cloudThreadId}?shell=v2`, { waitUntil: 'networkidle', timeout: 180000 });
    await page.locator('[data-testid="message-dispatch-avatars"]').first().waitFor();
    if (await page.getByTestId('sidebar-collapse').isVisible()) await page.getByTestId('sidebar-collapse').click();
    const native = page.locator(`[data-dispatch-target="${target}"]`).first();
    if (unbound) {
      const card = page.getByTestId('cloud-binding-recovery-card');
      await card.getByText('选择 ChatGPT 会话', { exact: true }).waitFor();
      assert.equal(await card.locator('input[type=radio]').count(), 2);
      assert(await card.locator('[data-recovery-primary]').isDisabled());
      await card.locator('input[value=conversation-two]').check();
      assert(await card.locator('[data-recovery-primary]').isEnabled());
      assert(!requests.some((r) => r.method === 'PATCH' || r.path.endsWith('/retry')));
      if (out) await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
    } else {
      await native.getByText('收到，已回复', { exact: true }).waitFor();
      const button = native.getByRole('button');
      assert.match(await native.innerText(), target === 'gpt-pro' ? /缅因猫Pro/ : /砚砚·dot/);
      await button.click();
      await page.locator('[data-message-id="reply81"]').filter({ hasText: '咪呀' }).first().waitFor();
      assert(historyReads >= 2, '看回复 must use the canonical history refresh');
      assert.equal(await page.getByText('已完成，没有返回可显示内容。', { exact: true }).count(), 0);
      assert.equal(await page.getByText('云端猫投递', { exact: true }).count(), 0);
      assert.equal(await page.getByText('已收到 Pro 回复', { exact: true }).count(), 0);
      assert.equal(await page.getByText('投递结果未知：后台 Host 没有返回可验证回执。', { exact: true }).count(), 0);
      assert.equal(await page.getByTestId('message-dispatch-avatars').count(), 1);
      await page.locator('[data-message-id="source77"]').first().scrollIntoViewIfNeeded();
      if (out) await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
      await page.reload({ waitUntil: 'networkidle' });
      await page
        .locator(`[data-dispatch-target="${target}"]`)
        .first()
        .getByText('收到，已回复', { exact: true })
        .waitFor();
      assert.equal(await page.getByText('云端猫投递', { exact: true }).count(), 0);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    assert(!requests.some((r) => r.path === '/api/messages' && r.method !== 'GET'), 'no cloud send/retry');
    measurements.push({
      name,
      historyReads,
      elapsedMs: Date.now() - at,
      pageErrors: errors,
      writes: requests.filter((r) => r.method !== 'GET'),
    });
  } catch (error) {
    if (out) await context.pages()[0]?.screenshot({ path: path.join(out, `${name}-failure.png`), fullPage: true });
    throw error;
  } finally {
    await context.close();
  }
}

test(
  'Pro and dot share the native receipt; canonical refresh and unbound controls survive on desktop/mobile',
  { timeout: 300000 },
  async () => {
    for (const width of [1440, 390]) {
      for (const target of ['gpt-pro', 'gpt-dot']) await visit(width, target);
    }
    await visit(390, 'gpt-pro', true);
  },
);
