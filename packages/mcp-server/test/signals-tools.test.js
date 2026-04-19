import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('MCP Signal Tools', () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3004';
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  test('handleSignalListInbox forwards query params and formats response', async () => {
    const { handleSignalListInbox } = await import('../dist/tools/signals-tools.js');

    let capturedUrl;
    let capturedInit;
    globalThis.fetch = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              id: 'signal_1',
              title: 'Claude 5 roadmap',
              source: 'anthropic-news',
              tier: 1,
              fetchedAt: '2026-02-19T08:00:00.000Z',
            },
          ],
        }),
      };
    };

    const result = await handleSignalListInbox({
      limit: 5,
      source: 'anthropic-news',
      tier: '1',
    });

    assert.equal(result.isError, undefined);
    const parsed = new URL(String(capturedUrl));
    assert.equal(parsed.pathname, '/api/signals/inbox');
    assert.equal(parsed.searchParams.get('limit'), '5');
    assert.equal(parsed.searchParams.get('source'), 'anthropic-news');
    assert.equal(parsed.searchParams.get('tier'), '1');

    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get('x-cat-cafe-user'), 'codex');
    assert.match(result.content[0].text, /Claude 5 roadmap/);
  });

  test('handleSignalGetArticle resolves by URL endpoint', async () => {
    const { handleSignalGetArticle } = await import('../dist/tools/signals-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({
          article: {
            id: 'signal_1',
            title: 'Claude 5 roadmap',
            source: 'anthropic-news',
            tier: 1,
            status: 'inbox',
            summary: 'Roadmap summary',
            content: 'Full article content',
            fetchedAt: '2026-02-19T08:00:00.000Z',
            publishedAt: '2026-02-19T07:00:00.000Z',
            tags: [],
            url: 'https://www.anthropic.com/news/claude-5-roadmap',
            filePath: '/tmp/signal.md',
          },
        }),
      };
    };

    const result = await handleSignalGetArticle({
      url: 'https://www.anthropic.com/news/claude-5-roadmap',
    });

    assert.equal(result.isError, undefined);
    const parsed = new URL(String(capturedUrl));
    assert.equal(parsed.pathname, '/api/signals/articles/by-url');
    assert.equal(parsed.searchParams.get('url'), 'https://www.anthropic.com/news/claude-5-roadmap');
    assert.match(result.content[0].text, /Full article content/);
  });

  test('handleSignalSearch forwards status filter to API query', async () => {
    const { handleSignalSearch } = await import('../dist/tools/signals-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({
          total: 1,
          items: [
            {
              id: 'signal_2',
              title: 'Claude 5 evals',
              source: 'anthropic-news',
              tier: 1,
              fetchedAt: '2026-02-19T09:00:00.000Z',
            },
          ],
        }),
      };
    };

    const result = await handleSignalSearch({
      query: 'claude',
      status: 'read',
      source: 'anthropic-news',
      tier: '1',
      limit: 10,
    });

    assert.equal(result.isError, undefined);
    const parsed = new URL(String(capturedUrl));
    assert.equal(parsed.pathname, '/api/signals/search');
    assert.equal(parsed.searchParams.get('q'), 'claude');
    assert.equal(parsed.searchParams.get('status'), 'read');
    assert.equal(parsed.searchParams.get('source'), 'anthropic-news');
    assert.equal(parsed.searchParams.get('tier'), '1');
    assert.equal(parsed.searchParams.get('limit'), '10');
  });

  // Bug-C: Gemini rejects numeric enum in tool schema (INVALID_ARGUMENT 400).
  // tier must be STRING enum for Gemini function declaration compatibility.
  test('tier schema accepts string values and handler produces correct URL params', async () => {
    const { handleSignalListInbox, handleSignalSearch } = await import('../dist/tools/signals-tools.js');

    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ items: [] }) };
    };

    // String tier "2" must be accepted and produce tier=2 in URL
    await handleSignalListInbox({ tier: '2' });
    assert.equal(new URL(urls[0]).searchParams.get('tier'), '2', 'inbox: string tier must produce tier=2');

    await handleSignalSearch({ query: 'test', tier: '3' });
    assert.equal(new URL(urls[1]).searchParams.get('tier'), '3', 'search: string tier must produce tier=3');
  });

  test('tier Zod schema rejects invalid values', async () => {
    const { signalListInboxInputSchema } = await import('../dist/tools/signals-tools.js');
    const { z } = await import('zod');
    const schema = z.object(signalListInboxInputSchema);

    // Valid string tiers
    assert.doesNotThrow(() => schema.parse({ tier: '1' }));
    assert.doesNotThrow(() => schema.parse({ tier: '4' }));
    assert.doesNotThrow(() => schema.parse({})); // optional

    // Invalid values
    assert.throws(() => schema.parse({ tier: '5' }));
    assert.throws(() => schema.parse({ tier: '0' }));
    assert.throws(() => schema.parse({ tier: 'high' }));
  });

  test('handleSignalSummarize reads article then PATCHes summary', async () => {
    const { handleSignalSummarize } = await import('../dist/tools/signals-tools.js');

    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });

      if (calls.length === 1) {
        return {
          ok: true,
          json: async () => ({
            article: {
              id: 'signal_1',
              title: 'Claude 5 roadmap',
              source: 'anthropic-news',
              tier: 1,
              status: 'inbox',
              content:
                'Claude 5 introduces better coding, safety, and tool-use capabilities across long-context tasks.',
              fetchedAt: '2026-02-19T08:00:00.000Z',
              publishedAt: '2026-02-19T07:00:00.000Z',
              tags: [],
              url: 'https://www.anthropic.com/news/claude-5-roadmap',
              filePath: '/tmp/signal.md',
            },
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({
          article: {
            id: 'signal_1',
            summary: 'Claude 5 introduces better coding, safety, and tool-use capabilities.',
          },
        }),
      };
    };

    const result = await handleSignalSummarize({ id: 'signal_1' });

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 2);

    const second = calls[1];
    assert.equal(new URL(second.url).pathname, '/api/signals/articles/signal_1');
    assert.equal(second.init?.method, 'PATCH');

    const payload = JSON.parse(String(second.init?.body));
    assert.equal(typeof payload.summary, 'string');
    assert.ok(payload.summary.length > 0);
    assert.match(result.content[0].text, /summary updated/i);
  });
});
