import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { CALENDAR_THREAD } from './f310-work-calendar.fixture.mjs';
import { createMailboxHistoryFixture } from './f322-mailbox-history.fixture.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url)),
  tree = path.resolve(web, '../..');
const evidence = process.env.F322_HISTORY_EVIDENCE ?? '/tmp/f322-mailbox-history/native';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function boundedBody(response) {
  let timer;
  try {
    return await Promise.race([
      response.json(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ bodyUnavailable: true }), 3000);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

test(
  'one real mailbox journey: lazy 30, >200 continuation, shared native effects, private recovery and warm reopen',
  { timeout: 240000 },
  async (t) => {
    await mkdir(evidence, { recursive: true });
    let fixture, environment, server, browser, page;
    const errors = [],
      timeline = [],
      pendingBodies = [],
      metrics = {};
    t.after(async () => {
      try {
        if (page && !page.isClosed()) await writeFile(path.join(evidence, 'final.html'), await page.content());
        if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'final.png'), timeout: 5000 });
        await Promise.allSettled(pendingBodies);
        if (page && !page.isClosed())
          metrics.nativeReadStacks = await page.evaluate(() => window.__f322NativeReads ?? []).catch(() => []);
        await writeFile(
          path.join(evidence, 'result.json'),
          JSON.stringify(
            { errors, timeline, metrics, sourceReads: fixture?.reads, mutations: fixture?.mutations },
            null,
            2,
          ),
        );
      } finally {
        if (browser) await browser.close();
        if (server) await stopChild(server);
        await fixture?.close();
        await environment?.cleanup();
        await writeFile(
          path.join(evidence, 'cleanup.json'),
          JSON.stringify(
            { browserClosed: !browser || !browser.isConnected(), nextExit: server?.exitCode, fixturesClosed: true },
            null,
            2,
          ),
        );
      }
    });
    try {
      fixture = await createMailboxHistoryFixture(tree);
      const { owner, expected } = fixture;
      const port = await availablePort();
      environment = await createNextDevTestEnvironment('f322-unified-history', {
        API_SERVER_PORT: String(fixture.apiPort),
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${fixture.apiPort}`,
        FRONTEND_PORT: String(port),
      });
      server = spawn(
        process.execPath,
        [
          path.join(web, 'scripts/sync-vendor-assets.mjs'),
          '--watch',
          '--',
          process.execPath,
          path.join(tree, 'node_modules/next/dist/bin/next'),
          'dev',
          '-H',
          '127.0.0.1',
          '-p',
          String(port),
        ],
        { cwd: web, env: environment.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      for (const stream of [server.stdout, server.stderr])
        stream.on('data', (data) => writeFile(path.join(evidence, 'web.log'), data, { flag: 'a' }));
      await waitForHttp(`http://127.0.0.1:${port}/thread/${CALENDAR_THREAD}`, server);
      browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {}),
      });
      page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.setDefaultTimeout(20000);
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/api/'))
          timeline.push({
            event: 'request',
            at: Date.now(),
            method: request.method(),
            path: new URL(request.url()).pathname + new URL(request.url()).search,
          });
      });
      page.on('response', (response) => {
        if (!/\/api\/(approval-hub|proposals|concierge\/work)/.test(response.url())) return;
        pendingBodies.push(
          boundedBody(response).then((body) =>
            timeline.push({
              event: 'response',
              at: Date.now(),
              path: new URL(response.url()).pathname,
              status: response.status(),
              count: body?.count,
              ids: body?.items?.map((item) => item.proposalId),
              hasMore: body?.page?.hasMore,
              bytes: Buffer.byteLength(JSON.stringify(body)),
            }),
          ),
        );
      });
      await page.addInitScript(() => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem('cat-cafe:shell-language', 'zh');
        Error.stackTraceLimit = 40;
        window.__f322NativeReads = [];
        window.__f322NativeInFlight = 0;
        const original = window.fetch;
        window.fetch = async function (...args) {
          const input = args[0];
          const url = new URL(typeof input === 'string' ? input : (input.url ?? String(input)), location.href);
          const native =
            url.pathname === '/api/proposals/inbox-native-approve' &&
            (args[1]?.method ?? input.method ?? 'GET') === 'GET';
          if (native) {
            window.__f322NativeInFlight++;
            if (window.__f322NativeReads.length < 64)
              window.__f322NativeReads.push({ at: Date.now(), stack: new Error().stack });
          }
          try {
            return await Reflect.apply(original, this, args);
          } finally {
            if (native) window.__f322NativeInFlight--;
          }
        };
      });
      const base = `http://127.0.0.1:${port}`;
      await page.goto(`${base}/thread/${CALENDAR_THREAD}?shell=v2`);
      const composer = page.locator('[data-testid="chat-input-composer-row"] textarea');
      await composer.fill('未发送的验收草稿');
      const reads = (pattern) =>
        timeline.filter((entry) => entry.event === 'request' && entry.method === 'GET' && pattern.test(entry.path))
          .length;
      const historyReads = () => reads(/\/approval-hub\/settled/);
      const home = async () => {
        const start = Date.now();
        await page.getByTestId('mailbox-button').click();
        await page
          .getByTestId('mailbox-panel')
          .getByTestId('approval-item-inbox-native-approve')
          .getByTestId('approve-btn')
          .waitFor();
        await page.waitForFunction(
          () =>
            !document.querySelector(
              '[data-testid="mailbox-panel"] [data-testid="approval-item-inbox-native-approve"] [data-testid="approve-btn"]',
            )?.disabled,
        );
        return Date.now() - start;
      };
      metrics.coldHomeActionMs = await home();
      assert.equal(historyReads(), 0);
      const unified = reads(/\/concierge\/work\/decisions/),
        pending = reads(/\/approval-hub\/pending/);
      await page.getByTestId('mailbox-close').click();
      metrics.warmHomeActionMs = await home();
      assert.equal(reads(/\/concierge\/work\/decisions/), unified);
      assert.equal(reads(/\/approval-hub\/pending/), pending);
      assert.equal(
        reads(/\/proposals\/inbox-native-approve(?:\?|$)/),
        1,
        'the original chat card and remounted mailbox join one native proposal read',
      );
      const mention = page.getByTestId('mailbox-item').filter({ hasText: '待核对的原件' });
      await mention.getByTestId('mailbox-item-toggle').click();
      await mention.getByTestId('mailbox-item-ignore').click();
      await page.getByTestId('mailbox-transient-result').waitFor();
      await page.locator('#mailbox-tabpanel').evaluate((node) => {
        node.scrollTop = 0;
      });
      await page.screenshot({ path: path.join(evidence, 'home-1440.png') });
      await page.getByTestId('mailbox-history').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="mailbox-history-row"]').length >= 30);
      const first = page.getByTestId('mailbox-history-row').first();
      await first.getByRole('button').first().click();
      await first.getByText('在原处看 ↗', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(evidence, 'handled-expanded-1440.png') });
      await page.getByTestId('mailbox-history-tab-ignored').click();
      await page.getByTestId('mailbox-history-row').filter({ hasText: '待核对的原件' }).waitFor();
      await page.getByTestId('mailbox-history-select').click();
      await page.getByRole('checkbox').first().check();
      assert.equal(await page.getByTestId('mailbox-history-restore-selected').isEnabled(), true);
      await page.screenshot({ path: path.join(evidence, 'ignored-select-1440.png') });
      const restore = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/config/ignored-items' && response.request().method() === 'PATCH',
      );
      await page.getByTestId('mailbox-history-restore-selected').click();
      assert.equal((await restore).status(), 200);
      await page.getByText('还没有忽略的事项', { exact: true }).waitFor();
      const privatePreferences = await (await page.request.get(`${base}/api/config/ignored-items`)).json();
      assert.equal(privatePreferences.entries.length, 0);
      assert.equal(
        fixture.messages.listUserMentionRequests(owner).length,
        2,
        'personal restoration never resolves the canonical mentions',
      );
      metrics.actualIgnoredBatchRestores = 1;

      await page.getByTestId('mailbox-handled-back').click();
      await page.getByTestId('mailbox-close').click();
      await home();
      assert.equal(await page.getByTestId('mailbox-transient-result').count(), 0);
      const delay = '**/api/approval-hub/settled/page?*';
      await page.route(delay, async (route) => {
        await pause(500);
        await route.continue();
      });
      await page.getByTestId('mailbox-history').click();
      await page.getByText('正在更新…', { exact: true }).first().waitFor();
      assert.ok((await page.getByTestId('mailbox-history-row').count()) >= 30);
      await page.screenshot({ path: path.join(evidence, 'reopen-updating-1440.png') });
      await page.getByText('正在更新…', { exact: true }).first().waitFor({ state: 'detached' });
      await page.unroute(delay);
      const content = page.getByTestId('mailbox-history-content');
      await content.evaluate((node) => {
        node.scrollTop = 240;
      });
      const anchor = content.locator('[data-proposal-id="history-0245"]');
      const anchorBefore = await anchor.boundingBox();
      const live = fixture.appendLiveHistory();
      expected.push(live.proposalId);
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent('cat-cafe:proposal-updated', { detail: { proposalId: 'history-live-head' } }),
        ),
      );
      await content.locator('[data-proposal-id="history-live-head"]').waitFor();
      await page.getByText('正在更新…', { exact: true }).first().waitFor({ state: 'detached' });
      const anchorAfter = await anchor.boundingBox();
      assert.ok(Math.abs(anchorBefore.y - anchorAfter.y) <= 1, 'a new head preserves the current reading position');
      metrics.newHeadAnchor = { before: anchorBefore.y, after: anchorAfter.y };

      for (let attempt = 0; attempt < 12 && (await page.getByTestId('mailbox-history-load-more').count()); attempt++) {
        const before = await page.getByTestId('mailbox-history-row').count();
        await page.getByTestId('mailbox-history-content').evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        await page.waitForFunction(
          (before) =>
            document.querySelectorAll('[data-testid="mailbox-history-row"]').length > before ||
            !document.querySelector('[data-testid="mailbox-history-load-more"]'),
          before,
        );
      }
      assert.equal(await page.getByTestId('mailbox-history-row').count(), expected.length);
      assert.equal(
        await page.getByTestId('mailbox-history-row').first().getAttribute('data-proposal-id'),
        'history-live-head',
      );
      await Promise.all(pendingBodies);
      const bodies = timeline.filter(
        (entry) =>
          entry.event === 'response' && entry.path === '/api/approval-hub/settled/page' && entry.status === 200,
      );
      assert.ok(bodies.length >= 9);
      assert.ok(bodies.every((body) => body.count <= 30));
      assert.equal(new Set(bodies.flatMap((body) => body.ids)).size, expected.length);
      metrics.historyPages = bodies.map(({ count, hasMore, bytes }) => ({ count, hasMore, bytes }));
      await page.getByTestId('mailbox-handled-back').click();
      await pause(1200); // An idle gap before using the original approval writer; no polling is added by the test.
      const approve = page
        .getByTestId('mailbox-panel')
        .getByTestId('approval-item-inbox-native-approve')
        .getByTestId('approve-btn');
      const approved = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/proposals/inbox-native-approve/approve' &&
          response.request().method() === 'POST',
      );
      await approve.click();
      const approvedResponse = await approved;
      assert.equal(approvedResponse.status(), 200);
      const child = (await approvedResponse.json()).threadId;
      assert.ok(child);
      const retained = page.getByTestId('mailbox-retained-result');
      await retained.getByTestId('proposal-result-label').filter({ hasText: '对话已开' }).waitFor();
      await page.waitForFunction(() => window.__f322NativeInFlight === 0);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const provenNativeReads = reads(/\/proposals\/inbox-native-approve(?:\?|$)/);
      metrics.nativeReadsAfterFreshWriteConfirmation = provenNativeReads;
      await retained.getByTestId('proposal-result-open').click();
      await page.waitForURL((url) => url.pathname === `/thread/${child}`);
      await page.goBack();
      await page.getByTestId('mailbox-button').click();
      await page.getByTestId('mailbox-history').click();
      const completed = page.getByTestId('mailbox-history-row').filter({ hasText: 'Native new conversation approve' });
      await completed.getByText(/对话已开/).waitFor();
      assert.equal((await fixture.proposals.get('inbox-native-approve')).createdThreadId, child);
      assert.equal((await fixture.threads.get(child)).createdFromProposalId, 'inbox-native-approve');
      assert.equal(await composer.inputValue(), '未发送的验收草稿');
      const originalCard = fixture.records.find((record) => record.proposalId === 'inbox-native-approve').publication
        .envelope.approvalCardRef;
      await page.getByTestId('mailbox-close').click();
      const originalMessage = page.locator(`[data-message-id="${originalCard.messageId}"]`);
      await originalMessage.scrollIntoViewIfNeeded();
      await originalMessage.getByText('对话已开', { exact: false }).first().waitFor();
      await page.locator('[data-chat-container]').evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await originalMessage.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => window.__f322NativeInFlight === 0);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(
        reads(/\/proposals\/inbox-native-approve(?:\?|$)/),
        provenNativeReads,
        'confirmed proposal remounts, cross-entry reads and scrolls do not requery the native result',
      );
      metrics.confirmedRemountExtraNativeReads = 0;
      metrics.actualChild = child;
      metrics.receipts = fixture.messages
        .getByThread(CALENDAR_THREAD, 100, owner)
        .filter((message) => message.source?.meta?.approvalDecisionReceipt).length;
      assert.deepEqual(errors, []);
      metrics.passed = true;
    } catch (error) {
      metrics.failure = { message: error.message, stack: error.stack };
      throw error;
    }
  },
);
