import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { origin, webRoot } from './fixtures/f322-chat-real-page-build.mjs';
import { BUSY_THREAD, CURRENT_THREAD, cats, createChatProofApi, DRAFT } from './fixtures/f322-chat-real-page-data.mjs';

export function pianoRecords(count) {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const content = `消息 ${n}：${'用实际消息高度定位，保持原阅读位置和草稿。'.repeat(1 + (index % 5))}`;
    return {
      from:
        index % 4 === 0
          ? { kind: 'user', userId: 'owner-proof' }
          : { kind: 'agent', catId: cats[index % cats.length].id },
      id: `piano-${n}`,
      catId: index % 4 === 0 ? null : cats[index % cats.length].id,
      timestamp: 1791500000000 + index * 1000,
      origin: 'callback',
      content,
      extra: { isExplicitPost: true, stream: { turnInvocationId: `piano-turn-${n}` } },
    };
  });
}

export async function openPianoPage(
  browser,
  built,
  {
    count = 24,
    pane = 900,
    compact = false,
    presentation = 'v2',
    base = 'light',
    partial = false,
    lateImage = false,
  } = {},
) {
  const context = await browser.newContext({ viewport: { width: pane === 320 ? 320 : 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const api = createChatProofApi(Date.now(), false, true);
  const records = pianoRecords(count),
    reads = [],
    errors = [],
    unexpected = [],
    responses = [];
  let releaseImage;
  const imageGate = new Promise((resolve) => {
    releaseImage = resolve;
  });
  if (lateImage) records.at(-2).content += '\n\n![晚加载图片](/late-image.svg)';
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => responses.push({ url: response.url(), status: response.status() }));
  await page.addInitScript((mode) => localStorage.setItem('cat-cafe:shell-presentation', mode), presentation);
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(request.url());
      return route.abort();
    }
    if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: built.script });
    if (url.pathname === '/proof.css') return route.fulfill({ contentType: 'text/css', body: built.css });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
    if (url.pathname === '/late-image.svg') {
      await imageGate;
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#709d88"/></svg>',
      });
    }
    if (url.pathname === '/api/messages' && request.method() === 'GET') {
      reads.push({ threadId: url.searchParams.get('threadId'), before: url.searchParams.get('before') });
      const other = url.searchParams.get('threadId') !== CURRENT_THREAD;
      const before = url.searchParams.has('before');
      const messages = other
        ? [{ ...records[0], id: 'other-message' }]
        : partial
          ? before
            ? records.slice(0, -16)
            : records.slice(-16)
          : records;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ messages, hasMore: !other && partial && !before }),
      });
    }
    if (url.pathname === '/api/routing/preview' && request.method() === 'POST') {
      const body = request.postDataJSON();
      assert.equal(body.scope, 'thread');
      assert.equal(typeof body.content, 'string');
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ targetCats: [cats[0].id], reason: { kind: 'recent_replier' } }),
      });
    }
    if (
      request.method() === 'GET' &&
      [CURRENT_THREAD, BUSY_THREAD].some((threadId) => url.pathname === `/api/threads/${threadId}/queue`)
    ) {
      // This ruler fixture has exactly the supplied history, with no pending
      // input. The shared single-cat scenario owns its separate queued record.
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ queue: [], activeInvocations: [] }),
      });
    }
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname.endsWith('/composer-draft') && !url.pathname.includes(CURRENT_THREAD))
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ draft: null, revision: 0 }) });
      const response = api.respond(request, url);
      if (response) return route.fulfill(response);
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    if (url.pathname.startsWith('/avatars/')) {
      const file = path.resolve(webRoot, 'public', url.pathname.slice(1));
      if (file.startsWith(path.join(webRoot, 'public/avatars/')) && existsSync(file))
        return route.fulfill({ contentType: 'image/png', body: readFileSync(file) });
      unexpected.push(url.pathname);
      return route.abort();
    }
    if (!url.pathname.startsWith('/thread/')) {
      unexpected.push(url.pathname);
      return route.abort();
    }
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
    });
  });
  try {
    await page.goto(`${origin}/thread/${CURRENT_THREAD}?pane=${pane}&compact=${compact ? 1 : 0}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction((draft) => document.querySelector('textarea')?.value === draft, DRAFT);
    await page.getByRole('button', { name: base === 'light' ? 'Light' : 'Dark', exact: true }).click();
    await page.locator('[data-chat-container]').waitFor();
    await page.waitForFunction(() => {
      const chat = document.querySelector('[data-chat-container]');
      return (
        chat && chat.scrollHeight > chat.clientHeight && chat.scrollHeight - chat.clientHeight - chat.scrollTop <= 1
      );
    });
    return { page, context, api, records, reads, errors, unexpected, responses, releaseImage };
  } catch (error) {
    releaseImage();
    await context.close();
    throw error;
  }
}

export async function closePianoPage(proof) {
  proof.releaseImage();
  await proof.context.close();
  assert.deepEqual(proof.errors, []);
  assert.deepEqual(proof.unexpected, []);
  assert.ok(proof.responses.some((response) => response.url.endsWith('/proof.css') && response.status === 200));
  assert.equal(proof.api.sent.length, 0, 'navigation never sends a message');
}
