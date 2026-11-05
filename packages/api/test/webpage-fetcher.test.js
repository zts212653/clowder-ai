import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchInChildProcess, startLocalHttpServer } from './helpers/signal-fetcher-child-fixture.js';

const webpageFetcherModuleUrl = new URL('../dist/domains/signals/fetchers/webpage-fetcher.js', import.meta.url).href;
const { WebpageFetcher } = await import(webpageFetcherModuleUrl);

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
      timeoutMs: 5000,
    },
    schedule: {
      frequency: 'daily',
    },
    ...overrides,
  };
}

function createHtmlResponse(payload) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    async text() {
      return payload;
    },
  };
}

describe('WebpageFetcher', () => {
  it('canHandle returns true only for webpage sources', () => {
    const fetcher = new WebpageFetcher(async () => createHtmlResponse('<html></html>'));

    assert.equal(fetcher.canHandle(createSource()), true);
    assert.equal(fetcher.canHandle(createSource({ fetch: { method: 'api' } })), false);
  });

  it('fetch extracts article nodes by selector and resolves relative links', async () => {
    const html = `
      <html>
        <body>
          <article class="news-item">
            <h2>Claude 5 roadmap</h2>
            <a href="/news/claude-5-roadmap">Read more</a>
            <p>Roadmap update</p>
            <time datetime="2026-02-18T08:00:00.000Z"></time>
          </article>
        </body>
      </html>
    `;
    const fetcher = new WebpageFetcher(async () => createHtmlResponse(html));

    const result = await fetcher.fetch(createSource());

    assert.equal(result.errors.length, 0);
    assert.equal(result.articles.length, 1);
    assert.equal(result.articles[0].title, 'Claude 5 roadmap');
    assert.equal(result.articles[0].url, 'https://www.anthropic.com/news/claude-5-roadmap');
    assert.equal(result.articles[0].summary, 'Roadmap update');
    assert.equal(result.articles[0].publishedAt, '2026-02-18T08:00:00.000Z');
  });

  it('fetch returns structured error when selector is missing', async () => {
    const fetcher = new WebpageFetcher(async () => createHtmlResponse('<html></html>'));

    const result = await fetcher.fetch(createSource({ fetch: { method: 'webpage' } }));

    assert.equal(result.articles.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'WEBPAGE_FETCH_FAILED');
    assert.match(result.errors[0].message, /selector/i);
  });

  it('fetch returns structured error when downstream fetch throws', async () => {
    const fetcher = new WebpageFetcher(async () => {
      throw new Error('connection reset');
    });

    const result = await fetcher.fetch(createSource());

    assert.equal(result.articles.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'WEBPAGE_FETCH_FAILED');
    assert.match(result.errors[0].message, /connection reset/);
  });

  it('fetch rejects non-webpage source with clear error payload', async () => {
    const fetcher = new WebpageFetcher(async () => createHtmlResponse('<html></html>'));

    const result = await fetcher.fetch(createSource({ fetch: { method: 'rss' } }));

    assert.equal(result.articles.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'UNSUPPORTED_SOURCE');
  });

  it('releases the connection when the listing page answers an error status with a body that never ends', async (t) => {
    const server = await startLocalHttpServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/html' });
      res.write('<html><body>busy');
    });
    t.after(() => server.close());

    const run = await fetchInChildProcess({
      moduleUrl: webpageFetcherModuleUrl,
      exportName: 'WebpageFetcher',
      source: createSource({ id: 'busy-page', url: `${server.origin}/news` }),
    });

    assert.equal(run.exitedOnItsOwn, true, `unread error body kept the process alive; stderr=${run.stderr}`);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.result.errors[0].code, 'WEBPAGE_FETCH_FAILED');
    assert.match(run.result.errors[0].message, /HTTP 503/);
  });

  it('releases article-page connections that answer an error status with a body that never ends', async (t) => {
    // Secondary article fetches share the listing request's signal; a non-2xx article
    // page used to be dropped without reading or cancelling its body.
    const server = await startLocalHttpServer((req, res) => {
      if (req.url === '/news') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><a href="/posts/hello"><h3>Hello post</h3></a></body></html>');
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.write('<html><body>not here');
    });
    t.after(() => server.close());

    const run = await fetchInChildProcess({
      moduleUrl: webpageFetcherModuleUrl,
      exportName: 'WebpageFetcher',
      source: createSource({
        id: 'article-pages',
        url: `${server.origin}/news`,
        fetch: { method: 'webpage', selector: 'a[href*="/posts/"]', timeoutMs: 5000 },
      }),
    });

    assert.equal(run.exitedOnItsOwn, true, `unread article body kept the process alive; stderr=${run.stderr}`);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.result.articles, 1);
    assert.deepEqual(run.result.errors, []);
  });
});
