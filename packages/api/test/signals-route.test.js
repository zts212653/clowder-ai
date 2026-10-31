import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { signalsRoutes } = await import('../dist/routes/signals.js');
const { ensureSignalWorkspace, resolveSignalPaths } = await import('../dist/domains/signals/config/sources-loader.js');
const { ArticleStoreService } = await import('../dist/domains/signals/services/article-store.js');

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user' };

function toIsoDay(value) {
  return value.toISOString().slice(0, 10);
}

function createSource(overrides = {}) {
  return {
    id: 'anthropic-news',
    name: 'Anthropic Newsroom',
    url: 'https://www.anthropic.com/news',
    tier: 1,
    category: 'official',
    enabled: true,
    fetch: {
      method: 'webpage',
      selector: 'article.news-item',
    },
    schedule: {
      frequency: 'daily',
    },
    ...overrides,
  };
}

function createRawArticle(overrides = {}) {
  return {
    url: 'https://www.anthropic.com/news/claude-5-roadmap',
    title: 'Claude 5 roadmap',
    publishedAt: new Date().toISOString(),
    summary: 'Roadmap update',
    content: 'Detailed announcement',
    ...overrides,
  };
}

describe('signals routes', () => {
  let app;
  let tempRoot;
  let prevSignalsRoot;
  let paths;
  let firstArticle;
  let secondArticle;
  let oldArticle;
  let today;

  beforeEach(async () => {
    tempRoot = mkdtempSync('/tmp/cat-cafe-signals-route-');
    prevSignalsRoot = process.env.SIGNALS_ROOT_DIR;
    process.env.SIGNALS_ROOT_DIR = tempRoot;

    paths = resolveSignalPaths();
    await ensureSignalWorkspace(paths);

    const store = new ArticleStoreService({ paths });
    const now = new Date();
    const old = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    today = toIsoDay(now);

    firstArticle = await store.store({
      source: createSource(),
      article: createRawArticle({
        url: 'https://www.anthropic.com/news/claude-5-roadmap',
        title: 'Claude 5 roadmap',
        publishedAt: now.toISOString(),
        content: 'Roadmap details and launch notes',
      }),
      fetchedAt: now.toISOString(),
      tags: ['roadmap'],
    });

    secondArticle = await store.store({
      source: createSource(),
      article: createRawArticle({
        url: 'https://www.anthropic.com/news/claude-5-evals',
        title: 'Claude 5 evals',
        publishedAt: now.toISOString(),
        summary: 'Evaluation methodology',
        content: 'Evals details',
      }),
      fetchedAt: now.toISOString(),
    });

    oldArticle = await store.store({
      source: createSource(),
      article: createRawArticle({
        url: 'https://www.anthropic.com/news/old-post',
        title: 'Old Anthropic post',
        publishedAt: old.toISOString(),
        content: 'Historical context',
      }),
      fetchedAt: old.toISOString(),
    });

    app = Fastify();
    await app.register(signalsRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();

    if (prevSignalsRoot === undefined) {
      delete process.env.SIGNALS_ROOT_DIR;
    } else {
      process.env.SIGNALS_ROOT_DIR = prevSignalsRoot;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns 401 when identity is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/signals/inbox',
    });

    assert.equal(res.statusCode, 401);
  });

  it('GET /api/signals/inbox trusts localhost origin fallback', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/signals/inbox?limit=10',
      headers: { origin: 'http://localhost:3003' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(Array.isArray(body.items), true);
    assert.equal(body.items.length, 3);
  });

  it('GET /api/signals/inbox returns today inbox items', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/signals/inbox?date=${encodeURIComponent(today)}&limit=10`,
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(Array.isArray(body.items), true);
    assert.equal(body.items.length, 2);
    assert.equal(body.items[0].status, 'inbox');
    assert.equal(body.items[1].status, 'inbox');
    assert.ok(body.items.every((item) => item.source === 'anthropic-news'));
  });

  it('GET /api/signals/inbox without date includes unread items from previous days', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/signals/inbox?limit=10',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(Array.isArray(body.items), true);
    assert.equal(body.items.length, 3);
    const ids = body.items.map((item) => item.id);
    assert.ok(ids.includes(firstArticle.id));
    assert.ok(ids.includes(secondArticle.id));
    assert.ok(ids.includes(oldArticle.id));
  });

  it('GET /api/signals/articles/:id returns article detail with content', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/signals/articles/${encodeURIComponent(firstArticle.id)}`,
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.article.id, firstArticle.id);
    assert.match(body.article.content, /Roadmap details/);
  });

  it('GET /api/signals/search filters by query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/signals/search?q=evals',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.total, 1);
    assert.equal(body.items[0].id, secondArticle.id);
  });

  it('GET /api/signals/search matches query against article tags', async () => {
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/signals/articles/${encodeURIComponent(secondArticle.id)}`,
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      payload: {
        tags: ['nightly-triage'],
      },
    });
    assert.equal(patchRes.statusCode, 200);

    const res = await app.inject({
      method: 'GET',
      url: '/api/signals/search?q=nightly-triage',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.total, 1);
    assert.equal(body.items[0].id, secondArticle.id);
  });

  it('GET /api/signals/articles/by-url matches normalized url variants', async () => {
    const withTrailingSlash = `${secondArticle.url}/`;
    const res = await app.inject({
      method: 'GET',
      url: `/api/signals/articles/by-url?url=${encodeURIComponent(withTrailingSlash)}`,
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.article.id, secondArticle.id);
  });

  it('GET /api/signals/search ignores invalid dateFrom instead of filtering everything', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/signals/search?q=claude&dateFrom=not-a-date',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.total, 2);
    const ids = body.items.map((item) => item.id);
    assert.ok(ids.includes(firstArticle.id));
    assert.ok(ids.includes(secondArticle.id));
  });

  it('GET /api/signals/search filters by status when requested', async () => {
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/signals/articles/${encodeURIComponent(secondArticle.id)}`,
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      payload: {
        status: 'read',
      },
    });
    assert.equal(patchRes.statusCode, 200);

    const res = await app.inject({
      method: 'GET',
      url: '/api/signals/search?q=claude&status=read',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.total, 1);
    assert.equal(body.items[0].id, secondArticle.id);
    assert.equal(body.items[0].status, 'read');
  });

  it('GET /api/signals/search keeps dateTo day inclusive', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/signals/search?q=claude&dateTo=${encodeURIComponent(today)}`,
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.total, 2);
    const ids = body.items.map((item) => item.id);
    assert.ok(ids.includes(firstArticle.id));
    assert.ok(ids.includes(secondArticle.id));
  });

  it('PATCH /api/signals/articles/:id updates status/tags/summary', async () => {
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/signals/articles/${encodeURIComponent(firstArticle.id)}`,
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      payload: {
        status: 'read',
        tags: ['priority', 'ml'],
        summary: 'Human-verified summary',
      },
    });

    assert.equal(patchRes.statusCode, 200);
    const patched = patchRes.json();
    assert.equal(patched.article.status, 'read');
    assert.deepEqual(patched.article.tags, ['priority', 'ml']);
    assert.equal(patched.article.summary, 'Human-verified summary');

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/signals/articles/${encodeURIComponent(firstArticle.id)}`,
      headers: AUTH_HEADERS,
    });
    const fetched = getRes.json();
    assert.equal(fetched.article.status, 'read');
    assert.deepEqual(fetched.article.tags, ['priority', 'ml']);

    const clearSummaryRes = await app.inject({
      method: 'PATCH',
      url: `/api/signals/articles/${encodeURIComponent(firstArticle.id)}`,
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      payload: {
        summary: '',
      },
    });

    assert.equal(clearSummaryRes.statusCode, 200);
    const cleared = clearSummaryRes.json();
    assert.equal(cleared.article.summary, undefined);

    const getAfterClearRes = await app.inject({
      method: 'GET',
      url: `/api/signals/articles/${encodeURIComponent(firstArticle.id)}`,
      headers: AUTH_HEADERS,
    });
    assert.equal(getAfterClearRes.statusCode, 200);
    const afterClear = getAfterClearRes.json();
    assert.equal(afterClear.article.summary, undefined);
  });

  it('GET/PATCH /api/signals/sources lists and toggles source enabled', async () => {
    const listBefore = await app.inject({
      method: 'GET',
      url: '/api/signals/sources',
      headers: AUTH_HEADERS,
    });
    assert.equal(listBefore.statusCode, 200);
    const beforeBody = listBefore.json();
    assert.ok(beforeBody.sources.length >= 1);
    const target = beforeBody.sources.find((source) => source.id === 'anthropic-news');
    assert.ok(target);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/signals/sources/anthropic-news',
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      payload: {
        enabled: false,
      },
    });

    assert.equal(patchRes.statusCode, 200);
    assert.equal(patchRes.json().source.enabled, false);

    const listAfter = await app.inject({
      method: 'GET',
      url: '/api/signals/sources',
      headers: AUTH_HEADERS,
    });
    const afterBody = listAfter.json();
    const updated = afterBody.sources.find((source) => source.id === 'anthropic-news');
    assert.equal(updated.enabled, false);
  });

  it('PATCH /api/signals/sources/:id preserves both updates under concurrent toggles', async () => {
    const headers = {
      ...AUTH_HEADERS,
      'content-type': 'application/json',
    };

    const [firstRes, secondRes] = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: '/api/signals/sources/anthropic-news',
        headers,
        payload: { enabled: false },
      }),
      app.inject({
        method: 'PATCH',
        url: '/api/signals/sources/openai-news-rss',
        headers,
        payload: { enabled: false },
      }),
    ]);

    assert.equal(firstRes.statusCode, 200);
    assert.equal(secondRes.statusCode, 200);

    const listAfter = await app.inject({
      method: 'GET',
      url: '/api/signals/sources',
      headers: AUTH_HEADERS,
    });
    assert.equal(listAfter.statusCode, 200);

    const afterBody = listAfter.json();
    const anthropic = afterBody.sources.find((source) => source.id === 'anthropic-news');
    const openai = afterBody.sources.find((source) => source.id === 'openai-news-rss');

    assert.ok(anthropic);
    assert.ok(openai);
    assert.equal(anthropic.enabled, false);
    assert.equal(openai.enabled, false);
  });

  it('GET /api/signals/stats returns today/week/unread counters', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/signals/stats',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.todayCount >= 2);
    assert.ok(body.weekCount >= 3);
    assert.ok(body.unreadCount >= 3);
    assert.equal(typeof body.byTier, 'object');
    assert.equal(typeof body.bySource, 'object');
    assert.ok(body.bySource['anthropic-news'] >= 3);
    assert.ok(body.byTier['1'] >= 3);

    // keep oldArticle referenced so fixture intent is explicit
    assert.equal(typeof oldArticle.id, 'string');
  });

  it('skips malformed article files instead of failing inbox/search/stats', async () => {
    unlinkSync(secondArticle.filePath);

    const inboxRes = await app.inject({
      method: 'GET',
      url: `/api/signals/inbox?date=${encodeURIComponent(today)}&limit=10`,
      headers: AUTH_HEADERS,
    });
    assert.equal(inboxRes.statusCode, 200);
    const inboxBody = inboxRes.json();
    const inboxIds = inboxBody.items.map((item) => item.id);
    assert.ok(inboxIds.includes(firstArticle.id));
    assert.ok(!inboxIds.includes(secondArticle.id));

    const searchRes = await app.inject({
      method: 'GET',
      url: '/api/signals/search?q=claude',
      headers: AUTH_HEADERS,
    });
    assert.equal(searchRes.statusCode, 200);
    const searchBody = searchRes.json();
    const searchIds = searchBody.items.map((item) => item.id);
    assert.ok(searchIds.includes(firstArticle.id));
    assert.ok(!searchIds.includes(secondArticle.id));

    const statsRes = await app.inject({
      method: 'GET',
      url: '/api/signals/stats',
      headers: AUTH_HEADERS,
    });
    assert.equal(statsRes.statusCode, 200);
    const statsBody = statsRes.json();
    assert.ok(statsBody.todayCount >= 1);
    assert.ok(statsBody.weekCount >= 2);
  });

  it('POST /api/signals/sources/:id/fetch returns 401 without identity', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/signals/sources/anthropic-news/fetch',
    });
    assert.equal(res.statusCode, 401);
  });

  it('POST /api/signals/sources/:id/fetch returns 404 for nonexistent source', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/signals/sources/does-not-exist/fetch',
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 404);
    assert.match(res.json().error, /not found/i);
  });

  it('POST /api/signals/sources/:id/fetch returns summary shape for valid source', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/signals/sources/anthropic-news/fetch',
      headers: AUTH_HEADERS,
    });

    // Fetch may succeed (200) or fail with network error (502),
    // but the response must always include a summary object.
    assert.ok([200, 502].includes(res.statusCode), `unexpected status: ${res.statusCode}`);
    const body = res.json();
    assert.ok(body.summary, 'response must include summary');
    assert.equal(typeof body.summary.fetchedArticles, 'number');
    assert.equal(typeof body.summary.newArticles, 'number');
    assert.equal(typeof body.summary.storedArticles, 'number');
    assert.equal(typeof body.summary.duplicateArticles, 'number');
    assert.ok(Array.isArray(body.summary.errors));
  });

  it('returns 404 (not 500) for detail/by-url/update when article file is missing', async () => {
    unlinkSync(secondArticle.filePath);

    const byIdRes = await app.inject({
      method: 'GET',
      url: `/api/signals/articles/${encodeURIComponent(secondArticle.id)}`,
      headers: AUTH_HEADERS,
    });
    assert.equal(byIdRes.statusCode, 404);

    const byUrlRes = await app.inject({
      method: 'GET',
      url: `/api/signals/articles/by-url?url=${encodeURIComponent(secondArticle.url)}`,
      headers: AUTH_HEADERS,
    });
    assert.equal(byUrlRes.statusCode, 404);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/signals/articles/${encodeURIComponent(secondArticle.id)}`,
      headers: {
        ...AUTH_HEADERS,
        'content-type': 'application/json',
      },
      payload: {
        status: 'read',
      },
    });
    assert.equal(patchRes.statusCode, 404);
  });
});
