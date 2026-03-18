import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WebpageFetcher } from '../dist/domains/signals/fetchers/webpage-fetcher.js';

/**
 * Test: WebpageFetcher secondary fetch — when listing page cards have no body
 * content, the fetcher should follow each article URL and extract the real
 * article body from the individual page.
 */

function makeSource(overrides = {}) {
  return {
    id: 'anthropic-engineering',
    name: 'Anthropic Engineering',
    url: 'https://www.anthropic.com/engineering',
    tier: 1,
    category: 'engineering',
    enabled: true,
    fetch: {
      method: 'webpage',
      selector: 'a[href*="/engineering/"]',
    },
    schedule: { frequency: 'manual' },
    ...overrides,
  };
}

// Listing page: cards with only title + link (no body content).
const LISTING_HTML = `
<html><body>
  <a href="/engineering/building-effective-agents">
    <h3>Building effective agents</h3>
  </a>
  <a href="/engineering/claude-code-best-practices">
    <h3>Claude Code: Best practices</h3>
  </a>
</body></html>
`;

// Individual article pages with real content.
const ARTICLE_PAGES = {
  'https://www.anthropic.com/engineering/building-effective-agents': `
    <html><body>
      <article>
        <h1>Building effective agents</h1>
        <p>Over the past year, we have worked with dozens of teams building agents.</p>
        <p>We found that the most successful implementations use simple patterns.</p>
      </article>
    </body></html>
  `,
  'https://www.anthropic.com/engineering/claude-code-best-practices': `
    <html><body>
      <article>
        <h1>Claude Code: Best practices</h1>
        <p>Claude Code is a CLI tool for agentic coding workflows.</p>
        <p>Here are the best practices we have learned from thousands of users.</p>
      </article>
    </body></html>
  `,
};

function createMultiPageFetch(listingHtml, articlePages) {
  const calls = [];
  return {
    fn: async (url) => {
      calls.push(url);
      const body = url.includes('/engineering') && !url.endsWith('/engineering') ? articlePages[url] : listingHtml;
      if (!body) throw new Error(`Unexpected fetch URL: ${url}`);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => body,
      };
    },
    calls,
  };
}

describe('WebpageFetcher secondary fetch', () => {
  it('fetches individual article pages when listing cards lack content', async () => {
    const { fn, calls } = createMultiPageFetch(LISTING_HTML, ARTICLE_PAGES);
    const fetcher = new WebpageFetcher(fn);
    const result = await fetcher.fetch(makeSource());

    assert.equal(result.errors.length, 0, `errors: ${JSON.stringify(result.errors)}`);
    assert.equal(result.articles.length, 2);

    // Should have fetched listing + 2 individual pages = 3 total
    assert.equal(calls.length, 3, `Expected 3 fetch calls, got: ${calls.join(', ')}`);

    const first = result.articles.find((a) => a.title === 'Building effective agents');
    assert.ok(first, 'should find "Building effective agents" article');
    assert.ok(first.content, 'first article should have content');
    assert.ok(first.content.includes('dozens of teams'), `content should include article body, got: ${first.content}`);

    const second = result.articles.find((a) => a.title.includes('Best practices'));
    assert.ok(second, 'should find "Claude Code: Best practices" article');
    assert.ok(second.content, 'second article should have content');
    assert.ok(second.content.includes('agentic coding'), `content should include article body, got: ${second.content}`);
  });

  it('preserves content already present in listing page cards', async () => {
    const richListingHtml = `
      <html><body>
        <article>
          <h2>Some Article</h2>
          <a href="/blog/some-article">Link</a>
          <p>This listing card already has body content.</p>
          <p>No need to fetch the individual page.</p>
        </article>
      </body></html>
    `;
    const calls = [];
    const fetcher = new WebpageFetcher(async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => richListingHtml,
      };
    });
    const source = makeSource({
      url: 'https://example.com/blog',
      fetch: { method: 'webpage', selector: 'article' },
    });
    const result = await fetcher.fetch(source);

    assert.equal(result.articles.length, 1);
    assert.ok(result.articles[0].content, 'content should exist from listing page');
    // Should NOT have made a secondary fetch (only the listing page fetch)
    assert.equal(calls.length, 1, 'should not secondary-fetch when content already present');
  });

  it('handles secondary fetch failure gracefully — article still returned without content', async () => {
    const fetcher = new WebpageFetcher(async (url) => {
      if (url.endsWith('/engineering')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => LISTING_HTML,
        };
      }
      // Simulate failure for individual pages
      return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '' };
    });
    const result = await fetcher.fetch(makeSource());

    // Articles should still be returned, just without content
    assert.equal(result.articles.length, 2);
    // Content might be undefined since secondary fetch failed
    // But articles themselves should not be lost
    assert.equal(result.articles[0].title, 'Building effective agents');
  });

  it('extracts content from <main> when <article> is absent', async () => {
    const articlePages = {
      'https://www.anthropic.com/engineering/test-article': `
        <html><body>
          <main>
            <h1>Test Article</h1>
            <p>Content inside main element.</p>
            <p>More paragraphs here.</p>
          </main>
        </body></html>
      `,
    };
    const listingHtml = `
      <html><body>
        <a href="/engineering/test-article"><h3>Test Article</h3></a>
      </body></html>
    `;
    const { fn } = createMultiPageFetch(listingHtml, articlePages);
    const fetcher = new WebpageFetcher(fn);
    const result = await fetcher.fetch(makeSource());

    assert.equal(result.articles.length, 1);
    assert.ok(result.articles[0].content, 'should extract content from <main>');
    assert.ok(result.articles[0].content.includes('main element'));
  });

  it('aborts secondary fetches when source timeout expires', async () => {
    let secondarySignal = null;
    const fetcher = new WebpageFetcher(async (url, options) => {
      if (url.endsWith('/engineering')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => LISTING_HTML,
        };
      }
      // Capture the signal passed to secondary fetch
      secondarySignal = options?.signal ?? null;
      // Simulate a slow response that would hang without signal
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '<html><body><article><p>Content</p></article></body></html>',
      };
    });
    const source = makeSource({ fetch: { method: 'webpage', selector: 'a[href*="/engineering/"]', timeoutMs: 5000 } });
    await fetcher.fetch(source);

    assert.ok(secondarySignal, 'secondary fetch should receive an AbortSignal');
    assert.ok(secondarySignal instanceof AbortSignal, 'should be an AbortSignal instance');
  });
});
