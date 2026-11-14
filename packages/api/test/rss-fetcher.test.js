import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchInChildProcess, startLocalHttpServer } from './helpers/signal-fetcher-child-fixture.js';

const rssFetcherModuleUrl = new URL('../dist/domains/signals/fetchers/rss-fetcher.js', import.meta.url).href;
const { RssFetcher } = await import(rssFetcherModuleUrl);

function createSource(overrides = {}) {
  return {
    id: 'openai-news-rss',
    name: 'OpenAI News RSS',
    url: 'https://openai.com/news/rss.xml',
    tier: 1,
    category: 'official',
    enabled: true,
    fetch: {
      method: 'rss',
    },
    schedule: {
      frequency: 'daily',
    },
    ...overrides,
  };
}

function okResponse(body = '') {
  return { ok: true, status: 200, statusText: 'OK', text: async () => body };
}

function respondWith(body = '') {
  return async () => okResponse(body);
}

function stubParser(feed) {
  return { parseString: async () => feed };
}

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Example</title>
<item><title>Hello feed</title><link>https://example.com/posts/hello</link><pubDate>Wed, 04 Nov 2026 10:00:00 GMT</pubDate><description>First post</description></item>
</channel></rss>`;

describe('RssFetcher', () => {
  it('canHandle returns true only for rss sources', () => {
    const fetcher = new RssFetcher(respondWith(), stubParser({ items: [] }));

    assert.equal(fetcher.canHandle(createSource()), true);
    assert.equal(fetcher.canHandle(createSource({ fetch: { method: 'api' } })), false);
  });

  it('fetch maps RSS items to RawArticle and sets metadata', async () => {
    const fetcher = new RssFetcher(
      respondWith('<rss/>'),
      stubParser({
        items: [
          {
            title: 'GPT-6 announcement',
            link: 'https://openai.com/index/gpt-6',
            pubDate: '2026-02-18T08:00:00.000Z',
            contentSnippet: 'A major model release.',
            content: '<p>A major model release.</p>',
          },
        ],
      }),
    );

    const result = await fetcher.fetch(createSource());

    assert.equal(result.errors.length, 0);
    assert.equal(result.articles.length, 1);
    assert.equal(result.articles[0].title, 'GPT-6 announcement');
    assert.equal(result.articles[0].url, 'https://openai.com/index/gpt-6');
    assert.equal(result.metadata.source, 'openai-news-rss');
    assert.equal(typeof result.metadata.duration, 'number');
  });

  it('falls back to guid when link is blank after trim', async () => {
    const fetcher = new RssFetcher(
      respondWith('<rss/>'),
      stubParser({
        items: [
          {
            title: 'Model card update',
            link: '   ',
            guid: 'https://openai.com/index/model-card',
            pubDate: '2026-02-18T08:00:00.000Z',
          },
        ],
      }),
    );

    const result = await fetcher.fetch(createSource());

    assert.equal(result.errors.length, 0);
    assert.equal(result.articles.length, 1);
    assert.equal(result.articles[0].url, 'https://openai.com/index/model-card');
  });

  it('drops item when fallback guid is not a valid URL', async () => {
    const fetcher = new RssFetcher(
      respondWith('<rss/>'),
      stubParser({
        items: [
          {
            title: 'Opaque guid item',
            link: '   ',
            guid: 'tag:example.com,2026:news-42',
            pubDate: '2026-02-18T08:00:00.000Z',
          },
        ],
      }),
    );

    const result = await fetcher.fetch(createSource());

    assert.equal(result.errors.length, 0);
    assert.equal(result.articles.length, 0);
  });

  it('fetch returns structured error when parser throws', async () => {
    const fetcher = new RssFetcher(respondWith('<html>Tom & Jerry</html>'), {
      parseString: async () => {
        throw new Error('Invalid character in entity name');
      },
    });

    const result = await fetcher.fetch(createSource());

    assert.equal(result.articles.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'RSS_FETCH_FAILED');
    assert.match(result.errors[0].message, /Invalid character in entity name/);
  });

  it('fetch rejects non-rss source with clear error payload', async () => {
    const fetcher = new RssFetcher(respondWith(), stubParser({ items: [] }));

    const result = await fetcher.fetch(createSource({ fetch: { method: 'api' } }));

    assert.equal(result.articles.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'UNSUPPORTED_SOURCE');
  });

  it('parses a real RSS document fetched with an abort signal and the rss-parser default headers', async () => {
    const calls = [];
    const fetcher = new RssFetcher(async (url, init) => {
      calls.push({ url, init });
      return okResponse(SAMPLE_RSS);
    });

    const result = await fetcher.fetch(createSource());

    assert.equal(result.errors.length, 0);
    assert.equal(result.articles.length, 1);
    assert.equal(result.articles[0].title, 'Hello feed');
    assert.equal(result.articles[0].url, 'https://example.com/posts/hello');
    assert.equal(result.articles[0].publishedAt, '2026-11-04T10:00:00.000Z');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://openai.com/news/rss.xml');
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    assert.equal(calls[0].init.headers['User-Agent'], 'rss-parser');
    assert.equal(calls[0].init.headers.Accept, 'application/rss+xml');
  });

  it('lets source headers override the default request headers', async () => {
    let seenHeaders;
    const fetcher = new RssFetcher(async (_url, init) => {
      seenHeaders = init.headers;
      return okResponse(SAMPLE_RSS);
    });

    await fetcher.fetch(createSource({ fetch: { method: 'rss', headers: { 'User-Agent': 'clowder-test' } } }));

    assert.equal(seenHeaders['User-Agent'], 'clowder-test');
    assert.equal(seenHeaders.Accept, 'application/rss+xml');
  });

  it('reports non-2xx responses with the HTTP status', async () => {
    const fetcher = new RssFetcher(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => '',
    }));

    const result = await fetcher.fetch(createSource());

    assert.equal(result.articles.length, 0);
    assert.equal(result.errors[0].code, 'RSS_FETCH_FAILED');
    assert.match(result.errors[0].message, /HTTP 404 Not Found/);
  });

  it('aborts a stalled feed after source.fetch.timeoutMs', async () => {
    const fetcher = new RssFetcher(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
          });
        }),
    );

    const startedAt = Date.now();
    const result = await fetcher.fetch(createSource({ fetch: { method: 'rss', timeoutMs: 30 } }));

    assert.ok(Date.now() - startedAt < 2000, 'stalled feed should be cut off by the timeout');
    assert.equal(result.errors[0].code, 'RSS_FETCH_FAILED');
    assert.match(result.errors[0].message, /timed out after 30ms/);
  });

  it('lets the process exit on its own after a redirected feed fails to parse', async (t) => {
    // Regression: rss-parser's own parseURL never read redirect responses, so their
    // keep-alive sockets held a one-shot fetch-signals run open for ~10 minutes.
    const server = await startLocalHttpServer((req, res) => {
      if (req.url === '/rss/') {
        res.writeHead(301, { Location: '/blog' });
        res.end('Moved Permanently');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body>Tom & Jerry</body></html>');
    });
    t.after(() => server.close());

    const run = await fetchInChildProcess({
      moduleUrl: rssFetcherModuleUrl,
      exportName: 'RssFetcher',
      source: createSource({ id: 'redirected-feed', url: `${server.origin}/rss/` }),
    });

    assert.equal(
      run.exitedOnItsOwn,
      true,
      `fetcher process stayed alive after the request finished; stderr=${run.stderr}`,
    );
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(
      run.result.errors.map((error) => error.code),
      ['RSS_FETCH_FAILED'],
    );
  });

  it('releases the connection when the feed answers an error status with a body that never ends', async (t) => {
    const server = await startLocalHttpServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.write('upstream busy');
    });
    t.after(() => server.close());

    const run = await fetchInChildProcess({
      moduleUrl: rssFetcherModuleUrl,
      exportName: 'RssFetcher',
      source: createSource({ id: 'busy-feed', url: `${server.origin}/rss.xml` }),
    });

    assert.equal(run.exitedOnItsOwn, true, `unread error body kept the process alive; stderr=${run.stderr}`);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.result.errors[0].code, 'RSS_FETCH_FAILED');
    assert.match(run.result.errors[0].message, /HTTP 503/);
  });

  it('times out a body that stalls after a 200 response and still lets the process exit', async (t) => {
    const server = await startLocalHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.write('<?xml version="1.0"?><rss version="2.0"><channel>');
    });
    t.after(() => server.close());

    const run = await fetchInChildProcess({
      moduleUrl: rssFetcherModuleUrl,
      exportName: 'RssFetcher',
      source: createSource({
        id: 'stalled-feed',
        url: `${server.origin}/rss.xml`,
        fetch: { method: 'rss', timeoutMs: 300 },
      }),
    });

    assert.equal(run.exitedOnItsOwn, true, `stalled body kept the process alive; stderr=${run.stderr}`);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.result.errors[0].message, /timed out after 300ms/);
  });
});
