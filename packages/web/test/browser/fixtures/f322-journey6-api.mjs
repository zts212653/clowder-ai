import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { origin, webRoot } from './f322-chat-real-page-build.mjs';
import { CURRENT_THREAD, createChatProofApi, DRAFT } from './f322-chat-real-page-data.mjs';

// Only transport/data are fixtures. All searches stay local and every UI/reading/composer owner is production.
const payloadFile = process.env.F322_JOURNEY6_PAYLOAD;
const sourceThread = 'source-ledger-fixture';
const fact = {
  status: 'decided',
  conclusion: '侧栏对话标题不改成一行，最多两行',
  featureId: 'F322',
  documentPath: 'docs/features/F322-example.md',
  documentRevision: 'a'.repeat(40),
  line: 10,
  decidedBy: 'You',
  decidedAt: '10-08 07:04',
};
const records = [
  '标题最多两行，已经看过。',
  '侧栏对话标题要一行，还是保留原来的写法？',
  '我们这个不是定过？不要一行这种。',
].map((content, i) => ({
  id: `source-${i}`,
  threadId: sourceThread,
  catId: i === 1 ? 'codex61-sol' : null,
  from: i === 1 ? { kind: 'agent', catId: 'codex61-sol' } : { kind: 'user', userId: 'owner-proof' },
  content,
  timestamp: 1791443087800 + i * 1000,
}));
const fallback = {
  sourceThread,
  records,
  response: {
    searchId: 'one-existing-search',
    query: '一行',
    results: records.map((row, i) => ({
      threadId: sourceThread,
      messageId: row.id,
      speaker: row.catId || 'user',
      threadTitle: '界面设计 · 原讨论',
      timestamp: row.timestamp,
      timelineOrderAt: row.timestamp,
      snippet: { text: row.content, start: 0, end: row.content.length, source: 'body' },
      highlights: row.content.includes('一行')
        ? [{ start: row.content.indexOf('一行'), end: row.content.indexOf('一行') + 2 }]
        : [],
      match: 'lexical',
      contentRevision: 'controlled',
      publiclyQuotable: true,
      decisionSources: [{ ...fact, status: i === 1 ? 'not-adopted' : 'decided' }],
    })),
    meta: {
      scope: 'global',
      sort: 'time',
      requestedMode: 'hybrid',
      effectiveMode: 'hybrid',
      degraded: false,
      partial: false,
      hasMore: false,
      candidateLimit: 2000,
      semanticCandidatesLimited: false,
      sourceCoverage: 'unknown',
      freshness: 'unknown',
      decisionIndex: { status: 'ready', revision: fact.documentRevision },
      response: { budgetChars: 24000, serializedChars: 1000, truncated: false, continuation: 'unavailable' },
    },
  },
};
const payloadBytes = payloadFile ? readFileSync(payloadFile) : null;
export const data = payloadBytes ? JSON.parse(payloadBytes) : fallback;
export const payloadSha256 = payloadBytes ? createHash('sha256').update(payloadBytes).digest('hex') : null;

export async function openJourneyPage(browser, built, width = 1440, presentation = 'v2', dark = false) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const api = createChatProofApi(Date.now(), false, true);
  api.threads[0].title = '继续刚才的设计';
  api.threads.push({ ...api.threads[0], id: data.sourceThread, title: '界面设计 · 原讨论' });
  const requests = [],
    errors = [],
    unexpected = [],
    navigation = [];
  await page.addInitScript(
    ({ presentation, dark }) => {
      localStorage.setItem('cat-cafe:shell-presentation', presentation);
      localStorage.setItem('cat-cafe:shell-language', 'zh');
      localStorage.setItem(
        'cat-cafe:themes',
        JSON.stringify({
          version: '2026-06-10-dark-token-init',
          activeId: dark ? 'dark' : 'light',
          custom: [],
          builtInOverrides: {},
        }),
      );
    },
    { presentation, dark },
  );
  page.on('console', (message) => {
    if (message.text().startsWith('j6-')) navigation.push(message.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    requests.push({ method: request.method(), path: url.pathname, search: url.search });
    const reply = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== origin) {
      unexpected.push(request.url());
      return route.abort();
    }
    if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: built.script });
    if (url.pathname === '/proof.css') return route.fulfill({ contentType: 'text/css', body: built.css });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
    if (url.pathname === '/api/evidence/search') {
      assert.equal(url.searchParams.get('resultUnit'), 'message');
      return reply(data.response);
    }
    if (url.pathname === '/api/evidence/navigation-source') {
      const threadId = url.searchParams.get('threadId'),
        id = url.searchParams.get('messageId');
      if (!id) return reply({ status: 'available', target: { threadId }, updated: false });
      const result = data.response.results.find((row) => row.threadId === threadId && row.messageId === id);
      assert.ok(result, 'admit only the supplied collection');
      const count = Number(url.searchParams.get('contextCount') || 0);
      const source = data.sources?.[id];
      const record = data.records.find((row) => row.id === id);
      return reply(
        source
          ? { ...source, following: source.following.slice(0, count) }
          : {
              status: 'available',
              target: { threadId, messageId: id, contentRevision: result.contentRevision },
              updated: false,
              ...(url.searchParams.has('contextCount')
                ? {
                    message: {
                      threadId,
                      messageId: id,
                      content: record.content,
                      speaker: result.speaker,
                      timestamp: record.timestamp,
                      contentRevision: result.contentRevision,
                      truncated: false,
                    },
                    following: [],
                  }
                : {}),
            },
      );
    }
    if (url.pathname === '/api/workspace/chat-references' && request.method() === 'POST') {
      // Markdown originals use the existing read-only resolver as well. The
      // isolated fixture has no file tree; unresolved references remain null.
      const input = request.postDataJSON();
      assert.ok(Array.isArray(input.groups) && input.groups.length <= 8);
      return reply({
        groups: input.groups.map((group) => ({
          threadId: group.threadId,
          results: group.references.map((reference) => ({ reference, target: null })),
        })),
      });
    }
    if (url.pathname === '/api/messages' && request.method() === 'GET') {
      const remote = url.searchParams.get('threadId') === data.sourceThread;
      const fillers = Array.from({ length: 16 }, (_, i) => ({
        id: `latest-${i}`,
        catId: 'codex61-sol',
        from: { kind: 'agent', catId: 'codex61-sol' },
        content: `后来的第${i + 1}条讨论。${'原来的阅读位置与输入草稿要保留。'.repeat(6)}`,
        timestamp: 1793000000000 + i,
      }));
      return reply({
        messages: remote && url.searchParams.has('before') ? data.records : fillers,
        hasMore: remote && !url.searchParams.has('before'),
      });
    }
    if (url.pathname.endsWith('/composer-draft') && !url.pathname.includes(CURRENT_THREAD))
      return reply({ draft: null, revision: 0 });
    if (url.pathname === '/api/diagnostics/connection') return reply({ ok: true });
    if (url.pathname.endsWith('/queue')) return reply({ queue: [], activeInvocations: [] });
    if (url.pathname === `/api/threads/${data.sourceThread}`) return reply(api.threads.at(-1));
    if (url.pathname.startsWith('/api/')) {
      const response = api.respond(request, url);
      if (response) return route.fulfill(response);
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    if (url.pathname.startsWith('/avatars/')) {
      const file = path.resolve(webRoot, 'public', url.pathname.slice(1));
      if (file.startsWith(path.join(webRoot, 'public/avatars/')) && existsSync(file))
        return route.fulfill({ contentType: 'image/png', body: readFileSync(file) });
      return route.fulfill({ status: 204, body: '' });
    }
    // The original source images are outside this text/quote fixture's contract.
    if (url.pathname.startsWith('/uploads/')) return route.fulfill({ status: 204, body: '' });
    if (url.pathname.startsWith('/thread/'))
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
      });
    unexpected.push(url.pathname);
    return route.abort();
  });
  await page.goto(`${origin}/thread/${CURRENT_THREAD}`, { waitUntil: 'networkidle' });
  await page.waitForFunction((draft) => document.querySelector('textarea')?.value === draft, DRAFT);
  await page.locator('[data-chat-container]').waitFor();
  return { context, page, api, requests, errors, unexpected, navigation };
}
