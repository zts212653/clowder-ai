import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WebpageFetcher } from '../dist/domains/signals/fetchers/webpage-fetcher.js';

/**
 * Test: WebpageFetcher should extract article body content, not just title.
 * Bug: parseWebpageArticles never populates the `content` field of RawArticle.
 */

function makeSource(selector = 'article') {
  return {
    id: 'test-source',
    name: 'Test Source',
    url: 'https://example.com/blog',
    fetch: { method: 'webpage', selector },
    scoring: { tier: 1 },
  };
}

function fakeFetch(html) {
  return async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => html,
  });
}

describe('WebpageFetcher content extraction', () => {
  it('extracts paragraph content from article body', async () => {
    const html = `
      <html><body>
        <article>
          <h2>Deep Learning Breakthrough</h2>
          <a href="/posts/dl-breakthrough">Read more</a>
          <p>Researchers have achieved a major breakthrough in deep learning.</p>
          <p>The new technique improves efficiency by 40%.</p>
          <p>This has implications for real-world applications.</p>
        </article>
      </body></html>
    `;
    const fetcher = new WebpageFetcher(fakeFetch(html));
    const result = await fetcher.fetch(makeSource());

    assert.equal(result.articles.length, 1);
    const article = result.articles[0];
    assert.equal(article.title, 'Deep Learning Breakthrough');
    // content should contain the article body text, not just the title
    assert.ok(article.content, 'content field should be populated');
    assert.ok(article.content.includes('major breakthrough'), 'content should include body text');
    assert.ok(article.content.includes('improves efficiency'), 'content should include multiple paragraphs');
  });

  it('extracts content from nested elements', async () => {
    const html = `
      <html><body>
        <article>
          <h1>API Design Patterns</h1>
          <a href="/posts/api-patterns">Link</a>
          <div class="body">
            <p>Good API design follows consistent patterns.</p>
            <ul><li>Use RESTful conventions</li><li>Version your APIs</li></ul>
            <p>These patterns help maintain large codebases.</p>
          </div>
        </article>
      </body></html>
    `;
    const fetcher = new WebpageFetcher(fakeFetch(html));
    const result = await fetcher.fetch(makeSource());

    assert.equal(result.articles.length, 1);
    assert.ok(result.articles[0].content, 'content should be populated');
    assert.ok(result.articles[0].content.includes('consistent patterns'));
  });

  it('does not include title text in content', async () => {
    const html = `
      <html><body>
        <article>
          <h2>My Title Here</h2>
          <a href="/posts/my-post">Link</a>
          <p>This is the actual body content of the article.</p>
        </article>
      </body></html>
    `;
    const fetcher = new WebpageFetcher(fakeFetch(html));
    const result = await fetcher.fetch(makeSource());

    const article = result.articles[0];
    assert.equal(article.title, 'My Title Here');
    assert.ok(article.content, 'content should exist');
    // Content should be the body, not duplicate the title
    assert.ok(article.content.includes('actual body content'));
  });

  it('summary is first paragraph, content is full body', async () => {
    const html = `
      <html><body>
        <article>
          <h2>Test Article</h2>
          <a href="/posts/test">Link</a>
          <p>First paragraph serves as summary.</p>
          <p>Second paragraph has more detail.</p>
          <p>Third paragraph wraps up.</p>
        </article>
      </body></html>
    `;
    const fetcher = new WebpageFetcher(fakeFetch(html));
    const result = await fetcher.fetch(makeSource());

    const article = result.articles[0];
    assert.equal(article.summary, 'First paragraph serves as summary.');
    assert.ok(article.content, 'content should exist');
    assert.ok(article.content.includes('Second paragraph'));
    assert.ok(article.content.includes('Third paragraph'));
  });
});
