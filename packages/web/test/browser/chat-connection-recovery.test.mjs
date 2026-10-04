import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { registerNavigationOwnerJourneys } from './chat-navigation-owner.journey.mjs';
import { registerReadingLandingJourneys } from './chat-reading-landing.journey.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'https://chat-recovery.test';
const threadId = 'chat-recovery';
let browser;
let bundle;

before(async () => {
  const result = await build({
    root: webRoot,
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@': path.join(webRoot, 'src') } },
    define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(webRoot, 'test/browser/fixtures/chat-connection-recovery.tsx'),
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  });
  const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
  bundle = outputs.find((item) => item.type === 'chunk' && item.isEntry);
  assert(bundle?.type === 'chunk');
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());

registerNavigationOwnerJourneys({ origin, browser: () => browser, bundle: () => bundle.code });

registerReadingLandingJourneys({ origin, threadId, browser: () => browser, bundle: () => bundle.code });

function fixtureApiBody(pathname, state) {
  if (pathname === '/api/messages') {
    state.historyReads += 1;
    return { messages: state.messages, hasMore: false };
  }
  if (pathname.endsWith('/queue')) return { queue: [], activeInvocations: [], paused: false };
  if (pathname === '/api/executions/active') return { projectPath: '/fixture', executions: state.executions };
  if (pathname === '/api/threads') {
    return { threads: [{ id: threadId, title: 'Recovery', projectPath: '/fixture', createdAt: 1 }] };
  }
  return { userId: 'fixture-owner', tasks: [], threads: [], cats: [] };
}

async function openConversation() {
  const page = await browser.newPage();
  const errors = [],
    writes = [],
    sockets = [];
  const state = {
    historyReads: 0,
    documentLoads: 0,
    messages: [{ id: 'before', content: 'Please continue', timestamp: 1 }],
    executions: [],
  };
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install();
  // Simulate only the wire; production Socket.IO, runtime owner and history/store are real.
  await page.routeWebSocket('**/socket.io/**', (socket) => {
    sockets.push(socket);
    const sid = `fixture-${sockets.length}`;
    socket.send(`0${JSON.stringify({ sid, upgrades: [], pingInterval: 25000, pingTimeout: 20000 })}`);
    socket.onMessage((packet) => {
      const text = String(packet);
      if (text.startsWith('40')) socket.send(`40${JSON.stringify({ sid })}`);
      if (!text.startsWith('42')) return;
      const bracket = text.indexOf('[');
      const acknowledgement = text.slice(2, bracket);
      const [event, room] = JSON.parse(text.slice(bracket));
      if (event === 'join_room' && acknowledgement) {
        socket.send(`43${acknowledgement}${JSON.stringify([{ ok: true, room }])}`);
      }
    });
  });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.origin, origin, 'the proof must not access a live service');
    if (request.method() !== 'GET') writes.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.code });
    if (url.pathname.startsWith('/api/')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(fixtureApiBody(url.pathname, state)),
      });
    }
    state.documentLoads += 1;
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/proof.js"></script>',
    });
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-message-id="before"]').waitFor();
  await page.locator('main[data-connected="true"]').waitFor();
  return { page, state, sockets, errors, writes };
}

function saveMissedReply(state) {
  state.messages.push({
    id: 'missed-reply',
    catId: 'codex-astra',
    content: 'The handoff was already saved',
    timestamp: Date.now(),
    origin: 'callback',
    extra: { isExplicitPost: true },
  });
  state.executions = [
    {
      kind: 'live_invocation',
      executionId: 'sol-turn',
      threadId,
      threadTitle: 'Recovery',
      catId: 'codex-sol',
      startedAt: Date.now(),
      cancelability: { state: 'not_cancelable', reason: 'foreign_principal' },
    },
  ];
}

test('dormant automatic retry recovers the saved reply while execution polling continues', async () => {
  const { page, state, sockets, errors, writes } = await openConversation();
  try {
    const previousReads = state.historyReads;
    // Socket.IO emits disconnect before scheduling reconnect; an observer failure interrupts it.
    await page.evaluate(() => {
      const originalWarn = console.warn;
      console.warn = (...args) => {
        if (args[0] === '[ws] Disconnected') {
          console.warn = originalWarn;
          throw new Error('injected disconnect observer failure');
        }
        originalWarn(...args);
      };
    });
    await sockets.at(-1).close({ code: 1000, reason: 'fixture transport interruption' });
    await page.locator('main[data-connected="false"]').waitFor();
    saveMissedReply(state);
    assert.equal(await page.locator('[data-message-id="missed-reply"]').count(), 0);
    await page.clock.runFor(6000);
    await page.locator('[data-message-id="missed-reply"]').waitFor({ timeout: 3000 });
    assert.equal(await page.locator('[data-executions]').innerText(), 'codex-sol');
    assert.equal(await page.locator('main').getAttribute('data-connected'), 'true');
    assert.equal(sockets.length, 2);
    assert(state.historyReads > previousReads);
    assert.equal(state.documentLoads, 1, 'no F5 or route remount');
    assert.deepEqual(errors, ['injected disconnect observer failure']);
    assert.deepEqual(writes, [], 'recovery must not mutate work');
  } finally {
    await page.close();
  }
});

test('returning to a connected quiet page fetches the missed reply without a socket event', async () => {
  const { page, state, sockets, errors, writes } = await openConversation();
  try {
    saveMissedReply(state);
    const previousReads = state.historyReads;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.clock.runFor(1000);
    await page.locator('[data-message-id="missed-reply"]').waitFor({ timeout: 3000 });
    assert.equal(sockets.length, 1);
    assert(state.historyReads > previousReads);
    assert.equal(state.documentLoads, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
  } finally {
    await page.close();
  }
});

test('long deferred history retains its exact reading offset across Back and cold reload beyond the latest page', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [],
    cursors = [];
  const records = Array.from({ length: 80 }, (_, index) => ({
    id: `scroll-${index + 1}`,
    type: 'assistant',
    catId: 'codex-astra',
    timestamp: index + 1,
    extra: { stream: { turnInvocationId: `reading-turn-${index + 1}` } },
    isDraft: index === 4,
    content: `Reading message ${index + 1}\n${'Long conversation evidence. '.repeat(40)}`,
  }));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin);
    if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.code });
    if (url.pathname.startsWith('/api/')) {
      let body = { userId: 'fixture-owner', tasks: [], cats: [], activeInvocations: [], queue: [] };
      if (url.pathname === '/api/messages') {
        const before = url.searchParams.get('before');
        cursors.push(before);
        body =
          url.searchParams.get('threadId') === 'chat-other'
            ? { messages: [{ ...records[0], id: 'other' }], hasMore: false }
            : { messages: before ? records.slice(0, 30) : records.slice(30), hasMore: !before };
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><style>[data-message-viewport-boundary]{content-visibility:auto}article{box-sizing:border-box}</style><div id="root"></div><script type="module" src="/proof.js"></script>',
    });
  });
  const sample = () =>
    page.locator('[data-scroll-chat]').evaluate((el) => {
      const viewport = el.getBoundingClientRect();
      const node = [...el.querySelectorAll('[data-message-viewport-id]')].find(
        (node) => node.getBoundingClientRect().bottom > viewport.top,
      );
      return {
        id: node?.dataset.messageViewportId,
        offset: node?.getBoundingClientRect().top - viewport.top,
        top: el.scrollTop,
      };
    });
  try {
    await page.goto(`${origin}/${threadId}?scroll=1`);
    await page.locator('[data-message-id="scroll-80"]').waitFor();
    const chat = page.locator('[data-scroll-chat]');
    await chat.hover();
    await page.mouse.wheel(0, -100000);
    await page.locator('[data-message-id="scroll-5"]').waitFor();
    await page.waitForTimeout(750);
    // A wheel-backed reading intent, with a signed offset inside an older message.
    await chat.evaluate((el) => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
      const target = el.querySelector('[data-message-viewport-id="scroll-5"]');
      el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top + 27;
    });
    await page.waitForTimeout(100);
    const before = await sample();
    assert.equal(before.id, 'scroll-5');
    await page.getByRole('button', { name: 'Finalize reading message', exact: true }).click();
    records[4].id = 'settled-reading';
    records[4].isDraft = false;
    await page.locator('[data-message-id="settled-reading"]').waitFor();
    await page.waitForTimeout(100);
    const rekeyed = await sample();
    assert.equal(rekeyed.id, 'settled-reading');
    assert.ok(Math.abs(rekeyed.offset - before.offset) <= 1, JSON.stringify({ before, rekeyed }));
    before.id = rekeyed.id;
    await page.getByRole('button', { name: 'Other thread', exact: true }).click();
    await page.locator('[data-message-id="other"]').waitFor();
    await page.goBack();
    await page.locator('[data-message-id="settled-reading"]').waitFor();
    await page.waitForTimeout(750);
    const back = await sample();
    assert.equal(back.id, before.id);
    assert.ok(Math.abs(back.offset - before.offset) <= 1, JSON.stringify({ before, back }));
    // A decoded image above the reading row changes layout without navigation.
    await chat.evaluate((el) => {
      const predecessor = el.querySelector('[data-message-id="scroll-4"]');
      const image = document.createElement('img');
      image.width = 400;
      image.height = 300;
      image.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"/>';
      predecessor.append(image);
    });
    await page.waitForTimeout(100);
    const imageLoaded = await sample();
    assert.equal(imageLoaded.id, before.id);
    assert.ok(Math.abs(imageLoaded.offset - before.offset) <= 1, JSON.stringify({ before, imageLoaded }));
    const priorCursors = cursors.length;
    await page.reload();
    await page.locator('[data-message-id="settled-reading"]').waitFor();
    await page.waitForTimeout(750);
    const reload = await sample();
    assert.equal(reload.id, before.id);
    assert.ok(Math.abs(reload.offset - before.offset) <= 1, JSON.stringify({ before, reload }));
    assert.ok(cursors.slice(priorCursors).some(Boolean), 'cold page must page back to its saved anchor');

    await chat.click({ position: { x: 700, y: 300 } });
    await page.keyboard.press('End');
    await page.waitForTimeout(750);
    const followed = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:chat-recovery')),
    );
    assert.equal(followed.state.anchor, 'bottom', JSON.stringify(followed));
    await page.getByRole('button', { name: 'Latest', exact: true }).click();
    await page.waitForTimeout(750);
    const bottomGap = await chat.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    assert.ok(bottomGap <= 1, `explicit Latest must beat reading memory: ${bottomGap}`);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
